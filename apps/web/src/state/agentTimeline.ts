import type { AgentToolName } from '@booksmith/core'
import type { AgentMessageDto, AgentTimelineItem, AgentToolCallDto } from '../api/client'

/**
 * Pure projection from raw Agent timeline events to the collapsed process-drawer +
 * final-reply view model, with strict per-reasoning-block active state isolation.
 * See ADR 2026-11-22-agent-chat-process-drawer-ui.
 */

export const AGENT_TOOL_LABELS: Record<AgentToolName, string> = {
  list_files: '列出书籍文件',
  read_file: '读取文件',
  search_book: '检索全书',
  lint_book: '检查全书结构',
  get_metadata: '读取元数据',
  get_toc: '读取目录',
  scan_headings: '扫描正文标题',
  edit_file: '编辑文件',
  write_file: '写入文件',
  update_metadata: '更新元数据',
  update_toc: '更新目录',
  generate_toc: '生成目录',
  edit_toc: '调整目录结构',
  create_chapter: '新建章节',
  rename_file: '重命名文件',
  delete_file: '删除文件',
  split_chapter: '拆分章节',
  merge_chapters: '合并章节',
  link_stylesheets: '关联样式表',
  create_stylesheet: '新建样式表',
  cleanup_unused_resources: '清理未引用资源',
}

export interface RunningToolCall {
  id: string
  name: AgentToolName
  argsSummary: string
}

export type ProcessStep =
  | {
      kind: 'reasoning'
      key: string
      text: string
      status: 'active' | 'done'
    }
  | {
      kind: 'tool'
      key: string
      id: string
      name: AgentToolName
      argsSummary: string
      status: 'running' | 'ok' | 'error'
      summary: string
    }
  | {
      kind: 'note'
      key: string
      text: string
    }

export interface ProcessStats {
  reasoningCount: number
  toolCount: number
  failedToolCount: number
  noteCount: number
  completedCount: number
}

export interface AgentTurnView {
  processSteps: ProcessStep[]
  finalText: string | null
  hasProcess: boolean
  isStreaming: boolean
  isProcessLive: boolean
  stats: ProcessStats
  liveLabel: string | null
  summaryLabel: string
}

type NormalizedEntry =
  | { kind: 'reasoning'; text: string }
  | { kind: 'text'; text: string }
  | {
      kind: 'tool'
      id: string
      name: AgentToolName
      argsSummary: string
      status: 'running' | 'ok' | 'error'
      summary: string
    }

export function appendTimelineDelta(
  timeline: AgentTimelineItem[],
  type: 'reasoning' | 'text',
  delta: string,
): AgentTimelineItem[] {
  if (!delta) return timeline
  const last = timeline[timeline.length - 1]
  if (last && last.type === type) {
    return [...timeline.slice(0, -1), { type, text: last.text + delta }]
  }
  return [...timeline, { type, text: delta }]
}

export function extractLegacyTimeline(msg: Pick<AgentMessageDto, 'timeline' | 'toolCalls' | 'reasoning' | 'content'>): AgentTimelineItem[] {
  if (Array.isArray(msg.timeline) && msg.timeline.length > 0) {
    return msg.timeline
  }
  const fallback: AgentTimelineItem[] = []
  if (msg.reasoning && msg.reasoning.trim()) {
    fallback.push({ type: 'reasoning', text: msg.reasoning })
  }
  for (const call of msg.toolCalls) {
    fallback.push({
      type: 'tool',
      id: call.id,
      name: call.name,
      argsSummary: call.argsSummary,
      ok: call.ok,
      summary: call.summary,
    })
  }
  if (msg.content) {
    fallback.push({ type: 'text', text: msg.content })
  }
  return fallback
}

function normalizeEntries(
  timeline: readonly AgentTimelineItem[],
  runningTools: readonly RunningToolCall[],
): NormalizedEntry[] {
  const entries: NormalizedEntry[] = []
  const finishedToolIds = new Set<string>()

  for (const item of timeline) {
    if (item.type === 'reasoning') {
      if (!item.text.trim()) continue
      const prev = entries[entries.length - 1]
      if (prev && prev.kind === 'reasoning') {
        prev.text += item.text
      } else {
        entries.push({ kind: 'reasoning', text: item.text })
      }
    } else if (item.type === 'text') {
      if (!item.text.trim()) continue
      const prev = entries[entries.length - 1]
      if (prev && prev.kind === 'text') {
        prev.text += item.text
      } else {
        entries.push({ kind: 'text', text: item.text })
      }
    } else if (item.type === 'tool') {
      finishedToolIds.add(item.id)
      entries.push({
        kind: 'tool',
        id: item.id,
        name: item.name,
        argsSummary: item.argsSummary,
        status: item.ok ? 'ok' : 'error',
        summary: item.summary,
      })
    }
  }

  for (const running of runningTools) {
    if (finishedToolIds.has(running.id)) continue
    entries.push({
      kind: 'tool',
      id: running.id,
      name: running.name,
      argsSummary: running.argsSummary,
      status: 'running',
      summary: '',
    })
  }

  return entries
}

