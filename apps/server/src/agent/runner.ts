import { randomUUID } from 'node:crypto'
import {
  AgentWorkspace,
  diffProposalSnapshots,
  isReadOnlyAgentTool,
  probeImageDimensions,
  type AgentProposal,
  type AgentProposalDelta,
  type AgentToolName,
  type AgentToolResult,
  type AgentWorkspaceOverlay,
  type EpubArchive,
} from '@booksmith/core'
import { generateText, stepCountIs, streamText, tool, type ModelMessage } from 'ai'
import { z } from 'zod'
import {
  AUTO_COMPACT_RATIO,
  DEFAULT_CONTEXT_WINDOW,
  estimateMessageTokens,
  estimatePromptTokens,
  estimateTextTokens,
} from './contextWindow'
import { nodeCheckXml, nodeXmlCodec } from './nodeXmlCodec'
import { classifyProviderError, createLanguageModel, type ResolvedProviderConfig } from './providers'
import { buildSystemPrompt, formatUserMessageWithContext, type AgentTurnContext } from './systemPrompt'

/**
 * Server-side multi-step Agent turn executor bridging Vercel AI SDK `streamText`
 * to `@booksmith/core`'s framework-agnostic `AgentWorkspace`.
 * Persists & replays provider-neutral tool traces, seeds cumulative pending proposals,
 * and applies two-tier 80% context-window auto-compaction.
 * See ADR 2026-11-20-builtin-epub-agent, ADR 2026-11-20-agent-modes-and-multimodel, ADR 2026-11-21-agent-session-continuity.
 */

export const MAX_TOOL_STEPS = 15
const HISTORY_CHAR_BUDGET = 24_000

const RECENT_FULL_TOOL_TURNS = 3
const FOLD_TOOL_OUTPUT_MIN_CHARS = 600
const MAX_STORED_TOOL_RESULT_CHARS = 32_000
const MAX_INSPECT_IMAGE_BYTES = 4 * 1024 * 1024
const COMPACTION_TARGET_TAIL_RATIO = 0.28
const COMPACTION_TIMEOUT_MS = 45_000

const COMPACTION_SYSTEM_PROMPT = [
  '你是 Booksmith EPUB 编辑助手的会话上下文压缩器。',
  '请将给定的早期对话与工具轨迹压缩为一份简洁、结构化、高信息密度的中文工作摘要，供后续轮次无缝衔接。',
  '必须保留：',
  '1. 用户的核心编辑目标、校对规范、风格要求或明确约定；',
  '2. 已经排查/读取/修改过的文件路径、关键行号范围、问题清单与结论；',
  '3. 已提出的变更提案及其真实处置结果（已应用、部分跳过、已放弃、已撤销或待审阅）；',
  '4. 尚未完成或用户约定下一步要处理的事项。',
  '要求：只输出摘要正文，不要寒暄或解释；不要编造未出现的行号或内容；控制在 1200 字以内。',
].join('\n')

export type AgentApprovalMode = 'ask' | 'review' | 'auto'
export const AGENT_APPROVAL_MODES: readonly AgentApprovalMode[] = ['ask', 'review', 'auto'] as const

export type AgentProposalStatus = 'pending' | 'applied' | 'dismissed' | 'reverted' | 'superseded'

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

export interface ProposalResolution {
  keptHunks?: number
  totalHunks?: number
  skippedPaths?: string[]
  summary?: string
}

export interface CompactionNotice {
  compactedMessageCount: number
  beforeTokens: number
  afterTokens: number
  contextWindow: number
  summary: string
  degraded?: boolean
}

export interface ToolCallSummary {
  id: string
  name: AgentToolName
  argsSummary: string
  ok: boolean
  summary: string
}

export type AgentStepRecord =
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  | {
      type: 'tool'
      id: string
      callId: string
      name: AgentToolName
      args: Record<string, unknown>
      argsSummary: string
      ok: boolean
      summary: string
      result: AgentToolResult
    }

/** Lightweight client-safe timeline item omitting raw tool outputs. */
export type AgentTimelineItem =
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  | {
      type: 'tool'
      id: string
      name: AgentToolName
      argsSummary: string
      ok: boolean
      summary: string
    }

export function toTimelineItems(steps: readonly AgentStepRecord[]): AgentTimelineItem[] {
  const out: AgentTimelineItem[] = []
  for (const step of steps) {
    if (step.type === 'reasoning') {
      if (step.text.trim()) out.push({ type: 'reasoning', text: step.text })
    } else if (step.type === 'text') {
      if (step.text) out.push({ type: 'text', text: step.text })
    } else if (step.type === 'tool') {
      out.push({
        type: 'tool',
        id: step.id,
        name: step.name,
        argsSummary: step.argsSummary,
        ok: step.ok,
        summary: step.summary,
      })
    }
  }
  return out
}

export interface HistoryTurn {
  id?: string
  role: 'user' | 'assistant'
  content: string
  context?: AgentTurnContext | null
  steps?: AgentStepRecord[] | null
  proposalStatus?: AgentProposalStatus | null
  proposalResolution?: ProposalResolution | null
  proposalFilePaths?: string[] | null
}

export interface PendingProposalSeed {
  messageId: string
  proposal: AgentProposal
}

export type AgentStreamEvent =
  | { type: 'compacted'; notice: CompactionNotice }
  | { type: 'usage'; inputTokens: number; contextWindow: number }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; id: string; name: AgentToolName; argsSummary: string }
  | { type: 'tool_end'; id: string; name: AgentToolName; ok: boolean; summary: string }
  | { type: 'proposal_update'; delta: AgentProposalDelta }
  | { type: 'proposal'; proposal: AgentProposal }
  | { type: 'done'; messageId?: string; stopped: boolean }
  | { type: 'error'; code: string; message: string }

export interface RunAgentTurnOptions {
  archive: EpubArchive
  /** Optional true byte sizes for entries whose binary bytes were omitted to avoid DB detoasting. */
  entrySizes?: ReadonlyMap<string, number>
  /** Optional on-demand binary loader used by `inspect_image` for raster images stored in DB. */
  loadBinary?: (path: string) => Promise<Uint8Array | null>
  overlay?: AgentWorkspaceOverlay
  provider: ResolvedProviderConfig
  history: HistoryTurn[]
  userMessage: string
  context?: AgentTurnContext
  approvalMode?: AgentApprovalMode
  customInstructions?: string
  contextWindow?: number
  compactionSummary?: string | null
  previousInputTokens?: number | null
  pendingProposalSeed?: PendingProposalSeed | null
  abortSignal?: AbortSignal
  maxSteps?: number
  onEvent?: (event: AgentStreamEvent) => void
}

export interface RunAgentTurnResult {
  content: string
  reasoning: string
  steps: AgentStepRecord[]
  toolCalls: ToolCallSummary[]
  proposal: AgentProposal | null
  /** Set when a seeded pending proposal was replaced (new cumulative proposal or reverted back to baseline). */
  supersededProposalMessageId: string | null
  /** Populated when 80% auto-compaction ran before this turn. */
  compaction: {
    summary: string | null
    compactedUpToMessageId: string | null
    notice: CompactionNotice
  } | null
  usage: {
    inputTokens: number
    contextWindow: number
  }
  stopped: boolean
  error: { code: string; message: string } | null
}

/** Deterministic legacy sliding window kept exported for compatibility tests. */
export function trimHistory(history: HistoryTurn[], budget = HISTORY_CHAR_BUDGET): ModelMessage[] {
  const kept: ModelMessage[] = []
  let chars = 0
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const turn = history[index]!
    const trimmed = turn.content.trim()
    if (!trimmed) continue
    const text = turn.role === 'user' ? formatUserMessageWithContext(trimmed, turn.context) : trimmed
    if (kept.length > 0 && chars + text.length > budget) break
    kept.push({ role: turn.role, content: text })
    chars += text.length
  }
  return kept.reverse()
}

/**
 * Normalizes tool call IDs to provider-safe `[a-zA-Z0-9_-]{1,64}` identifiers so replayed
 * OpenAI-compatible traces remain valid when switching to Anthropic (and vice versa).
 * See ADR 2026-11-21-agent-session-continuity.
 */
