import { randomUUID } from 'node:crypto'
import {
  AgentWorkspace,
  isReadOnlyAgentTool,
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
 * See ADR 2026-11-20-builtin-epub-agent, ADR 2026-11-20-agent-modes-and-multimodel.
 */

export const MAX_TOOL_STEPS = 15
const HISTORY_CHAR_BUDGET = 24_000

export type AgentApprovalMode = 'ask' | 'review' | 'auto'
export const AGENT_APPROVAL_MODES: readonly AgentApprovalMode[] = ['ask', 'review', 'auto'] as const

export function isAgentApprovalMode(value: unknown): value is AgentApprovalMode {
  return value === 'ask' || value === 'review' || value === 'auto'
}

/** 0 means unlimited tool steps (runs until the model stops naturally or the user aborts); any positive integer sets a cap.
 * See ADR 2026-11-20-agent-modes-and-multimodel. */
export function normalizeMaxToolSteps(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MAX_TOOL_STEPS
  const rounded = Math.round(value)
  return rounded <= 0 ? 0 : rounded
}

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
  | { type: 'reasoning_delta'; text: string }
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
  approvalMode?: AgentApprovalMode
  customInstructions?: string
  abortSignal?: AbortSignal
  maxSteps?: number
  onEvent?: (event: AgentStreamEvent) => void
}

export interface RunAgentTurnResult {
  content: string
  reasoning: string
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
    case 'scan_headings': {
      const levels = Array.isArray(args.levels) ? `h${args.levels.join('/h')}` : 'h1–h6'
      return `扫描正文标题（${levels}）`
    }
    case 'edit_file':
      return String(args.path ?? '')
    case 'write_file':
      return String(args.path ?? '')
    case 'update_metadata':
      return '更新元数据'
    case 'update_toc':
      return '更新目录'
    case 'generate_toc': {
      const mode = args.mode === 'append_missing' ? '补全缺失项' : '重建目录'
      return `从标题生成目录（${mode}）`
    }
    case 'edit_toc':
      return `目录操作：${String(args.action ?? '')}`
    case 'create_chapter':
      return String(args.filename ?? args.title ?? '新建章节')
    case 'rename_file':
      return `${String(args.path ?? '')} → ${String(args.newFilename ?? '')}`
    case 'delete_file':
      return String(args.path ?? '')
    case 'split_chapter': {
      const mode =
        args.byMarkers === true
          ? '按拆分标记'
          : typeof args.headingLevel === 'number'
            ? `按 h${args.headingLevel}`
            : typeof args.line === 'number'
              ? `第 ${args.line} 行`
              : '按锚文本'
      return `${String(args.path ?? '')}（${mode}）`
    }
    case 'merge_chapters':
      return `合并 ${Array.isArray(args.paths) ? args.paths.length : 0} 个章节`
    case 'link_stylesheets':
      return `为 ${Array.isArray(args.chapterPaths) ? args.chapterPaths.length : 0} 个章节更新样式表`
    case 'create_stylesheet':
      return String(args.filename ?? '新建样式表')
    case 'cleanup_unused_resources':
      return args.dryRun === true ? '扫描未引用资源' : '清理未引用资源'
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
    case 'scan_headings':
      return `扫描到 ${record.count ?? 0} 个标题${record.truncated ? '（已截断）' : ''}`
    case 'edit_file':
      return `已替换 ${record.replacements ?? 1} 处`
    case 'write_file':
      return `已写入 ${record.lineCount ?? 0} 行`
    case 'update_metadata':
      return '元数据已暂存'
    case 'update_toc':
      return '目录已暂存'
    case 'generate_toc':
      return `已生成目录（共 ${record.totalCount ?? 0} 项${record.injectedIdCount ? `，补写 ${record.injectedIdCount} 个锚点` : ''}）`
    case 'edit_toc':
      return `目录结构已更新（共 ${record.totalCount ?? 0} 项）`
    case 'create_chapter':
      return `已暂存新建 ${String(record.path ?? '')}`
    case 'rename_file':
      return `已暂存重命名（更新 ${record.referencesRewritten ?? 0} 处引用）`
    case 'delete_file':
      return `已暂存删除 ${String(record.deletedPath ?? '')}`
    case 'split_chapter': {
      const created = Array.isArray(record.createdPaths) ? record.createdPaths.length : 0
      return `已拆出 ${created} 个新章（更新 ${record.referencesRewritten ?? 0} 处引用）`
    }
    case 'merge_chapters': {
      const removed = Array.isArray(record.removedPaths) ? record.removedPaths.length : 0
      return `已合并 ${removed + 1} 章至 ${String(record.primaryPath ?? '')}`
    }
    case 'link_stylesheets': {
      const changed = Array.isArray(record.changedPaths) ? record.changedPaths.length : 0
      return `已更新 ${changed} 个章节的样式表`
    }
    case 'create_stylesheet':
      return `已暂存新建 ${String(record.path ?? '')}`
    case 'cleanup_unused_resources': {
      const removed = Array.isArray(record.removedPaths) ? record.removedPaths.length : 0
      return removed > 0 ? `已清理 ${removed} 个未引用资源` : `扫描完成（共 ${Array.isArray(record.unused) ? record.unused.length : 0} 个未引用资源）`
    }
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
  approvalMode: AgentApprovalMode,
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

