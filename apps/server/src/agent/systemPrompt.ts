import type { EpubPackage } from '@booksmith/core'
import type { AgentApprovalMode } from './runner'

export interface AgentTurnContext {
  activePath?: string | null
  selection?: string | null
  selectionStartLine?: number | null
  selectionEndLine?: number | null
}

export interface BuildSystemPromptOptions {
  approvalMode?: AgentApprovalMode
  customInstructions?: string
}

const MAX_SELECTION_CHARS = 4000
export const MAX_CUSTOM_INSTRUCTIONS_CHARS = 4000

/**
 * Builds the session-stable system prompt for an EPUB book.
 * Per-turn volatile editor state (active page path, text selection) is intentionally excluded
 * so switching pages or selections never invalidates prompt-cache prefixes.
 */
export function buildSystemPrompt(
  pkg: EpubPackage,
  options: BuildSystemPromptOptions = {},
): string {
  const { approvalMode = 'review', customInstructions } = options

  const modeRule =
    approvalMode === 'ask'
      ? '4. 只读顾问模式：当前仅开放只读查询工具，不可对书籍执行任何写入修改。请基于真实读取到的文件内容给出精准的问题定位、分析结论与可执行建议。'
      : approvalMode === 'auto'
        ? '4. 自动应用模式：你调用的所有写工具在回合结束并通过结构预检（且无删除导致的外链失效）后将自动应用到用户工作区；若存在结构报错或断链风险则自动降级为待审阅提案。请务必先核实上下文再做最小精准修改，回复结束时简明概括改动文件及原因。'
        : '4. 实时审阅机制：你调用的每次写工具都会实时推送到用户的审阅画布，用户可边看边逐处保留或拒绝，回合结束或停止后统一落盘。回复结束时简明概括改了哪些文件及原因即可，无需把整篇代码贴在回复里。'

  const lines: string[] = [
    '你是 Booksmith 的内置 EPUB 校对与编辑助手，正在协助用户编辑当前打开的一本 EPUB 电子书。',
    '',
    '## 工作原则',
    '1. 先查后改：修改任何文件前，先用 `read_file`、`search_book`、`get_metadata`、`get_toc`、`scan_headings` 或 `lint_book` 确认真实内容与上下文。',
    '2. 精准保真：优先用 `edit_file` 做最小片段替换，绝不随意重排未修改的 XHTML 结构、属性、命名空间或内联 `<math>`（MathML）公式；调整目录结构优先使用 `edit_toc` 增量操作或 `generate_toc`，仅在需要完全重塑时使用 `update_toc`，以保护未修改条目的内联 MathML；拆章、合章、挂载样式表与清理未引用资源请优先使用专用结构工具（`split_chapter` / `merge_chapters` / `link_stylesheets` / `create_stylesheet` / `cleanup_unused_resources`），避免手工拼改 OPF 与跨章引用。',
    '3. 自动纠错：写工具会即时校验 XML 良构性；若工具返回 XML 错误或匹配失败，先读回上下文并自行修正后再结束本轮。',
    modeRule,
    '5. 简洁直接：默认使用中文，回答直奔结论和具体行号/文件名。',
    '6. 轮次上下文：每条用户消息前可能附带 `<current_context>` 块，标明用户在该轮提问时正在查看的文件与选中的文本片段；若用户未另行指定文件，优先以该轮附带的上下文为准。',
    '7. 连续会话与待审阅草稿：历史中保留了你此前调用的工具结果、提案处置结论（已应用/部分跳过/已放弃/已撤销/已被替代）或早期上下文摘要。若上一轮存在未应用的待审阅提案且未被用户手动改写，本轮工具看到的已是叠加该草稿后的内容——纯追问时无需重复改写，需要微调时直接基于当前草稿继续编辑即可；若工具历史中某条较早输出已被折叠或压缩，切勿臆测原文，重新调用只读工具核实即可。',
    '',
    '## 当前书籍',
    `- 书名：${pkg.metadata.title || '未命名'}`,
    `- 作者：${pkg.metadata.creators.join(', ') || '未填写'}`,
    `- 语言：${pkg.metadata.language || '未填写'}`,
    `- OPF：${pkg.opfPath}`,
    `- 导航目录：${pkg.navPath ?? pkg.ncxPath ?? '无'}`,
    `- 正文章节数：${pkg.spine.length}`,
  ]

  const trimmedCustom = customInstructions?.trim()
  if (trimmedCustom) {
    lines.push('', '## 用户自定义附加指令', trimmedCustom.slice(0, MAX_CUSTOM_INSTRUCTIONS_CHARS))
  }

  return lines.join('\n')
}

function codeFenceFor(text: string): string {
  let longest = 0
  for (const match of text.matchAll(/`+/g)) {
    if (match[0].length > longest) longest = match[0].length
  }
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * Formats a user message with its per-turn editor context (active file & selection).
 * Used identically for both the active turn and replayed history turns so conversation
 * prefixes stay byte-identical across page switches.
 */
export function formatUserMessageWithContext(
  content: string,
  context?: AgentTurnContext | null,
): string {
  const activePath = context?.activePath?.trim() || ''
  const rawSelection = context?.selection ?? ''
  const hasSelection = rawSelection.trim().length > 0
  if (!activePath && !hasSelection) return content

  const lines: string[] = ['<current_context>']
  if (activePath) {
    lines.push(`当前正在查看的文件：${activePath}`)
  }
  if (hasSelection) {
    const snippet = rawSelection.slice(0, MAX_SELECTION_CHARS)
    const truncated = rawSelection.length > MAX_SELECTION_CHARS ? '\n...(已截断)' : ''
    const body = `${snippet}${truncated}`
    const fence = codeFenceFor(body)
    const startLine =
      typeof context?.selectionStartLine === 'number' && Number.isInteger(context.selectionStartLine) && context.selectionStartLine > 0
        ? context.selectionStartLine
        : null
    const endLine =
      typeof context?.selectionEndLine === 'number' && Number.isInteger(context.selectionEndLine) && context.selectionEndLine > 0
        ? context.selectionEndLine
        : null
    const lineLabel = startLine
      ? endLine && endLine > startLine
        ? `（第 ${startLine}–${endLine} 行）`
        : `（第 ${startLine} 行）`
      : ''
    lines.push(`用户选中的文本片段${lineLabel}：`, fence, body, fence)
  }
  lines.push('</current_context>', '', content)
  return lines.join('\n')
}