export function normalizeToolCallId(raw: string, fallbackIndex: number): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 56)
  return cleaned.length > 0 ? cleaned : `tc_${fallbackIndex}`
}

function capToolResultForStorage(result: AgentToolResult): AgentToolResult {
  let serialized: string
  try {
    serialized = JSON.stringify(result)
  } catch {
    return { ok: result.ok, ...(result.error ? { error: result.error.slice(0, 500) } : {}) }
  }
  if (serialized.length <= MAX_STORED_TOOL_RESULT_CHARS) return result

  // Preserve key metadata while capping oversized string fields inside `data`.
  if (result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
    const copy: Record<string, unknown> = { ...(result.data as Record<string, unknown>) }
    if (typeof copy.content === 'string' && copy.content.length > 24_000) {
      copy.content = `${copy.content.slice(0, 24_000)}\n...(已截断以控制历史体积)`
      copy.truncated = true
    }
    try {
      if (JSON.stringify({ ok: result.ok, data: copy }).length <= MAX_STORED_TOOL_RESULT_CHARS) {
        return { ok: result.ok, data: copy }
      }
    } catch {
      // fall through
    }
  }
  return {
    ok: result.ok,
    data: {
      truncated: true,
      preview: serialized.slice(0, 2_000),
    },
    ...(result.error ? { error: result.error.slice(0, 500) } : {}),
  }
}

function formatProposalAnnotation(
  turn: HistoryTurn,
  pendingState?: { messageId: string; seeded: boolean; driftedPaths: string[] } | null,
): string | null {
  const status = turn.proposalStatus
  if (!status) return null
  const filesHint =
    turn.proposalFilePaths && turn.proposalFilePaths.length > 0
      ? `（涉及：${turn.proposalFilePaths.slice(0, 5).join('、')}${turn.proposalFilePaths.length > 5 ? ' 等' : ''}）`
      : ''

  if (status === 'applied') {
    const res = turn.proposalResolution
    if (res?.summary) return `[提案状态：用户已应用 — ${res.summary}]`
    if (typeof res?.keptHunks === 'number' && typeof res?.totalHunks === 'number' && res.keptHunks < res.totalHunks) {
      const skippedNote =
        res.skippedPaths && res.skippedPaths.length > 0 ? `，跳过涉及：${res.skippedPaths.join('、')}` : ''
      return `[提案状态：用户已部分应用（保留 ${res.keptHunks}/${res.totalHunks} 处变更${skippedNote}）]`
    }
    return `[提案状态：用户已将本轮提案全部应用到工作区${filesHint}]`
  }
  if (status === 'dismissed') {
    return `[提案状态：用户已放弃本轮提案，相关改动未生效${filesHint}]`
  }
  if (status === 'reverted') {
    return `[提案状态：用户曾应用但随后撤销了本轮提案，相关文件已恢复原状${filesHint}]`
  }
  if (status === 'superseded') {
    return `[提案状态：本轮提案已被后续轮次的累计新提案替代]`
  }
  if (status === 'pending') {
    if (pendingState && turn.id === pendingState.messageId) {
      if (pendingState.seeded) {
        return `[提案状态：待审阅（未落盘），本轮沙盒已自动承接此草稿；若本轮无新写操作将保持原提案，若有新写操作将生成累计新提案替代此提案]`
      }
      if (pendingState.driftedPaths.length > 0) {
        return `[提案状态：待审阅但已过时 — 用户此后已手动修改 ${pendingState.driftedPaths.join('、')}，本轮沙盒已基于编辑器最新内容重建]`
      }
    }
    return `[提案状态：待审阅，用户尚未应用到工作区${filesHint}]`
  }
  return null
}

function buildToolResultPayload(
  step: Extract<AgentStepRecord, { type: 'tool' }>,
  foldLargeReadOnly: boolean,
): unknown {
  if (foldLargeReadOnly && isReadOnlyAgentTool(step.name)) {
    let rawLen = 0
    try {
      rawLen = JSON.stringify(step.result).length
    } catch {
      rawLen = FOLD_TOOL_OUTPUT_MIN_CHARS + 1
    }
    if (rawLen > FOLD_TOOL_OUTPUT_MIN_CHARS) {
      return {
        ok: step.ok,
        compacted: true,
        tool: step.name,
        argsSummary: step.argsSummary,
        summary: step.summary,
        note: '较早轮次的详细只读输出已折叠；如需核实具体原文或行号，请重新调用工具读取。',
      }
    }
  }
  return step.result
}

function toJsonValue(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null))
  } catch {
    return { ok: false, error: 'unserializable tool result' }
  }
}

function buildAssistantReplayMessages(
  turn: HistoryTurn,
  options: {
    foldLargeReadOnly: boolean
    pendingState?: { messageId: string; seeded: boolean; driftedPaths: string[] } | null
    idCounter: { next: number }
  },
): ModelMessage[] {
  const annotation = formatProposalAnnotation(turn, options.pendingState)
  const steps = turn.steps ?? null

  if (!steps || steps.length === 0) {
    const baseText = turn.content.trim()
    const combined = [baseText, annotation].filter(Boolean).join('\n\n')
    if (!combined) return []
    return [{ role: 'assistant', content: combined }]
  }

  const out: ModelMessage[] = []
  let pendingTextParts: string[] = []
  let pendingToolSteps: Array<Extract<AgentStepRecord, { type: 'tool' }>> = []

  const flushGroup = () => {
    if (pendingToolSteps.length > 0) {
      const assistantParts: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
      > = []
      const joinedText = pendingTextParts.join('').trim()
      if (joinedText) {
        assistantParts.push({ type: 'text', text: joinedText })
      }
      const toolParts: Array<{
        type: 'tool-result'
        toolCallId: string
        toolName: string
        output: { type: 'json'; value: any }
      }> = []

      for (const toolStep of pendingToolSteps) {
        options.idCounter.next += 1
        const callId = normalizeToolCallId(toolStep.callId || toolStep.id, options.idCounter.next)
        assistantParts.push({
          type: 'tool-call',
          toolCallId: callId,
          toolName: toolStep.name,
          input: toJsonValue(toolStep.args ?? {}),
        })
        toolParts.push({
          type: 'tool-result',
          toolCallId: callId,
          toolName: toolStep.name,
          output: {
            type: 'json',
            value: toJsonValue(buildToolResultPayload(toolStep, options.foldLargeReadOnly)),
          },
        })
      }

      out.push({ role: 'assistant', content: assistantParts })
      out.push({ role: 'tool', content: toolParts })
      pendingTextParts = []
      pendingToolSteps = []
      return
    }

    const joinedText = pendingTextParts.join('').trim()
    if (joinedText) {
      out.push({ role: 'assistant', content: joinedText })
    }
    pendingTextParts = []
  }

  for (const step of steps) {
    if (step.type === 'reasoning') continue
    if (step.type === 'text') {
      if (pendingToolSteps.length > 0 && step.text.trim()) {
        flushGroup()
      }
      pendingTextParts.push(step.text)
    } else if (step.type === 'tool') {
      pendingToolSteps.push(step)
    }
  }
  flushGroup()

  if (out.length === 0) {
    const fallback = [turn.content.trim(), annotation].filter(Boolean).join('\n\n')
    if (!fallback) return []
    return [{ role: 'assistant', content: fallback }]
  }

  // Ensure every replayed assistant turn ends with an `assistant` message (never dangling `tool`),
  // and attach any proposal resolution annotation to that concluding assistant text.
  const last = out[out.length - 1]!
  if (last.role === 'tool') {
    out.push({
      role: 'assistant',
      content: annotation ?? turn.content.trim() ?? '（本轮工具执行已结束）',
    })
  } else if (annotation) {
    if (typeof last.content === 'string') {
      last.content = `${last.content}\n\n${annotation}`
    } else if (Array.isArray(last.content)) {
      ;(last.content as Array<{ type: string; text?: string }>).push({
        type: 'text',
        text: `\n\n${annotation}`,
      })
    }
  }

  return out
}