  const allTools = {
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
    scan_headings: tool({
      description: '按阅读顺序扫描 spine 各章的 h1–h6 正文标题与现有 id 锚点，便于生成或核对目录。',
      inputSchema: z.object({
        levels: z
          .array(z.number().int().min(1).max(6))
          .optional()
          .describe('要扫描的标题级别数组，如 [1, 2, 3]，默认全部 h1–h6'),
        includeUntitledSpine: z.boolean().optional().describe('是否包含无匹配标题的 spine 章节'),
      }),
      execute: async (input) => run('scan_headings', input),
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
      description: '整体更新目录树，同时同步 nav.xhtml 与 toc.ncx（如存在）。微调长目录请优先使用 edit_toc。',
      inputSchema: z.object({
        entries: z.array(tocEntrySchema).describe('完整的目录树数组'),
      }),
      execute: async (input) => run('update_toc', input),
    }),
    generate_toc: tool({
      description:
        '按指定标题级别扫描正文生成或补全目录，自动同步 nav.xhtml 与 toc.ncx；缺失目录时自动初始化。',
      inputSchema: z.object({
        levels: z
          .array(z.number().int().min(1).max(6))
          .optional()
          .describe('纳入目录的标题层级，默认 [1, 2, 3]'),
        mode: z
          .enum(['replace', 'append_missing'])
          .optional()
          .describe('replace 重建目录；append_missing 保留现有目录与 MathML 仅追加缺失项'),
        injectMissingIds: z.boolean().optional().describe('是否为无 id 标题自动写入稳定锚点，默认 true'),
        includeUntitledSpine: z.boolean().optional().describe('是否将无匹配标题的章节按文件名补入'),
      }),
      execute: async (input) => run('generate_toc', input),
    }),
    edit_toc: tool({
      description:
        '按节点路径增量调整目录结构（保留未修改条目的内联 MathML），支持插入、改名/改链接、上下移、子树移动、大纲保序缩进/取消缩进、删除（可选保留子项）、刷新标题与清理失效锚点。',
      inputSchema: z.object({
        action: z
          .enum([
            'insert',
            'update',
            'move',
            'move_subtree',
            'indent',
            'outdent',
            'remove',
            'refresh_labels',
            'clean_broken',
          ])
          .describe('要执行的增量目录动作'),
        path: z.array(z.number().int().min(0)).optional().describe('目标节点路径，如 [1, 0]'),
        paths: z
          .array(z.array(z.number().int().min(0)))
          .optional()
          .describe('批量操作目标路径数组，支持 move/indent/outdent/remove/refresh_labels'),
        toPath: z.array(z.number().int().min(0)).optional().describe('move_subtree 的目标位置路径'),
        position: z.enum(['before', 'after', 'inside']).optional().describe('insert 或 move_subtree 的相对位置'),
        delta: z.union([z.literal(-1), z.literal(1)]).optional().describe('move 方向：-1 上移，1 下移'),
        label: z.string().optional().describe('insert 或 update 的标题'),
        href: z.string().optional().describe('insert 或 update 的相对链接'),
        keepChildren: z.boolean().optional().describe('remove 时是否保留子项并上提一级'),
        overwriteRichHtml: z.boolean().optional().describe('refresh_labels 时是否覆盖含内联 MathML 的条目，默认 false'),
      }),
      execute: async (input) => run('edit_toc', input),
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
    split_chapter: tool({
      description:
        '按行号、唯一锚文本、Sigil 拆分标记（byMarkers）或标题层级（headingLevel）拆分章节，自动闭合/重开嵌套标签、紧插 spine 并迁移全书与目录的 #id 锚点链接。',
      inputSchema: z.object({
        path: z.string().describe('待拆分的章节路径'),
        line: z.number().int().min(1).optional().describe('按 1-based 行号在该行前拆分'),
        beforeText: z.string().min(1).optional().describe('按文件内唯一匹配的文本片段前拆分'),
        byMarkers: z.boolean().optional().describe('按章节中的 <hr class="sigil_split_marker" /> 标记批量拆分'),
        headingLevel: z.number().int().min(1).max(6).optional().describe('按 h1–h6 标题层级自动拆分为多章'),
      }),
      execute: async (input) => run('split_chapter', input),
    }),
    merge_chapters: tool({
      description: '将多个章节按顺序合并至第一个章节，补齐缺失样式表、重写全书与目录引用并从 OPF 移除被合并文件。',
      inputSchema: z.object({
        paths: z.array(z.string().min(1)).min(2).describe('按阅读顺序排列的待合并章节路径，首项保留为主章节'),
      }),
      execute: async (input) => run('merge_chapters', input),
    }),
    link_stylesheets: tool({
      description: '为一个或多个章节设置、追加或移除 <head> 中的 CSS 样式表 <link> 引用。',
      inputSchema: z.object({
        chapterPaths: z.array(z.string().min(1)).min(1).describe('目标章节路径数组'),
        set: z.array(z.string()).optional().describe('直接设为该样式表路径集合'),
        add: z.array(z.string()).optional().describe('追加挂载的样式表路径'),
        remove: z.array(z.string()).optional().describe('取消挂载的样式表路径'),
      }),
      execute: async (input) => run('link_stylesheets', input),
    }),
    create_stylesheet: tool({
      description: '新建空白或带初始内容的 CSS 样式表并注册到 OPF manifest，可选同时关联到指定章节。',
      inputSchema: z.object({
        filename: z.string().optional().describe('可选文件名，如 custom.css'),
        content: z.string().optional().describe('可选初始 CSS 内容'),
        linkToChapters: z.array(z.string()).optional().describe('可选：创建后自动关联到这些章节'),
      }),
      execute: async (input) => run('create_stylesheet', input),
    }),
    cleanup_unused_resources: tool({
      description:
        '扫描或清理未被引用且非封面的图片、字体与未关联样式表；传入 dryRun: true 可仅预览清单不删除。',
      inputSchema: z.object({
        paths: z.array(z.string()).optional().describe('仅删除指定的未引用资源路径'),
        categories: z
          .array(z.enum(['image', 'font', 'stylesheet']))
          .optional()
          .describe('按分类清理（image / font / stylesheet）'),
        dryRun: z.boolean().optional().describe('true 时仅返回未引用清单不执行删除'),
      }),
      execute: async (input) => run('cleanup_unused_resources', input),
    }),
  }

  // Filter out write tools in `ask` mode at registration time so the model can never mutate the workspace.
  // See ADR 2026-11-20-agent-modes-and-multimodel.
  if (approvalMode === 'ask') {
    const readOnly: Partial<typeof allTools> = {}
    for (const key of Object.keys(allTools) as AgentToolName[]) {
      if (isReadOnlyAgentTool(key)) {
        ;(readOnly as Record<string, unknown>)[key] = allTools[key]
      }
    }
    return readOnly
  }

  return allTools
}

export async function runAgentTurn(options: RunAgentTurnOptions): Promise<RunAgentTurnResult> {
  const emit = options.onEvent ?? (() => {})
  const approvalMode: AgentApprovalMode = options.approvalMode ?? 'review'
  const workspace = AgentWorkspace.fromArchive(options.archive, {
    codec: nodeXmlCodec,
    checkXml: nodeCheckXml,
    overlay: options.overlay,
  })

  const toolCalls: ToolCallSummary[] = []
  let content = ''
  let reasoning = ''

  try {
    const model = createLanguageModel(options.provider)
    const messages: ModelMessage[] = [
      ...trimHistory(options.history),
      { role: 'user', content: options.userMessage },
    ]

    const maxSteps = normalizeMaxToolSteps(options.maxSteps)
    const result = streamText({
      model,
      system: buildSystemPrompt(workspace.getPackage(), {
        context: options.context,
        approvalMode,
        customInstructions: options.customInstructions,
      }),
      messages,
      tools: buildSdkTools(workspace, toolCalls, emit, approvalMode),
      stopWhen: maxSteps > 0 ? stepCountIs(maxSteps) : () => false,
      abortSignal: options.abortSignal,
    })

    for await (const part of result.fullStream) {
      if (part.type === 'reasoning-delta') {
        reasoning += part.text
        emit({ type: 'reasoning_delta', text: part.text })
      } else if (part.type === 'text-delta') {
        content += part.text
        emit({ type: 'text_delta', text: part.text })
      } else if (part.type === 'error') {
        throw part.error
      }
    }

    if (options.abortSignal?.aborted) {
      emit({ type: 'done', stopped: true })
      return { content, reasoning, toolCalls, proposal: null, stopped: true, error: null }
    }

    const proposal = approvalMode === 'ask' ? null : workspace.buildProposal(randomUUID())
    if (proposal) {
      emit({ type: 'proposal', proposal })
    }
    emit({ type: 'done', stopped: false })
    return { content, reasoning, toolCalls, proposal, stopped: false, error: null }
  } catch (error) {
    if (options.abortSignal?.aborted) {
      emit({ type: 'done', stopped: true })
      return { content, reasoning, toolCalls, proposal: null, stopped: true, error: null }
    }
    const classified = classifyProviderError(error)
    emit({ type: 'error', code: classified.code, message: classified.message })
    return { content, reasoning, toolCalls, proposal: null, stopped: false, error: classified }
  }
}
