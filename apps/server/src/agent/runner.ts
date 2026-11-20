import { randomUUID } from 'node:crypto'
import {
  AgentWorkspace,
  type AgentProposal,
  type AgentToolName,
  type AgentWorkspaceOverlay,
  type EpubArchive,
} from '@booksmith/core'
import { stepCountIs, streamText, tool, type ModelMessage } from 'ai'
import { z } from 'zod'
import { nodeCheckXml, nodeXmlCodec } from './nodeXmlCodec'
import { classifyProviderError, createLanguageModel, type ResolvedProviderConfig } from './providers'
import { buildSystemPrompt, type AgentTurnContext } from './systemPrompt'

/**
 * Server-side multi-step Agent turn executor bridging Vercel AI SDK `streamText`
 * to `@booksmith/core`'s framework-agnostic `AgentWorkspace`.
 * See ADR 2026-11-20-builtin-epub-agent.
 */

export const MAX_TOOL_STEPS = 15
const HISTORY_CHAR_BUDGET = 24_000

export interface HistoryTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface ToolCallSummary {
  id: string
  name: AgentToolName
  argsSummary: string
  ok: boolean
  summary: string
}

export type AgentStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; id: string; name: AgentToolName; argsSummary: string }
  | { type: 'tool_end'; id: string; name: AgentToolName; ok: boolean; summary: string }
  | { type: 'proposal'; proposal: AgentProposal }
  | { type: 'done'; messageId?: string; stopped: boolean }
  | { type: 'error'; code: string; message: string }

export interface RunAgentTurnOptions {
  archive: EpubArchive
  overlay?: AgentWorkspaceOverlay
  provider: ResolvedProviderConfig
  history: HistoryTurn[]
  userMessage: string
  context?: AgentTurnContext
  abortSignal?: AbortSignal
  maxSteps?: number
  onEvent?: (event: AgentStreamEvent) => void
}

export interface RunAgentTurnResult {
  content: string
  toolCalls: ToolCallSummary[]
  proposal: AgentProposal | null
  stopped: boolean
  error: { code: string; message: string } | null
}

/** Deterministic sliding window keeping the newest turns within a character budget. */
export function trimHistory(history: HistoryTurn[], budget = HISTORY_CHAR_BUDGET): ModelMessage[] {
  const kept: ModelMessage[] = []
  let chars = 0
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const turn = history[index]!
    const text = turn.content.trim()
    if (!text) continue
    if (kept.length > 0 && chars + text.length > budget) break
    kept.push({ role: turn.role, content: text })
    chars += text.length
  }
  return kept.reverse()
}

function summarizeArgs(name: AgentToolName, args: Record<string, unknown>): string {
  switch (name) {
    case 'list_files':
      return '列出全书文件'
    case 'read_file': {
      const range = args.startLine || args.endLine ? `:${args.startLine ?? 1}-${args.endLine ?? ''}` : ''
      return `${String(args.path ?? '')}${range}`
    }
    case 'search_book':
      return `「${String(args.query ?? '').slice(0, 40)}」`
    case 'lint_book':
      return '全书结构检查'
    case 'get_metadata':
      return '读取 OPF 元数据'
    case 'get_toc':
      return '读取书籍目录'
    case 'edit_file':
      return String(args.path ?? '')
    case 'write_file':
      return String(args.path ?? '')
    case 'update_metadata':
      return '更新元数据'
    case 'update_toc':
      return '更新目录'
    case 'create_chapter':
      return String(args.filename ?? args.title ?? '新建章节')
    case 'rename_file':
      return `${String(args.path ?? '')} → ${String(args.newFilename ?? '')}`
    case 'delete_file':
      return String(args.path ?? '')
  }
}

function summarizeResult(name: AgentToolName, ok: boolean, data: unknown, error?: string): string {
  if (!ok) return error ? error.slice(0, 120) : '执行失败'
  const record = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  switch (name) {
    case 'list_files':
      return `共 ${Array.isArray(record.files) ? record.files.length : 0} 个文件`
    case 'read_file':
      return `第 ${record.startLine ?? 1}–${record.endLine ?? 0} / ${record.totalLines ?? 0} 行`
    case 'search_book':
      return `命中 ${record.count ?? 0} 处${record.truncated ? '（已截断）' : ''}`
    case 'lint_book':
      return `发现 ${record.count ?? 0} 项问题`
    case 'get_metadata':
      return '已读取元数据'
    case 'get_toc':
      return `已读取目录（${Array.isArray(record.entries) ? record.entries.length : 0} 顶层项）`
    case 'edit_file':
      return `已替换 ${record.replacements ?? 1} 处`
    case 'write_file':
      return `已写入 ${record.lineCount ?? 0} 行`
    case 'update_metadata':
      return '元数据已暂存'
    case 'update_toc':
      return '目录已暂存'
    case 'create_chapter':
      return `已暂存新建 ${String(record.path ?? '')}`
    case 'rename_file':
      return `已暂存重命名（更新 ${record.referencesRewritten ?? 0} 处引用）`
    case 'delete_file':
      return `已暂存删除 ${String(record.deletedPath ?? '')}`
  }
}