interface LogicalTurn {
  turns: HistoryTurn[]
  lastMessageId: string | null
  messageCount: number
}

function groupIntoLogicalTurns(history: readonly HistoryTurn[]): LogicalTurn[] {
  const groups: LogicalTurn[] = []
  let current: HistoryTurn[] = []

  const flush = () => {
    if (current.length === 0) return
    const lastId = [...current].reverse().find((t) => Boolean(t.id))?.id ?? null
    groups.push({ turns: current, lastMessageId: lastId, messageCount: current.length })
    current = []
  }

  for (const turn of history) {
    if (turn.role === 'user') {
      if (current.length > 0) flush()
      current.push(turn)
    } else {
      if (current.length === 0) {
        // Orphan leading assistant turn: skip to preserve strict user-first ordering.
        continue
      }
      current.push(turn)
      flush()
    }
  }
  flush()
  return groups
}

function buildCompactionPrefixMessages(summary: string | null | undefined): ModelMessage[] {
  const trimmed = summary?.trim()
  if (!trimmed) return []
  return [
    {
      role: 'user',
      content: `<session_compaction_summary>\n以下是本会话较早轮次的自动压缩摘要，请将其视为已知上下文继续工作：\n\n${trimmed}\n</session_compaction_summary>`,
    },
    {
      role: 'assistant',
      content: '已了解早期会话摘要，我将在此基础上继续协助处理本书。',
    },
  ]
}

function renderLogicalTurnsToMessages(
  logicalTurns: readonly LogicalTurn[],
  options: {
    foldOlderThanLastN: number
    pendingState?: { messageId: string; seeded: boolean; driftedPaths: string[] } | null
  },
): ModelMessage[] {
  const messages: ModelMessage[] = []
  const idCounter = { next: 0 }

  // Identify the indices of the newest N logical turns that retain full read-only tool outputs.
  const fullCutoff = Math.max(0, logicalTurns.length - options.foldOlderThanLastN)

  for (let i = 0; i < logicalTurns.length; i += 1) {
    const group = logicalTurns[i]!
    const foldLargeReadOnly = i < fullCutoff
    const turnMessages: ModelMessage[] = []

    for (const turn of group.turns) {
      if (turn.role === 'user') {
        const trimmed = turn.content.trim()
        if (!trimmed) continue
        const text = formatUserMessageWithContext(trimmed, turn.context)
        turnMessages.push({ role: 'user', content: text })
      } else {
        const assistantMsgs = buildAssistantReplayMessages(turn, {
          foldLargeReadOnly,
          pendingState: options.pendingState,
          idCounter,
        })
        turnMessages.push(...assistantMsgs)
      }
    }

    if (turnMessages.length === 0) continue

    // Guard against consecutive `user` messages when an older assistant reply failed with empty output.
    const prev = messages[messages.length - 1]
    if (prev && prev.role === 'user' && turnMessages[0]!.role === 'user') {
      messages.push({ role: 'assistant', content: '（上一轮未生成文本回复）' })
    }
    messages.push(...turnMessages)
  }

  return messages
}

function buildCompactionTranscript(
  existingSummary: string | null | undefined,
  logicalTurns: readonly LogicalTurn[],
  pendingState?: { messageId: string; seeded: boolean; driftedPaths: string[] } | null,
): string {
  const sections: string[] = []
  if (existingSummary?.trim()) {
    sections.push(`## 既有早期摘要\n${existingSummary.trim()}`)
  }

  const lines: string[] = ['## 待归并的对话记录']
  for (const group of logicalTurns) {
    for (const turn of group.turns) {
      if (turn.role === 'user') {
        const ctxNote = turn.context?.activePath ? `（查看文件：${turn.context.activePath}）` : ''
        lines.push(`- 用户${ctxNote}：${turn.content.trim().slice(0, 1500)}`)
      } else {
        const toolSummaries = (turn.steps ?? [])
          .filter((s): s is Extract<AgentStepRecord, { type: 'tool' }> => s.type === 'tool')
          .map((s) => `${s.name}(${s.argsSummary})→${s.ok ? s.summary : `失败:${s.summary}`}`)
        const toolLine = toolSummaries.length > 0 ? `\n  工具步骤：${toolSummaries.join('；')}` : ''
        const annotation = formatProposalAnnotation(turn, pendingState)
        const propLine = annotation ? `\n  ${annotation}` : ''
        const text = turn.content.trim().slice(0, 2000) || '（无正文）'
        lines.push(`- 助手：${text}${toolLine}${propLine}`)
      }
    }
  }
  sections.push(lines.join('\n'))
  return sections.join('\n\n')
}

/**
 * Prunes oversized read-only tool results inside an active multi-step `streamText` loop
 * when accumulated in-turn tool outputs exceed 80% of the context window.
 */
function pruneInTurnStepMessages(messages: ModelMessage[], contextWindow: number, systemPrompt: string): ModelMessage[] {
  const threshold = Math.floor(contextWindow * AUTO_COMPACT_RATIO)
  const currentEst = estimatePromptTokens({ system: systemPrompt, messages, includeToolsOverhead: true })
  if (currentEst <= threshold) return messages

  // Locate indices of `tool` messages; keep the newest 2 tool messages verbatim and fold older large read-only outputs.
  const toolMsgIndices: number[] = []
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === 'tool') toolMsgIndices.push(i)
  }
  if (toolMsgIndices.length <= 2) return messages
  const foldableIndices = new Set(toolMsgIndices.slice(0, -2))

  let changed = false
  const next = messages.map((msg, idx) => {
    if (!foldableIndices.has(idx) || msg.role !== 'tool' || !Array.isArray(msg.content)) return msg
    const newParts = msg.content.map((part) => {
      if (!part || typeof part !== 'object' || part.type !== 'tool-result') return part
      const toolName = String(part.toolName ?? '') as AgentToolName
      if (!isReadOnlyAgentTool(toolName)) return part
      const size = estimateMessageTokens({ role: 'tool', content: [part] })
      if (size < 200) return part
      changed = true
      return {
        ...part,
        output: {
          type: 'json' as const,
          value: {
            compacted: true,
            tool: toolName,
            note: '本轮较早步骤的只读结果已折叠以维持上下文窗口；如需原文请重新读取。',
          },
        },
      }
    })
    return { ...msg, content: newParts } as ModelMessage
  })
  return changed ? next : messages
}

