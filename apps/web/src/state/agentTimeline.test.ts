import { describe, expect, it } from 'vitest'
import type { AgentMessageDto, AgentTimelineItem } from '../api/client'
import {
  appendTimelineDelta,
  applyToolEndToRunning,
  buildMessageTurnView,
  buildTurnView,
  type RunningToolCall,
} from './agentTimeline'

function makeMessage(overrides: Partial<AgentMessageDto>): AgentMessageDto {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    role: 'assistant',
    content: '',
    reasoning: null,
    context: null,
    timeline: undefined,
    toolCalls: [],
    proposal: null,
    proposalStatus: null,
    compactionNotice: null,
    error: null,
    createdAt: '2026-11-22T00:00:00.000Z',
    ...overrides,
  }
}

describe('agentTimeline', () => {
  it('merges consecutive deltas of the same kind and splits across other kinds', () => {
    let timeline: AgentTimelineItem[] = []
    timeline = appendTimelineDelta(timeline, 'reasoning', '先分析')
    timeline = appendTimelineDelta(timeline, 'reasoning', '第一章。')
    timeline = [
      ...timeline,
      {
        type: 'tool',
        id: 't1',
        name: 'read_file',
        argsSummary: 'ch001.xhtml',
        ok: true,
        summary: '已读取 24 行',
      },
    ]
    timeline = appendTimelineDelta(timeline, 'reasoning', '再核对目录。')

    expect(timeline).toHaveLength(3)
    expect(timeline[0]).toEqual({ type: 'reasoning', text: '先分析第一章。' })
    expect(timeline[2]).toEqual({ type: 'reasoning', text: '再核对目录。' })
  })

  it('strictly isolates active thinking state across multiple reasoning blocks during streaming', () => {
    // Frame 1: reasoning #1 is streaming
    const frame1 = buildTurnView({
      timeline: [{ type: 'reasoning', text: '第一步思考：先查第一章' }],
      isStreaming: true,
    })
    expect(frame1.isProcessLive).toBe(true)
    expect(frame1.liveLabel).toBe('正在深度思考…')
    expect(frame1.finalText).toBeNull()
    expect(frame1.processSteps).toEqual([
      { kind: 'reasoning', key: 'reasoning-0', text: '第一步思考：先查第一章', status: 'active' },
    ])

    // Frame 2: tool #1 starts -> reasoning #1 MUST immediately become 'done'
    const frame2 = buildTurnView({
      timeline: [{ type: 'reasoning', text: '第一步思考：先查第一章' }],
      runningTools: [{ id: 'c1', name: 'read_file', argsSummary: 'EPUB/text/ch001.xhtml' }],
      isStreaming: true,
    })
    expect(frame2.processSteps).toMatchObject([
      { kind: 'reasoning', key: 'reasoning-0', status: 'done' },
      { kind: 'tool', key: 'tool-c1', status: 'running', argsSummary: 'EPUB/text/ch001.xhtml' },
    ])
    expect(frame2.liveLabel).toBe('正在读取文件（EPUB/text/ch001.xhtml）… · 已完成 1 步')

    // Frame 3: tool #1 completes, reasoning #2 starts -> ONLY reasoning #2 is 'active', reasoning #1 stays 'done'
    const frame3 = buildTurnView({
      timeline: [
        { type: 'reasoning', text: '第一步思考：先查第一章' },
        {
          type: 'tool',
          id: 'c1',
          name: 'read_file',
          argsSummary: 'EPUB/text/ch001.xhtml',
          ok: true,
          summary: '读取成功',
        },
        { type: 'reasoning', text: '第二步思考：准备修正标点' },
      ],
      isStreaming: true,
    })
    expect(frame3.processSteps).toMatchObject([
      { kind: 'reasoning', key: 'reasoning-0', status: 'done' },
      { kind: 'tool', key: 'tool-c1', status: 'ok' },
      { kind: 'reasoning', key: 'reasoning-1', status: 'active' },
    ])
    expect(frame3.liveLabel).toBe('正在深度思考… · 已完成 2 步')

    // Frame 4: final answer starts streaming -> both reasoning blocks are 'done', finalText renders outside
    const frame4 = buildTurnView({
      timeline: [
        { type: 'reasoning', text: '第一步思考：先查第一章' },
        {
          type: 'tool',
          id: 'c1',
          name: 'read_file',
          argsSummary: 'EPUB/text/ch001.xhtml',
          ok: true,
          summary: '读取成功',
        },
        { type: 'reasoning', text: '第二步思考：准备修正标点' },
        { type: 'text', text: '已完成第一章校对。' },
      ],
      isStreaming: true,
    })
    expect(frame4.isProcessLive).toBe(false)
    expect(frame4.liveLabel).toBeNull()
    expect(frame4.finalText).toBe('已完成第一章校对。')
    expect(frame4.processSteps.filter((s) => s.kind === 'reasoning').every((s) => s.status === 'done')).toBe(true)
    expect(frame4.summaryLabel).toBe('思考 2 次 · 调用 1 个工具')
  })

  it('folds intermediate text before tools into processSteps and keeps only the final message outside', () => {
    const timeline: AgentTimelineItem[] = [
      { type: 'text', text: '先定位并修改第一处。' },
      {
        type: 'tool',
        id: 'call_1',
        name: 'edit_file',
        argsSummary: 'EPUB/text/ch001.xhtml',
        ok: true,
        summary: '已替换 1 处',
      },
      { type: 'text', text: '第一轮润色已完成，可先审阅或直接继续微调。' },
    ]

    // Mid-stream right after tool starts following intermediate text: intermediate text moves into processSteps
    const midStream = buildTurnView({
      timeline: [{ type: 'text', text: '先定位并修改第一处。' }],
      runningTools: [{ id: 'call_1', name: 'edit_file', argsSummary: 'EPUB/text/ch001.xhtml' }],
      isStreaming: true,
    })
    expect(midStream.finalText).toBeNull()
    expect(midStream.processSteps).toMatchObject([
      { kind: 'note', key: 'note-0', text: '先定位并修改第一处。' },
      { kind: 'tool', key: 'tool-call_1', status: 'running' },
    ])

    // Completed turn: only final text stays outside; intermediate note + tool live inside processSteps
    const settled = buildTurnView({ timeline, isStreaming: false })
    expect(settled.finalText).toBe('第一轮润色已完成，可先审阅或直接继续微调。')
    expect(settled.processSteps).toEqual([
      { kind: 'note', key: 'note-0', text: '先定位并修改第一处。' },
      {
        kind: 'tool',
        key: 'tool-call_1',
        id: 'call_1',
        name: 'edit_file',
        argsSummary: 'EPUB/text/ch001.xhtml',
        status: 'ok',
        summary: '已替换 1 处',
      },
    ])
    expect(settled.summaryLabel).toBe('调用 1 个工具')
  })

  it('promotes the last text segment when a finished turn has trailing tools and no closing text', () => {
    const view = buildTurnView({
      timeline: [
        { type: 'text', text: '我已直接修正第一章标题。' },
        {
          type: 'tool',
          id: 'call_edit',
          name: 'edit_file',
          argsSummary: 'ch001.xhtml',
          ok: true,
          summary: 'ok',
        },
      ],
      isStreaming: false,
    })

    expect(view.finalText).toBe('我已直接修正第一章标题。')
    expect(view.processSteps).toHaveLength(1)
    expect(view.processSteps[0]?.kind).toBe('tool')
  })

  it('surfaces failed tool count in summaryLabel and handles tool-only turns without an empty reply', () => {
    const view = buildTurnView({
      timeline: [
        { type: 'reasoning', text: '尝试读取缺失文件' },
        {
          type: 'tool',
          id: 't1',
          name: 'read_file',
          argsSummary: 'missing.xhtml',
          ok: false,
          summary: '文件不存在',
        },
      ],
      isStreaming: false,
    })

    expect(view.finalText).toBeNull()
    expect(view.hasProcess).toBe(true)
    expect(view.stats.failedToolCount).toBe(1)
    expect(view.summaryLabel).toBe('思考 1 次 · 调用 1 个工具 · 1 项失败')
  })

  it('tracks concurrent running tools without overwriting argsSummary', () => {
    const running: RunningToolCall[] = [
      { id: 'c1', name: 'read_file', argsSummary: 'ch001.xhtml' },
      { id: 'c2', name: 'read_file', argsSummary: 'ch002.xhtml' },
    ]
    const liveView = buildTurnView({ timeline: [], runningTools: running, isStreaming: true })
    expect(liveView.processSteps).toHaveLength(2)
    expect(liveView.liveLabel).toBe('正在读取文件（ch002.xhtml） 等 2 项…')

    const { nextRunning, completedCall } = applyToolEndToRunning(running, {
      id: 'c1',
      name: 'read_file',
      ok: true,
      summary: '20 行',
    })
    expect(completedCall.argsSummary).toBe('ch001.xhtml')
    expect(nextRunning).toEqual([{ id: 'c2', name: 'read_file', argsSummary: 'ch002.xhtml' }])
  })

  it('falls back cleanly for legacy messages without timeline field', () => {
    const legacy = makeMessage({
      reasoning: '核对只读边界',
      content: '只读顾问回复：建议统一全角引号。',
      toolCalls: [
        { id: 'old-1', name: 'lint_book', argsSummary: '', ok: true, summary: '0 错误' },
      ],
    })
    const view = buildMessageTurnView(legacy)
    expect(view.finalText).toBe('只读顾问回复：建议统一全角引号。')
    expect(view.processSteps.map((s) => s.kind)).toEqual(['reasoning', 'tool'])
    expect(view.summaryLabel).toBe('思考 1 次 · 调用 1 个工具')
  })

  it('renders a waiting status row when streaming starts before first token arrives', () => {
    const waiting = buildTurnView({ timeline: [], isStreaming: true })
    expect(waiting.hasProcess).toBe(true)
    expect(waiting.isProcessLive).toBe(true)
    expect(waiting.liveLabel).toBe('正在思考…')
    expect(waiting.finalText).toBeNull()
  })
})