interface TocInput {
  label: string
  href: string
  rawHtml?: string
  children?: TocInput[]
}

const tocEntrySchema: z.ZodType<TocInput> = z.lazy(() =>
  z.object({
    label: z.string(),
    href: z.string(),
    rawHtml: z.string().optional(),
    children: z.array(tocEntrySchema).optional(),
  }),
)

function buildSdkTools(
  workspace: AgentWorkspace,
  records: ToolCallSummary[],
  emit: (event: AgentStreamEvent) => void,
) {
  function run(name: AgentToolName, args: Record<string, unknown>) {
    const id = randomUUID()
    const argsSummary = summarizeArgs(name, args)
    emit({ type: 'tool_start', id, name, argsSummary })
    const result = workspace.executeTool(name, args)
    const summary = summarizeResult(name, result.ok, result.data, result.error)
    records.push({ id, name, argsSummary, ok: result.ok, summary })
    emit({ type: 'tool_end', id, name, ok: result.ok, summary })
    return result
  }

  return {
    list_files: tool({
      description: '列出当前 EPUB 的元数据概要、spine 阅读顺序和全部文件路径、类型与行数。',
      inputSchema: z.object({}),
      execute: async () => run('list_files', {}),
    }),
    read_file: tool({
      description: '按行分页读取指定文本文件（默认 200 行，最多 400 行 / 24KB）。大章节请分段读取。',
      inputSchema: z.object({
        path: z.string().describe('EPUB 内文件路径，如 OEBPS/Text/ch001.xhtml'),
        startLine: z.number().int().min(1).optional().describe('起始行号（1-based）'),
        endLine: z.number().int().min(1).optional().describe('结束行号（1-based，含）'),
      }),
      execute: async (input) => run('read_file', input),
    }),
    search_book: tool({
      description: '在全书文本文件中检索字符串或正则表达式，返回路径、行号与前后文预览。',
      inputSchema: z.object({
        query: z.string().min(1).describe('搜索关键词或正则表达式'),
        regex: z.boolean().optional().describe('是否启用正则表达式'),
        caseSensitive: z.boolean().optional().describe('是否区分大小写'),
        pathFilter: z.string().optional().describe('仅搜索路径包含该子串的文件'),
        maxResults: z.number().int().min(1).max(100).optional().describe('最大返回条数，默认 40'),
      }),
      execute: async (input) => run('search_book', input),
    }),
    lint_book: tool({
      description: '运行全书结构检查，返回 manifest/spine 缺失、断链、断锚点、未引用资源等问题。',
      inputSchema: z.object({}),
      execute: async () => run('lint_book', {}),
    }),
    get_metadata: tool({
      description: '读取 OPF 中的 dc:* 元数据字段和全部 <meta> 标签。',
      inputSchema: z.object({}),
      execute: async () => run('get_metadata', {}),
    }),
    get_toc: tool({
      description: '读取书籍目录树（nav.xhtml 或 toc.ncx）以及失效锚点列表。',
      inputSchema: z.object({}),
      execute: async () => run('get_toc', {}),
    }),
    edit_file: tool({
      description: '对已有文本文件执行精确片段替换并即时校验 XML 良构性。优先使用此工具以保真。',
      inputSchema: z.object({
        path: z.string().describe('要修改的文件路径'),
        oldText: z.string().min(1).describe('待替换的精确原文片段'),
        newText: z.string().describe('替换后的新文本'),
        replaceAll: z.boolean().optional().describe('是否替换该文件内全部匹配项，默认 false'),
      }),
      execute: async (input) => run('edit_file', input),
    }),
    write_file: tool({
      description: '整文件覆写已有文本文件并校验 XML 良构性（不可用于新建文件，新建章节请用 create_chapter）。',
      inputSchema: z.object({
        path: z.string().describe('已存在的文本文件路径'),
        content: z.string().describe('完整的新文件内容'),
      }),
      execute: async (input) => run('write_file', input),
    }),
    update_metadata: tool({
      description: '更新 OPF 的 dc:* 元数据字段和/或 <meta> 行，并同步 dcterms:modified。',
      inputSchema: z.object({
        metadata: z
          .object({
            title: z.string().optional(),
            creators: z.array(z.string()).optional(),
            language: z.string().optional(),
            identifier: z.string().optional(),
            publisher: z.string().optional(),
            date: z.string().optional(),
            description: z.string().optional(),
            subjects: z.array(z.string()).optional(),
            rights: z.string().optional(),
          })
          .optional(),
        meta: z
          .array(
            z.object({
              property: z.string(),
              refines: z.string().optional(),
              value: z.string(),
            }),
          )
          .optional(),
      }),
      execute: async (input) => run('update_metadata', input),
    }),
    update_toc: tool({
      description: '整体更新目录树，同时同步 nav.xhtml 与 toc.ncx（如存在）。',
      inputSchema: z.object({
        entries: z.array(tocEntrySchema).describe('完整的目录树数组'),
      }),
      execute: async (input) => run('update_toc', input),
    }),
    create_chapter: tool({
      description: '新建一个 XHTML 章节文件，注册到 OPF manifest 与 spine，可选加入目录。',
      inputSchema: z.object({
        title: z.string().min(1).describe('章节标题'),
        filename: z.string().optional().describe('可选文件名（如 ch026.xhtml），留空自动编号'),
        content: z.string().optional().describe('可选完整 XHTML 内容，留空使用标准章节骨架'),
        insertAfter: z.string().optional().describe('可选：插入到指定已有章节路径之后'),
        addToToc: z.boolean().optional().describe('是否同时追加到目录末尾'),
      }),
      execute: async (input) => run('create_chapter', input),
    }),
    rename_file: tool({
      description: '同目录重命名文件，自动更新 OPF manifest 并级联重写全书章节与目录中的引用。',
      inputSchema: z.object({
        path: z.string().describe('原文件路径'),
        newFilename: z.string().min(1).describe('新文件名（不含斜杠）'),
      }),
      execute: async (input) => run('rename_file', input),
    }),
    delete_file: tool({
      description: '删除指定文件，自动从 OPF manifest/spine 移除并清理目录条目（不可删除 OPF 或 nav）。',
      inputSchema: z.object({
        path: z.string().describe('待删除的文件路径'),
      }),
      execute: async (input) => run('delete_file', input),
    }),
  }
}