function summarizeArgs(name: AgentToolName, args: Record<string, unknown>): string {
  switch (name) {
    case 'list_files':
      return '列出全书文件'
    case 'read_file': {
      const range = args.startLine || args.endLine ? `:${args.startLine ?? 1}-${args.endLine ?? ''}` : ''
      const viewTag = args.view === 'text' ? '（纯文本）' : ''
      return `${String(args.path ?? '')}${range}${viewTag}`
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
    case 'list_anchors':
      return String(args.path ?? '')
    case 'find_references': {
      if (typeof args.targetPath === 'string' && args.targetPath.trim()) return `→ ${args.targetPath.trim()}`
      if (typeof args.fromPath === 'string' && args.fromPath.trim()) return `${args.fromPath.trim()} →`
      return '全书引用'
    }
    case 'inspect_image':
      return String(args.path ?? '')
    case 'edit_file': {
      const count = Array.isArray(args.edits) && args.edits.length > 0 ? `（${args.edits.length} 处）` : ''
      return `${String(args.path ?? '')}${count}`
    }
    case 'replace_in_book': {
      const prefix = args.dryRun === true ? '预览替换 ' : ''
      return `${prefix}「${String(args.query ?? '').slice(0, 28)}」`
    }
    case 'write_file':
      return String(args.path ?? '')
    case 'format_file': {
      if (Array.isArray(args.paths) && args.paths.length > 0) {
        return args.paths.length === 1 ? String(args.paths[0]) : `${args.paths.length} 个文件`
      }
      return String(args.path ?? '')
    }
    case 'update_metadata':
      return '更新元数据'
    case 'update_toc':
      return '更新目录'
    case 'generate_toc': {
      const mode = args.mode === 'append_missing' ? '补全缺失项' : '重建目录'
      return `从标题生成目录（${mode}）`
    }
    case 'edit_toc':
      return Array.isArray(args.actions) && args.actions.length > 0
        ? `批量目录操作（${args.actions.length} 项）`
        : `目录操作：${String(args.action ?? '')}`
    case 'create_chapter':
      return String(args.filename ?? args.title ?? '新建章节')
    case 'rename_file':
      return `${String(args.path ?? '')} → ${String(args.newFilename ?? '')}`
    case 'delete_file':
      return String(args.path ?? '')
    case 'reorder_spine':
      return `重排 ${Array.isArray(args.orderedPaths) ? args.orderedPaths.length : 0} 个章节`
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
      return record.view === 'text'
        ? `纯文本 L${record.startLine ?? 1}–${record.endLine ?? 0}（共 ${record.totalBlocks ?? 0} 段）`
        : `第 ${record.startLine ?? 1}–${record.endLine ?? 0} / ${record.totalLines ?? 0} 行`
    case 'search_book':
      return `命中 ${record.count ?? 0} 处${record.truncated ? '（已截断）' : ''}`
    case 'lint_book':
      return `发现 ${record.count ?? 0} 项问题`
    case 'get_metadata':
      return '已读取元数据'
    case 'get_toc':
      return `已读取目录（共 ${record.totalCount ?? (Array.isArray(record.entries) ? record.entries.length : 0)} 项）`
    case 'scan_headings':
      return `扫描到 ${record.count ?? 0} 个标题${record.truncated ? '（已截断）' : ''}`
    case 'list_anchors':
      return `共 ${record.count ?? 0} 个锚点${record.truncated ? '（已截断）' : ''}`
    case 'find_references':
      return `找到 ${record.count ?? 0} 处引用${record.truncated ? '（已截断）' : ''}`
    case 'inspect_image': {
      const dims =
        typeof record.width === 'number' && typeof record.height === 'number'
          ? `${record.width}×${record.height}`
          : record.isSvg === true
            ? 'SVG'
            : String(record.mediaType ?? '图片')
      const refs = Array.isArray(record.referencedBy) ? record.referencedBy.length : 0
      return `${dims}，被引用 ${refs} 处`
    }
    case 'edit_file':
      return `已替换 ${record.replacements ?? 1} 处`
    case 'replace_in_book': {
      const filesChanged = Number(record.filesChanged ?? 0)
      const total = Number(record.totalReplacements ?? 0)
      return record.dryRun === true
        ? `预览命中 ${filesChanged} 个文件、${total} 处`
        : `已替换 ${filesChanged} 个文件、共 ${total} 处`
    }
    case 'write_file':
      return `已写入 ${record.lineCount ?? 0} 行`
    case 'format_file': {
      const count = Array.isArray(record.formattedPaths) ? record.formattedPaths.length : 0
      return count > 0 ? `已格式化 ${count} 个文件` : '无需格式化（已规范）'
    }
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
    case 'reorder_spine':
      return `阅读顺序已更新（共 ${Array.isArray(record.spine) ? record.spine.length : 0} 章）`
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
      return removed > 0
        ? `已清理 ${removed} 个未引用资源`
        : `扫描完成（共 ${Array.isArray(record.unused) ? record.unused.length : 0} 个未引用资源）`
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

function createAbortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

function extractToolHintPaths(
  args: Record<string, unknown>,
  data: unknown,
): string[] {
  const hints: string[] = []
  const pushStr = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) hints.push(value.trim())
  }
  const pushArr = (value: unknown) => {
    if (!Array.isArray(value)) return
    for (const item of value) pushStr(item)
  }

  if (data && typeof data === 'object') {
    const rec = data as Record<string, unknown>
    pushStr(rec.path)
    pushStr(rec.primaryPath)
    pushArr(rec.createdPaths)
    pushArr(rec.changedPaths)
    pushArr(rec.formattedPaths)
    pushStr(rec.deletedPath)
    pushStr(rec.opfPath)
    if (Array.isArray(rec.files)) {
      for (const item of rec.files) {
        if (item && typeof item === 'object') pushStr((item as Record<string, unknown>).path)
      }
    }
  }
  pushStr(args.path)
  pushArr(args.chapterPaths)
  pushArr(args.paths)
  return hints
}

interface InspectImageExecutionResult extends AgentToolResult {
  _image?: {
    mediaType: string
    base64: string
  }
}

const editTocActionSchema = z.object({
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
})

function buildSdkTools(
  workspace: AgentWorkspace,
  records: ToolCallSummary[],
  steps: AgentStepRecord[],
  emit: (event: AgentStreamEvent) => void,
  approvalMode: AgentApprovalMode,
  abortSignal?: AbortSignal,
  onWriteSuccess?: (name: AgentToolName, args: Record<string, unknown>, result: AgentToolResult) => void,
  binaryContext?: {
    archive: EpubArchive
    loadBinary?: (path: string) => Promise<Uint8Array | null>
  },
) {
  function run(name: AgentToolName, args: Record<string, unknown>, toolCallId?: string) {
    if (abortSignal?.aborted) throw createAbortError()
    const id = randomUUID()
    const callId = normalizeToolCallId(toolCallId || id, records.length + 1)
    const argsSummary = summarizeArgs(name, args)
    emit({ type: 'tool_start', id, name, argsSummary })
    const result = workspace.executeTool(name, args)
    const summary = summarizeResult(name, result.ok, result.data, result.error)
    records.push({ id, name, argsSummary, ok: result.ok, summary })
    steps.push({
      type: 'tool',
      id,
      callId,
      name,
      args: (toJsonValue(args) ?? {}) as Record<string, unknown>,
      argsSummary,
      ok: result.ok,
      summary,
      result: capToolResultForStorage(result),
    })
    emit({ type: 'tool_end', id, name, ok: result.ok, summary })
    if (result.ok && !isReadOnlyAgentTool(name)) {
      onWriteSuccess?.(name, args, result)
    }
    return result
  }

  async function runInspectImage(
    args: Record<string, unknown>,
    toolCallId?: string,
  ): Promise<InspectImageExecutionResult> {
    if (abortSignal?.aborted) throw createAbortError()
    const id = randomUUID()
    const callId = normalizeToolCallId(toolCallId || id, records.length + 1)
    const argsSummary = summarizeArgs('inspect_image', args)
    emit({ type: 'tool_start', id, name: 'inspect_image', argsSummary })

    const baseResult = workspace.executeTool('inspect_image', args)
    let storedResult: AgentToolResult = baseResult
    let imagePayload: { mediaType: string; base64: string } | undefined

    if (baseResult.ok && baseResult.data && typeof baseResult.data === 'object') {
      const data = { ...(baseResult.data as Record<string, unknown>) }
      const path = typeof data.path === 'string' ? data.path : ''
      const mediaType = typeof data.mediaType === 'string' ? data.mediaType : ''
      const isSvg = data.isSvg === true

      if (!isSvg && path && mediaType) {
        const originPath = workspace.getOriginPath(path)
        let bytes = binaryContext?.archive.entries.get(originPath) ?? binaryContext?.archive.entries.get(path)
        if ((!bytes || bytes.byteLength === 0) && binaryContext?.loadBinary) {
          try {
            const loaded = await binaryContext.loadBinary(originPath)
            if (loaded && loaded.byteLength > 0) bytes = loaded
          } catch {
            // Fall back to metadata-only output when binary retrieval fails.
          }
        }

        if (abortSignal?.aborted) throw createAbortError()

        if (bytes && bytes.byteLength > 0) {
          data.byteSize = bytes.byteLength
          if (data.width === undefined || data.height === undefined) {
            const dims = probeImageDimensions(bytes, mediaType)
            if (dims) {
              data.width = dims.width
              data.height = dims.height
            }
          }
          if (bytes.byteLength <= MAX_INSPECT_IMAGE_BYTES) {
            imagePayload = {
              mediaType,
              base64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
            }
            data.imageAttached = true
          } else {
            data.imageAttached = false
            data.note = `图片体积为 ${bytes.byteLength} 字节，超过 ${MAX_INSPECT_IMAGE_BYTES} 字节内联视觉上限，仅返回元数据与引用信息。`
          }
        } else {
          data.imageAttached = false
          data.note = '当前无法读取该图片的二进制像素数据，仅返回元数据与引用信息。'
        }
        storedResult = { ok: true, data }
      }
    }

    const summary = summarizeResult('inspect_image', storedResult.ok, storedResult.data, storedResult.error)
    records.push({ id, name: 'inspect_image', argsSummary, ok: storedResult.ok, summary })
    // Never persist raw base64 image payloads into `stepsJson`; keep history lightweight and provider-neutral.
    steps.push({
      type: 'tool',
      id,
      callId,
      name: 'inspect_image',
      args: (toJsonValue(args) ?? {}) as Record<string, unknown>,
      argsSummary,
      ok: storedResult.ok,
      summary,
      result: capToolResultForStorage(storedResult),
    })
    emit({ type: 'tool_end', id, name: 'inspect_image', ok: storedResult.ok, summary })
    return imagePayload ? { ...storedResult, _image: imagePayload } : storedResult
  }

  const allTools = {
    list_files: tool({
      description:
        '列出当前 EPUB 的元数据概要、样式表清单、spine 阅读顺序和全部文件路径、类型、行数、正文字数、关联样式表与真实字节大小。',
      inputSchema: z.object({}),
      execute: async (_input, options) => run('list_files', {}, options?.toolCallId),
    }),
    read_file: tool({
      description:
        '按行分页读取指定文本文件（默认 200 行，最多 400 行 / 24KB）。支持 view: "text" 提取带原文行号的纯文本段落以便高效校对长章；遇单行超长压缩文件支持 charOffset 分片读取。',
      inputSchema: z.object({
        path: z.string().describe('EPUB 内文件路径，如 OEBPS/Text/ch001.xhtml'),
        startLine: z.number().int().min(1).optional().describe('起始行号（1-based）'),
        endLine: z.number().int().min(1).optional().describe('结束行号（1-based，含）'),
        view: z
          .enum(['raw', 'text'])
          .optional()
          .describe('raw 返回带行号的原始源码（默认）；text 返回带 L行号 前缀的正文纯文本与 [h1]/[公式]/[图片] 占位'),
        charOffset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('仅 raw 模式下用于超长单行文件的字符偏移（0-based）'),
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(24_000)
          .optional()
          .describe('本次最大返回字符数，默认 24000'),
      }),
      execute: async (input, options) => run('read_file', input, options?.toolCallId),
    }),
    search_book: tool({
      description: '在全书文本文件中检索字符串或正则表达式，返回路径、行号与前后文预览。无效正则会直接报错。',
      inputSchema: z.object({
        query: z.string().min(1).describe('搜索关键词或正则表达式'),
        regex: z.boolean().optional().describe('是否启用正则表达式'),
        caseSensitive: z.boolean().optional().describe('是否区分大小写'),
        scope: z
          .enum(['all', 'spine', 'styles', 'metadata'])
          .optional()
          .describe('搜索范围：all 全部文本（默认）、spine 仅正文章节、styles 仅 CSS、metadata 仅 OPF/目录'),
        pathFilter: z.string().optional().describe('仅搜索路径包含该子串的文件'),
        maxResults: z.number().int().min(1).max(100).optional().describe('最大返回条数，默认 40'),
        contextChars: z.number().int().min(10).max(200).optional().describe('前后文预览字符半径，默认 40'),
      }),
      execute: async (input, options) => run('search_book', input, options?.toolCallId),
    }),
    lint_book: tool({
      description: '运行全书结构检查，返回 manifest/spine 缺失、断链、断锚点、未引用资源等问题。',
      inputSchema: z.object({}),
      execute: async (_input, options) => run('lint_book', {}, options?.toolCallId),
    }),
    get_metadata: tool({
      description: '读取 OPF 中的 dc:* 元数据字段和全部 <meta> 标签。',
      inputSchema: z.object({}),
      execute: async (_input, options) => run('get_metadata', {}, options?.toolCallId),
    }),
    get_toc: tool({
      description: '读取书籍目录树（每个节点自带 path 下标，可直接传给 edit_toc）以及失效锚点列表。',
      inputSchema: z.object({}),
      execute: async (_input, options) => run('get_toc', {}, options?.toolCallId),
    }),
    scan_headings: tool({
      description: '按阅读顺序扫描 spine 各章的 h1–h6 正文标题、所在行号与现有 id 锚点，便于定位、拆章或核对目录。',
      inputSchema: z.object({
        levels: z
          .array(z.number().int().min(1).max(6))
          .optional()
          .describe('要扫描的标题级别数组，如 [1, 2, 3]，默认全部 h1–h6'),
        includeUntitledSpine: z.boolean().optional().describe('是否包含无匹配标题的 spine 章节'),
      }),
      execute: async (input, options) => run('scan_headings', input, options?.toolCallId),
    }),
    list_anchors: tool({
      description: '按文档顺序列出指定 XHTML/XML 文件中所有可跳转的 id / a[name] 锚点、标签名、文本与行号。',
      inputSchema: z.object({
        path: z.string().describe('EPUB 内文本文件路径'),
        limit: z.number().int().min(1).max(500).optional().describe('最大返回锚点数，默认 200'),
      }),
      execute: async (input, options) => run('list_anchors', input, options?.toolCallId),
    }),
    find_references: tool({
      description: '反查指定文件被全书哪些位置引用（targetPath），或查看指定文件引用了哪些内部资源/链接（fromPath）。',
      inputSchema: z.object({
        targetPath: z.string().optional().describe('被引用目标路径（反查谁引用了它），如 OEBPS/Images/fig01.png'),
        fromPath: z.string().optional().describe('来源文件路径（查看它引用了哪些文件）'),
        includeOpf: z.boolean().optional().describe('是否包含 OPF manifest 声明，默认 false'),
        maxResults: z.number().int().min(1).max(300).optional().describe('最大返回条数，默认 100'),
      }),
      execute: async (input, options) => run('find_references', input, options?.toolCallId),
    }),
    inspect_image: tool({
      description:
        '查看书内图片元数据、尺寸、引用位置（含 img alt 属性）及图像画面（支持 PNG/JPEG/GIF/WebP 视觉读取与 SVG 源码读取），便于核对图注、补写 alt 或识别图表公式。',
      inputSchema: z.object({
        path: z.string().describe('图片在 EPUB 内的路径，如 OEBPS/Images/fig01.png'),
      }),
      execute: async (input, options) => runInspectImage(input, options?.toolCallId),
      toModelOutput: ({ output }) => {
        if (output._image) {
          const { _image, ...clean } = output
          return {
            type: 'content',
            value: [
              { type: 'text', text: JSON.stringify(clean) },
              {
                type: 'file',
                mediaType: _image.mediaType,
                data: { type: 'data', data: _image.base64 },
              },
            ],
          }
        }
        return { type: 'json', value: toJsonValue(output) as any }
      },
    }),
    edit_file: tool({
      description:
        '对已有文本文件执行精确片段替换并即时校验 XML 良构性，返回改动行号。支持单次传入 edits 数组原子执行多处编辑。',
      inputSchema: z.object({
        path: z.string().describe('要修改的文件路径'),
        oldText: z.string().min(1).optional().describe('单处编辑时的待替换精确原文片段'),
        newText: z.string().optional().describe('单处编辑时的替换后新文本'),
        replaceAll: z.boolean().optional().describe('单处编辑时是否替换该文件内全部匹配项，默认 false'),
        edits: z
          .array(
            z.object({
              oldText: z.string().min(1).describe('待替换精确原文片段'),
              newText: z.string().describe('替换后新文本'),
              replaceAll: z.boolean().optional().describe('是否替换全部匹配项，默认 false'),
            }),
          )
          .min(1)
          .optional()
          .describe('单文件多处原子替换列表（任一失败或 XML 无效将整批回滚）'),
      }),
      execute: async (input, options) => run('edit_file', input, options?.toolCallId),
    }),
    replace_in_book: tool({
      description:
        '在全书多个文件中批量执行字面量或正则表达式替换，逐文件严格校验 XML（任一文件非法则整批中止回滚）。建议大范围替换前先 dryRun: true 预览。',
      inputSchema: z.object({
        query: z.string().min(1).describe('待查找的字符串或正则表达式'),
        replacement: z.string().describe('替换为的新文本（regex: true 时支持 $1/$& 等捕获组）'),
        regex: z.boolean().optional().describe('是否启用正则表达式，默认 false'),
        caseSensitive: z.boolean().optional().describe('是否区分大小写，默认 true'),
        scope: z
          .enum(['spine', 'styles', 'all'])
          .optional()
          .describe('作用范围：spine 仅正文章节（默认）、styles 仅 CSS、all 全部非受保护文本'),
        paths: z.array(z.string().min(1)).optional().describe('显式指定目标文件列表（传入后覆盖 scope）'),
        pathFilter: z.string().optional().describe('仅处理路径包含该子串的文件'),
        dryRun: z.boolean().optional().describe('true 时仅预览命中统计与样本前后文，不写入修改'),
        maxFiles: z.number().int().min(1).max(500).optional().describe('单次最多修改文件数，默认 200'),
      }),
      execute: async (input, options) => run('replace_in_book', input, options?.toolCallId),
    }),
    write_file: tool({
      description: '整文件覆写已有文本文件并校验 XML 良构性（不可用于新建文件，新建章节请用 create_chapter）。',
      inputSchema: z.object({
        path: z.string().describe('已存在的文本文件路径'),
        content: z.string().describe('完整的新文件内容'),
      }),
      execute: async (input, options) => run('write_file', input, options?.toolCallId),
    }),
    format_file: tool({
      description:
        '使用保真格式化器规范缩进 XHTML/XML/OPF/NCX 或 CSS 文件（原样保留 <math>/<svg>/<pre>/<style>/<script> 与行内空白），特别适合先展开单行压缩章节再编辑。',
      inputSchema: z.object({
        path: z.string().optional().describe('单个待格式化文件路径'),
        paths: z.array(z.string().min(1)).optional().describe('批量待格式化文件路径数组'),
      }),
      execute: async (input, options) => run('format_file', input, options?.toolCallId),
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
      execute: async (input, options) => run('update_metadata', input, options?.toolCallId),
    }),
    update_toc: tool({
      description: '整体更新目录树，同时同步 nav.xhtml 与 toc.ncx（如存在）。微调长目录请优先使用 edit_toc。',
      inputSchema: z.object({
        entries: z.array(tocEntrySchema).describe('完整的目录树数组'),
      }),
      execute: async (input, options) => run('update_toc', input, options?.toolCallId),
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
      execute: async (input, options) => run('generate_toc', input, options?.toolCallId),
    }),
    edit_toc: tool({
      description:
        '按节点路径增量调整目录结构（保留未修改条目的内联 MathML），支持单个动作或 actions 批量原子执行，并在条目数 <= 150 时直接返回更新后的带 path 目录树。',
      inputSchema: z.object({
        action: editTocActionSchema.shape.action.optional().describe('单动作模式下的增量目录动作'),
        path: editTocActionSchema.shape.path,
        paths: editTocActionSchema.shape.paths,
        toPath: editTocActionSchema.shape.toPath,
        position: editTocActionSchema.shape.position,
        delta: editTocActionSchema.shape.delta,
        label: editTocActionSchema.shape.label,
        href: editTocActionSchema.shape.href,
        keepChildren: editTocActionSchema.shape.keepChildren,
        overwriteRichHtml: editTocActionSchema.shape.overwriteRichHtml,
        actions: z
          .array(editTocActionSchema)
          .min(1)
          .max(50)
          .optional()
          .describe('批量顺序执行的目录动作列表（任一步失败整批回滚）'),
      }),
      execute: async (input, options) => run('edit_toc', input, options?.toolCallId),
    }),
    create_chapter: tool({
      description:
        '新建一个 XHTML 章节文件，注册到 OPF manifest 与 spine，默认自动继承相邻/首章样式表，可选紧插到 insertAfter 之后并同步插入对应目录位置。',
      inputSchema: z.object({
        title: z.string().min(1).describe('章节标题'),
        filename: z.string().optional().describe('可选文件名（如 ch026.xhtml），留空自动编号'),
        content: z.string().optional().describe('可选完整 XHTML 内容，留空使用标准章节骨架'),
        insertAfter: z.string().optional().describe('可选：插入到指定已有 spine 章节路径之后（不存在将报错）'),
        addToToc: z.boolean().optional().describe('是否同时加入目录（若指定 insertAfter 则紧插其后，否则追加末尾）'),
        stylesheets: z
          .array(z.string().min(1))
          .optional()
          .describe('可选：显式指定要挂载的 CSS 路径（不传且未自定义 content 时自动继承主样式表）'),
      }),
      execute: async (input, options) => run('create_chapter', input, options?.toolCallId),
    }),
    rename_file: tool({
      description: '同目录重命名文件，自动更新 OPF manifest 并级联重写全书章节与目录中的引用。',
      inputSchema: z.object({
        path: z.string().describe('原文件路径'),
        newFilename: z.string().min(1).describe('新文件名（不含斜杠）'),
      }),
      execute: async (input, options) => run('rename_file', input, options?.toolCallId),
    }),
    delete_file: tool({
      description: '删除指定文件，自动从 OPF manifest/spine 移除并清理目录条目（不可删除 OPF 或 nav）。',
      inputSchema: z.object({
        path: z.string().describe('待删除的文件路径'),
      }),
      execute: async (input, options) => run('delete_file', input, options?.toolCallId),
    }),
    reorder_spine: tool({
      description: '调整 OPF <spine> 中正文章节的阅读顺序，并同步更新 dcterms:modified。未列出的章节保持相对顺序排在末尾。',
      inputSchema: z.object({
        orderedPaths: z
          .array(z.string().min(1))
          .min(1)
          .describe('按目标阅读顺序排列的 spine 章节路径数组'),
      }),
      execute: async (input, options) => run('reorder_spine', input, options?.toolCallId),
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
      execute: async (input, options) => run('split_chapter', input, options?.toolCallId),
    }),
    merge_chapters: tool({
      description: '将多个章节按顺序合并至第一个章节，补齐缺失样式表、重写全书与目录引用并从 OPF 移除被合并文件。',
      inputSchema: z.object({
        paths: z.array(z.string().min(1)).min(2).describe('按阅读顺序排列的待合并章节路径，首项保留为主章节'),
      }),
      execute: async (input, options) => run('merge_chapters', input, options?.toolCallId),
    }),
    link_stylesheets: tool({
      description: '为一个或多个章节设置、追加或移除 <head> 中的 CSS 样式表 <link> 引用。',
      inputSchema: z.object({
        chapterPaths: z.array(z.string().min(1)).min(1).describe('目标章节路径数组'),
        set: z.array(z.string()).optional().describe('直接设为该样式表路径集合'),
        add: z.array(z.string()).optional().describe('追加挂载的样式表路径'),
        remove: z.array(z.string()).optional().describe('取消挂载的样式表路径'),
      }),
      execute: async (input, options) => run('link_stylesheets', input, options?.toolCallId),
    }),
    create_stylesheet: tool({
      description: '新建空白或带初始内容的 CSS 样式表并注册到 OPF manifest，可选同时关联到指定章节。',
      inputSchema: z.object({
        filename: z.string().optional().describe('可选文件名，如 custom.css'),
        content: z.string().optional().describe('可选初始 CSS 内容'),
        linkToChapters: z.array(z.string()).optional().describe('可选：创建后自动关联到这些章节'),
      }),
      execute: async (input, options) => run('create_stylesheet', input, options?.toolCallId),
    }),
    cleanup_unused_resources: tool({
      description:
        '扫描或清理未被引用且非封面的图片、字体与未关联样式表；传入 dryRun: true 可仅预览清单与体积不删除。',
      inputSchema: z.object({
        paths: z.array(z.string()).optional().describe('仅删除指定的未引用资源路径'),
        categories: z
          .array(z.enum(['image', 'font', 'stylesheet']))
          .optional()
          .describe('按分类清理（image / font / stylesheet）'),
        dryRun: z.boolean().optional().describe('true 时仅返回未引用清单不执行删除'),
      }),
      execute: async (input, options) => run('cleanup_unused_resources', input, options?.toolCallId),
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

function appendTimelineDelta(steps: AgentStepRecord[], type: 'reasoning' | 'text', delta: string): void {
  if (!delta) return
  const tail = steps[steps.length - 1]
  if (tail && tail.type === type) {
    tail.text += delta
  } else {
    steps.push({ type, text: delta })
  }
}

export async function runAgentTurn(options: RunAgentTurnOptions): Promise<RunAgentTurnResult> {
  const emit = options.onEvent ?? (() => {})
  const approvalMode: AgentApprovalMode = options.approvalMode ?? 'review'
  const contextWindow = options.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  const workspace = AgentWorkspace.fromArchive(options.archive, {
    codec: nodeXmlCodec,
    checkXml: nodeCheckXml,
    overlay: options.overlay,
    entrySizes: options.entrySizes,
  })

  // Seed unapplied pending proposal onto the working copy (unless ask-mode or user drifted files).
  // See ADR 2026-11-21-agent-session-continuity.
  let pendingState: { messageId: string; seeded: boolean; driftedPaths: string[] } | null = null
  if (options.pendingProposalSeed && approvalMode !== 'ask') {
    const seedResult = workspace.seedPendingProposal(options.pendingProposalSeed.proposal)
    pendingState = {
      messageId: options.pendingProposalSeed.messageId,
      seeded: seedResult.seeded,
      driftedPaths: seedResult.driftedPaths,
    }
  }

  const toolCalls: ToolCallSummary[] = []
  const steps: AgentStepRecord[] = []
  const proposalId = randomUUID()
  let lastLiveProposal: AgentProposal | null = null
  let content = ''
  let reasoning = ''
  let compactionResult: RunAgentTurnResult['compaction'] = null
  let reportedInputTokens = 0

  // Emits incremental live proposal updates after each successful write tool in `review` mode only;
  // `auto` and `ask` modes stay silent until settlement. See ADR 2026-11-22-live-streaming-agent-review.
  const handleWriteSuccess = (
    _name: AgentToolName,
    args: Record<string, unknown>,
    result: AgentToolResult,
  ) => {
    if (approvalMode !== 'review') return
    const nextSnapshot = workspace.buildProposal(proposalId, { validate: false })
    const delta = diffProposalSnapshots(lastLiveProposal, nextSnapshot, {
      proposalId,
      hintPaths: extractToolHintPaths(args, result.data),
      opfPath: workspace.getPackage().opfPath,
    })
    lastLiveProposal = nextSnapshot
    if (delta) {
      emit({ type: 'proposal_update', delta })
    }
  }

  // Soft-stop in `review` mode preserves completed sandbox writes as a validated pending proposal
  // rather than discarding prior tool steps. See ADR 2026-11-22-live-streaming-agent-review.
  const finalizeProposal = (stopped: boolean): {
    proposal: AgentProposal | null
    supersededProposalMessageId: string | null
  } => {
    if (approvalMode === 'ask') {
      return { proposal: null, supersededProposalMessageId: null }
    }
    if (stopped && approvalMode !== 'review') {
      return { proposal: null, supersededProposalMessageId: null }
    }
    const proposal = workspace.buildProposal(proposalId, { validate: true })
    const supersededProposalMessageId =
      pendingState?.seeded && workspace.hasNewMutations() ? pendingState.messageId : null
    if (proposal) {
      emit({ type: 'proposal', proposal })
    }
    return { proposal, supersededProposalMessageId }
  }

  try {
    if (options.abortSignal?.aborted) {
      emit({ type: 'done', stopped: true })
      return {
        content,
        reasoning,
        steps,
        toolCalls,
        proposal: null,
        supersededProposalMessageId: null,
        compaction: null,
        usage: { inputTokens: 0, contextWindow },
        stopped: true,
        error: null,
      }
    }

    const model = createLanguageModel(options.provider)
    const systemPrompt = buildSystemPrompt(workspace.getPackage(), {
      approvalMode,
      customInstructions: options.customInstructions,
    })
    const trimmedUserMessage = options.userMessage.trim()
    const currentUserContent = formatUserMessageWithContext(
      trimmedUserMessage || options.userMessage,
      options.context,
    )
    const currentUserMsg: ModelMessage = { role: 'user', content: currentUserContent }
    const includeToolsOverhead = approvalMode !== 'ask'

    // Tier 1: replay full tool traces for recent turns and fold oversized read-only outputs in older turns.
    const logicalTurns = groupIntoLogicalTurns(options.history)
    const existingPrefix = buildCompactionPrefixMessages(options.compactionSummary)

    const unfoldedHistoryMsgs = renderLogicalTurnsToMessages(logicalTurns, {
      foldOlderThanLastN: logicalTurns.length,
      pendingState,
    })
    const foldedHistoryMsgs = renderLogicalTurnsToMessages(logicalTurns, {
      foldOlderThanLastN: RECENT_FULL_TOOL_TURNS,
      pendingState,
    })

    const estimatedBeforeFold = estimatePromptTokens({
      system: systemPrompt,
      messages: [...existingPrefix, ...unfoldedHistoryMsgs, currentUserMsg],
      includeToolsOverhead,
    })
    const estimatedAfterFold = estimatePromptTokens({
      system: systemPrompt,
      messages: [...existingPrefix, ...foldedHistoryMsgs, currentUserMsg],
      includeToolsOverhead,
    })

    const foldedSavings = Math.max(0, estimatedBeforeFold - estimatedAfterFold)
    const currentUserTokens = estimateMessageTokens(currentUserMsg)
    const calibratedTokens =
      typeof options.previousInputTokens === 'number' && options.previousInputTokens > 0
        ? Math.max(estimatedAfterFold, options.previousInputTokens - foldedSavings + currentUserTokens)
        : estimatedAfterFold

    const compactThreshold = Math.floor(contextWindow * AUTO_COMPACT_RATIO)
    let activePrefix = existingPrefix
    let activeHistoryMsgs = foldedHistoryMsgs

    // Tier 2: when still >= 80% of context window, auto-compact older turns via the active model
    // (gracefully degrading to turn-aligned trimming if compaction fails). See ADR 2026-11-21-agent-session-continuity.
    if (calibratedTokens >= compactThreshold && logicalTurns.length > 0) {
      const tailBudget = Math.max(512, Math.floor(contextWindow * COMPACTION_TARGET_TAIL_RATIO))
      let tailTokens = currentUserTokens
      let keepFromIndex = logicalTurns.length

      for (let i = logicalTurns.length - 1; i >= 0; i -= 1) {
        const singleTurnMsgs = renderLogicalTurnsToMessages([logicalTurns[i]!], {
          foldOlderThanLastN: 1,
          pendingState,
        })
        const turnCost = singleTurnMsgs.reduce((acc, m) => acc + estimateMessageTokens(m), 0)
        if (keepFromIndex < logicalTurns.length && tailTokens + turnCost > tailBudget) break
        if (tailTokens + turnCost > tailBudget) {
          // Even the newest single turn alone exceeds tail budget; compact all prior turns if any.
          if (i > 0) keepFromIndex = i
          break
        }
        tailTokens += turnCost
        keepFromIndex = i
      }

      // Ensure at least the oldest turn gets compacted when pressure is >= 80%.
      if (keepFromIndex === 0 && logicalTurns.length > 1) {
        keepFromIndex = 1
      } else if (keepFromIndex === 0 && logicalTurns.length === 1) {
        keepFromIndex = 1
      }

      const turnsToCompact = logicalTurns.slice(0, keepFromIndex)
      const remainingTurns = logicalTurns.slice(keepFromIndex)

      if (turnsToCompact.length > 0) {
        const compactedMessageCount = turnsToCompact.reduce((sum, g) => sum + g.messageCount, 0)
        const compactedUpToMessageId =
          [...turnsToCompact].reverse().find((g) => g.lastMessageId)?.lastMessageId ?? null

        let summaryText: string | null = null
        let degraded = false
        try {
          const transcript = buildCompactionTranscript(options.compactionSummary, turnsToCompact, pendingState)
          const timeoutSignal = AbortSignal.timeout(COMPACTION_TIMEOUT_MS)
          const combinedSignal = options.abortSignal
            ? AbortSignal.any([options.abortSignal, timeoutSignal])
            : timeoutSignal
          const compactRes = await generateText({
            model,
            system: COMPACTION_SYSTEM_PROMPT,
            prompt: transcript,
            maxOutputTokens: Math.min(2048, Math.max(512, Math.floor(contextWindow * 0.2))),
            maxRetries: 0,
            abortSignal: combinedSignal,
          })
          const candidate = compactRes.text.trim()
          if (candidate) summaryText = candidate
          else degraded = true
        } catch (compactError) {
          if (options.abortSignal?.aborted) throw compactError
          degraded = true
        }

        if (summaryText) {
          activePrefix = buildCompactionPrefixMessages(summaryText)
          activeHistoryMsgs = renderLogicalTurnsToMessages(remainingTurns, {
            foldOlderThanLastN: RECENT_FULL_TOOL_TURNS,
            pendingState,
          })
          const afterTokens = estimatePromptTokens({
            system: systemPrompt,
            messages: [...activePrefix, ...activeHistoryMsgs, currentUserMsg],
            includeToolsOverhead,
          })
          const notice: CompactionNotice = {
            compactedMessageCount,
            beforeTokens: calibratedTokens,
            afterTokens,
            contextWindow,
            summary: summaryText,
          }
          compactionResult = { summary: summaryText, compactedUpToMessageId, notice }
          emit({ type: 'compacted', notice })
        } else {
          // Graceful fallback: drop oldest logical turns until under 80% without failing the turn.
          let trimmedTurns = remainingTurns
          while (trimmedTurns.length > 0) {
            const candidateMsgs = renderLogicalTurnsToMessages(trimmedTurns, {
              foldOlderThanLastN: RECENT_FULL_TOOL_TURNS,
              pendingState,
            })
            const est = estimatePromptTokens({
              system: systemPrompt,
              messages: [...existingPrefix, ...candidateMsgs, currentUserMsg],
              includeToolsOverhead,
            })
            if (est < compactThreshold) break
            trimmedTurns = trimmedTurns.slice(1)
          }
          activePrefix = existingPrefix
          activeHistoryMsgs = renderLogicalTurnsToMessages(trimmedTurns, {
            foldOlderThanLastN: RECENT_FULL_TOOL_TURNS,
            pendingState,
          })
          const afterTokens = estimatePromptTokens({
            system: systemPrompt,
            messages: [...activePrefix, ...activeHistoryMsgs, currentUserMsg],
            includeToolsOverhead,
          })
          const droppedCount =
            logicalTurns.reduce((sum, g) => sum + g.messageCount, 0) -
            trimmedTurns.reduce((sum, g) => sum + g.messageCount, 0)
          if (droppedCount > 0) {
            const notice: CompactionNotice = {
              compactedMessageCount: droppedCount,
              beforeTokens: calibratedTokens,
              afterTokens,
              contextWindow,
              summary: '自动摘要服务暂时不可用，已按完整回合裁剪最旧上下文以继续对话。',
              degraded: true,
            }
            compactionResult = { summary: options.compactionSummary ?? null, compactedUpToMessageId: null, notice }
            emit({ type: 'compacted', notice })
          }
        }
      }
    }

    const messages: ModelMessage[] = [...activePrefix, ...activeHistoryMsgs]
    if (messages.length > 0 && messages[messages.length - 1]!.role === 'user') {
      messages.push({ role: 'assistant', content: '（上一轮未生成文本回复）' })
    }
    messages.push(currentUserMsg)

    const initialEstimatedTokens = estimatePromptTokens({
      system: systemPrompt,
      messages,
      includeToolsOverhead,
    })

    const maxSteps = normalizeMaxToolSteps(options.maxSteps)
    const result = streamText({
      model,
      system: systemPrompt,
      messages,
      tools: buildSdkTools(workspace, toolCalls, steps, emit, approvalMode, options.abortSignal, handleWriteSuccess, {
        archive: options.archive,
        loadBinary: options.loadBinary,
      }),
      stopWhen: maxSteps > 0 ? stepCountIs(maxSteps) : () => false,
      prepareStep: ({ messages: stepMessages, stepNumber }) => {
        if (stepNumber < 2) return undefined
        const pruned = pruneInTurnStepMessages(stepMessages, contextWindow, systemPrompt)
        return pruned === stepMessages ? undefined : { messages: pruned }
      },
      abortSignal: options.abortSignal,
    })

    for await (const part of result.fullStream) {
      if (options.abortSignal?.aborted || part.type === 'abort') break
      if (part.type === 'reasoning-delta') {
        reasoning += part.text
        appendTimelineDelta(steps, 'reasoning', part.text)
        emit({ type: 'reasoning_delta', text: part.text })
      } else if (part.type === 'text-delta') {
        content += part.text
        appendTimelineDelta(steps, 'text', part.text)
        emit({ type: 'text_delta', text: part.text })
      } else if (part.type === 'finish-step') {
        const stepInput = part.usage?.inputTokens
        if (typeof stepInput === 'number' && Number.isFinite(stepInput) && stepInput > 0) {
          reportedInputTokens = stepInput
          emit({ type: 'usage', inputTokens: reportedInputTokens, contextWindow })
        }
      } else if (part.type === 'error') {
        throw part.error
      }
    }

    const finalInputTokens =
      reportedInputTokens > 0
        ? reportedInputTokens
        : initialEstimatedTokens +
          estimateTextTokens(content) +
          steps
            .filter((s): s is Extract<AgentStepRecord, { type: 'tool' }> => s.type === 'tool')
            .reduce((acc, s) => acc + estimateTextTokens(JSON.stringify(s.result)), 0)

    if (reportedInputTokens === 0 && !options.abortSignal?.aborted) {
      emit({ type: 'usage', inputTokens: finalInputTokens, contextWindow })
    }

    if (options.abortSignal?.aborted) {
      const { proposal, supersededProposalMessageId } = finalizeProposal(true)
      emit({ type: 'done', stopped: true })
      return {
        content,
        reasoning,
        steps,
        toolCalls,
        proposal,
        supersededProposalMessageId,
        compaction: compactionResult,
        usage: { inputTokens: finalInputTokens, contextWindow },
        stopped: true,
        error: null,
      }
    }

    const { proposal, supersededProposalMessageId } = finalizeProposal(false)
    emit({ type: 'done', stopped: false })
    return {
      content,
      reasoning,
      steps,
      toolCalls,
      proposal,
      supersededProposalMessageId,
      compaction: compactionResult,
      usage: { inputTokens: finalInputTokens, contextWindow },
      stopped: false,
      error: null,
    }
  } catch (error) {
    if (options.abortSignal?.aborted) {
      const { proposal, supersededProposalMessageId } = finalizeProposal(true)
      emit({ type: 'done', stopped: true })
      return {
        content,
        reasoning,
        steps,
        toolCalls,
        proposal,
        supersededProposalMessageId,
        compaction: compactionResult,
        usage: { inputTokens: reportedInputTokens, contextWindow },
        stopped: true,
        error: null,
      }
    }
    const classified = classifyProviderError(error)
    emit({ type: 'error', code: classified.code, message: classified.message })
    return {
      content,
      reasoning,
      steps,
      toolCalls,
      proposal: null,
      supersededProposalMessageId: null,
      compaction: compactionResult,
      usage: { inputTokens: reportedInputTokens, contextWindow },
      stopped: false,
      error: classified,
    }
  }
}