export function summarizeProcessSteps(steps: readonly ProcessStep[]): { stats: ProcessStats; summaryLabel: string } {
  let reasoningCount = 0
  let toolCount = 0
  let failedToolCount = 0
  let noteCount = 0
  let completedCount = 0
  let singleReasoningLength = 0

  for (const step of steps) {
    if (step.kind === 'reasoning') {
      reasoningCount += 1
      singleReasoningLength = step.text.trim().length
      if (step.status === 'done') completedCount += 1
    } else if (step.kind === 'tool') {
      toolCount += 1
      if (step.status === 'error') {
        failedToolCount += 1
        completedCount += 1
      } else if (step.status === 'ok') {
        completedCount += 1
      }
    } else if (step.kind === 'note') {
      noteCount += 1
      completedCount += 1
    }
  }

  const stats: ProcessStats = {
    reasoningCount,
    toolCount,
    failedToolCount,
    noteCount,
    completedCount,
  }

  if (reasoningCount === 1 && toolCount === 0 && noteCount === 0) {
    return { stats, summaryLabel: `已思考 · ${singleReasoningLength} 字` }
  }

  const parts: string[] = []
  if (reasoningCount > 0) parts.push(`思考 ${reasoningCount} 次`)
  if (toolCount > 0) parts.push(`调用 ${toolCount} 个工具`)
  if (failedToolCount > 0) parts.push(`${failedToolCount} 项失败`)
  if (parts.length === 0 && noteCount > 0) parts.push(`${noteCount} 条过程说明`)

  return {
    stats,
    summaryLabel: parts.length > 0 ? parts.join(' · ') : '执行过程',
  }
}

export function buildTurnView(options: {
  timeline: readonly AgentTimelineItem[]
  runningTools?: readonly RunningToolCall[]
  isStreaming?: boolean
}): AgentTurnView {
  const isStreaming = Boolean(options.isStreaming)
  const runningTools = options.runningTools ?? []
  const entries = normalizeEntries(options.timeline, isStreaming ? runningTools : [])

  // During streaming, only a tail text segment renders live outside the drawer; if a tool or
  // reasoning step starts after it, that earlier text folds into processSteps as a note.
  // Once finished, promote the last text segment (even if followed by trailing tools) so a
  // turn that spoke before editing never renders an empty reply.
  let finalTextIndex = -1
  if (isStreaming) {
    const lastIdx = entries.length - 1
    if (lastIdx >= 0 && entries[lastIdx]!.kind === 'text') {
      finalTextIndex = lastIdx
    }
  } else {
    for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
      if (entries[idx]!.kind === 'text') {
        finalTextIndex = idx
        break
      }
    }
  }

  const processSteps: ProcessStep[] = []
  let reasoningSeq = 0
  let noteSeq = 0

  for (let idx = 0; idx < entries.length; idx += 1) {
    const entry = entries[idx]!
    if (idx === finalTextIndex) continue

    if (entry.kind === 'reasoning') {
      // Strictly isolate active thinking state to the single tail reasoning block while streaming.
      // Any subsequent tool (running or finished), note, text, or newer reasoning block immediately
      // settles all earlier reasoning blocks to 'done'.
      const isActive = isStreaming && idx === entries.length - 1
      processSteps.push({
        kind: 'reasoning',
        key: `reasoning-${reasoningSeq}`,
        text: entry.text.trim(),
        status: isActive ? 'active' : 'done',
      })
      reasoningSeq += 1
    } else if (entry.kind === 'tool') {
      processSteps.push({
        kind: 'tool',
        key: `tool-${entry.id}`,
        id: entry.id,
        name: entry.name,
        argsSummary: entry.argsSummary,
        status: entry.status,
        summary: entry.summary,
      })
    } else if (entry.kind === 'text') {
      processSteps.push({
        kind: 'note',
        key: `note-${noteSeq}`,
        text: entry.text.trim(),
      })
      noteSeq += 1
    }
  }

  const finalText = finalTextIndex >= 0 ? (entries[finalTextIndex] as { kind: 'text'; text: string }).text : null
  const { stats, summaryLabel } = summarizeProcessSteps(processSteps)
  const isProcessLive = isStreaming && finalText === null

  let liveLabel: string | null = null
  if (isProcessLive) {
    const progressSuffix = stats.completedCount > 0 ? ` · 已完成 ${stats.completedCount} 步` : ''
    const activeTools = processSteps.filter(
      (s): s is Extract<ProcessStep, { kind: 'tool' }> => s.kind === 'tool' && s.status === 'running',
    )
    const activeReasoning = processSteps.find((s) => s.kind === 'reasoning' && s.status === 'active')

    if (activeTools.length > 0) {
      const currentTool = activeTools[activeTools.length - 1]!
      const label = AGENT_TOOL_LABELS[currentTool.name] ?? currentTool.name
      const args = currentTool.argsSummary ? `（${currentTool.argsSummary}）` : ''
      const parallelSuffix = activeTools.length > 1 ? ` 等 ${activeTools.length} 项` : ''
      liveLabel = `正在${label}${args}${parallelSuffix}…${progressSuffix}`
    } else if (activeReasoning) {
      liveLabel = `正在深度思考…${progressSuffix}`
    } else if (processSteps.length > 0) {
      liveLabel = `正在继续处理…${progressSuffix}`
    } else {
      liveLabel = '正在思考…'
    }
  }

  return {
    processSteps,
    finalText,
    hasProcess: processSteps.length > 0 || isProcessLive,
    isStreaming,
    isProcessLive,
    stats,
    liveLabel,
    summaryLabel,
  }
}

export function buildMessageTurnView(msg: AgentMessageDto): AgentTurnView {
  return buildTurnView({
    timeline: extractLegacyTimeline(msg),
    isStreaming: false,
  })
}

export function applyToolEndToRunning(
  runningTools: readonly RunningToolCall[],
  event: { id: string; name: AgentToolName; ok: boolean; summary: string },
): { nextRunning: RunningToolCall[]; completedCall: AgentToolCallDto } {
  const matched = runningTools.find((t) => t.id === event.id)
  const nextRunning = runningTools.filter((t) => t.id !== event.id)
  return {
    nextRunning,
    completedCall: {
      id: event.id,
      name: event.name,
      argsSummary: matched?.argsSummary ?? event.name,
      ok: event.ok,
      summary: event.summary,
    },
  }
}
