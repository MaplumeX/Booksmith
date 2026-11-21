import type { EpubPackage } from '@booksmith/core'
import type { AgentApprovalMode } from './runner'

export interface AgentTurnContext {
  activePath?: string | null
  selection?: string | null
}

export interface BuildSystemPromptOptions {
  context?: AgentTurnContext
  approvalMode?: AgentApprovalMode
  customInstructions?: string
}

const MAX_SELECTION_CHARS = 4000
export const MAX_CUSTOM_INSTRUCTIONS_CHARS = 4000

export function buildSystemPrompt(
  pkg: EpubPackage,
  contextOrOptions?: AgentTurnContext | BuildSystemPromptOptions,
): string {
  const options: BuildSystemPromptOptions =
    contextOrOptions &&
    ('context' in contextOrOptions ||
      'approvalMode' in contextOrOptions ||
      'customInstructions' in contextOrOptions)
      ? (contextOrOptions as BuildSystemPromptOptions)
      : { context: contextOrOptions as AgentTurnContext | undefined }

  const { context, approvalMode = 'review', customInstructions } = options

  const modeRule =
    approvalMode === 'ask'
      ? '4. 只读顾问模式：当前仅开放只读查询工具，不可对书籍执行任何写入修改。请基于真实读取到的文件内容给出精准的问题定位、分析结论与可执行建议。'
      : approvalMode === 'auto'
        ? '4. 自动应用模式：你调用的所有写工具在回合结束并通过结构预检（且无删除导致的外链失效）后将自动应用到用户工作区；若存在结构报错或断链风险则自动降级为待审阅提案。请务必先核实上下文再做最小精准修改，回复结束时简明概括改动文件及原因。'
        : '4. 提案机制：你调用的所有写工具都会进入本轮待审阅提案，由用户在界面审阅字符级 Diff 后再应用到工作区。回复结束时简明概括改了哪些文件及原因即可，无需把整篇代码贴在回复里。'

  const lines: string[] = [
    '你是 Booksmith 的内置 EPUB 校对与编辑助手，正在协助用户编辑当前打开的一本 EPUB 电子书。',
    '',
    '## 工作原则',
    '1. 先查后改：修改任何文件前，先用 `read_file`、`search_book`、`get_metadata`、`get_toc`、`scan_headings` 或 `lint_book` 确认真实内容与上下文。',
    '2. 精准保真：优先用 `edit_file` 做最小片段替换，绝不随意重排未修改的 XHTML 结构、属性、命名空间或内联 `<math>`（MathML）公式；调整目录结构优先使用 `edit_toc` 增量操作或 `generate_toc`，仅在需要完全重塑时使用 `update_toc`，以保护未修改条目的内联 MathML；拆章、合章、挂载样式表与清理未引用资源请优先使用专用结构工具（`split_chapter` / `merge_chapters` / `link_stylesheets` / `create_stylesheet` / `cleanup_unused_resources`），避免手工拼改 OPF 与跨章引用。',
    '3. 自动纠错：写工具会即时校验 XML 良构性；若工具返回 XML 错误或匹配失败，先读回上下文并自行修正后再结束本轮。',
    modeRule,
    '5. 简洁直接：默认使用中文，回答直奔结论和具体行号/文件名。',
    '',
    '## 当前书籍',
    `- 书名：${pkg.metadata.title || '未命名'}`,
    `- 作者：${pkg.metadata.creators.join(', ') || '未填写'}`,
    `- 语言：${pkg.metadata.language || '未填写'}`,
    `- OPF：${pkg.opfPath}`,
    `- 导航目录：${pkg.navPath ?? pkg.ncxPath ?? '无'}`,
    `- 正文章节数：${pkg.spine.length}`,
  ]

  if (context?.activePath) {
    lines.push(`- 用户当前正在查看的文件：${context.activePath}`)
  }
  if (context?.selection && context.selection.trim()) {
    const snippet = context.selection.slice(0, MAX_SELECTION_CHARS)
    const truncated = context.selection.length > MAX_SELECTION_CHARS ? '\n...(已截断)' : ''
    lines.push('', '## 用户选中的文本片段', '```', `${snippet}${truncated}`, '```')
  }

  const trimmedCustom = customInstructions?.trim()
  if (trimmedCustom) {
    lines.push('', '## 用户自定义附加指令', trimmedCustom.slice(0, MAX_CUSTOM_INSTRUCTIONS_CHARS))
  }

  return lines.join('\n')
}