export async function runAgentTurn(options: RunAgentTurnOptions): Promise<RunAgentTurnResult> {
  const emit = options.onEvent ?? (() => {})
  const workspace = AgentWorkspace.fromArchive(options.archive, {
    codec: nodeXmlCodec,
    checkXml: nodeCheckXml,
    overlay: options.overlay,
  })

  const toolCalls: ToolCallSummary[] = []
  let content = ''

  try {
    const model = createLanguageModel(options.provider)
    const messages: ModelMessage[] = [
      ...trimHistory(options.history),
      { role: 'user', content: options.userMessage },
    ]

    const result = streamText({
      model,
      system: buildSystemPrompt(workspace.getPackage(), options.context),
      messages,
      tools: buildSdkTools(workspace, toolCalls, emit),
      stopWhen: stepCountIs(options.maxSteps ?? MAX_TOOL_STEPS),
      abortSignal: options.abortSignal,
    })

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        content += part.text
        emit({ type: 'text_delta', text: part.text })
      } else if (part.type === 'error') {
        throw part.error
      }
    }

    if (options.abortSignal?.aborted) {
      emit({ type: 'done', stopped: true })
      return { content, toolCalls, proposal: null, stopped: true, error: null }
    }

    const proposal = workspace.buildProposal(randomUUID())
    if (proposal) {
      emit({ type: 'proposal', proposal })
    }
    emit({ type: 'done', stopped: false })
    return { content, toolCalls, proposal, stopped: false, error: null }
  } catch (error) {
    if (options.abortSignal?.aborted) {
      emit({ type: 'done', stopped: true })
      return { content, toolCalls, proposal: null, stopped: true, error: null }
    }
    const classified = classifyProviderError(error)
    emit({ type: 'error', code: classified.code, message: classified.message })
    return { content, toolCalls, proposal: null, stopped: false, error: classified }
  }
}
