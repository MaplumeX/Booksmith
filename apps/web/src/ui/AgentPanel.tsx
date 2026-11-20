import type { AgentProposal } from '@booksmith/core'
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Loader2,
  Plus,
  Send,
  SlidersHorizontal,
  Square,
  Trash2,
  Wrench,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiError,
  api,
  type AgentMessageDto,
  type AgentProfileDto,
  type AgentThreadDto,
  type AgentToolCallDto,
} from '../api/client'
import { basename } from '../state/bookStore'
import { AgentProposalCard } from './AgentProposalCard'
import { Button } from './Button'
import { EmptyState } from './EmptyState'

interface AgentPanelProps {
  bookId: string
  bookTitle: string
  bookVersion: number
  activePath: string | null
  selectionText: string
  profiles: AgentProfileDto[]
  profilesLoading: boolean
  undoMessageId: string | null
  getOverlay: () => { dirtyTexts: Record<string, string>; deletedPaths: string[] }
  onOpenSettings: () => void
  onReloadBook: () => void
  onApplyProposal: (messageId: string, proposal: AgentProposal, selectedPaths?: Set<string>) => Promise<boolean>
  onUndoProposal: (messageId: string) => void
}

interface StreamingState {
  content: string
  toolCalls: AgentToolCallDto[]
  runningTool: { id: string; name: string; argsSummary: string } | null
  proposal: AgentProposal | null
}

const STARTER_PROMPTS = [
  '检查全书结构问题，并说明哪些可以直接修复',
  '校对当前章节的错别字、标点与语病',
  '核对书籍 OPF 元数据和目录结构是否完整',
]

function ToolSteps({
  calls,
  running,
}: {
  calls: AgentToolCallDto[]
  running?: { id: string; name: string; argsSummary: string } | null
}) {
  const [open, setOpen] = useState(false)
  if (calls.length === 0 && !running) return null

  return (
    <div className="agent-tools-box">
      <button
        type="button"
        className="agent-tools-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {running ? (
          <Loader2 size={12} strokeWidth={1.75} className="spin" aria-hidden="true" />
        ) : (
          <Wrench size={12} strokeWidth={1.75} aria-hidden="true" />
        )}
        <span className="agent-tools-summary">
          {running
            ? `正在执行 ${running.name}（${running.argsSummary}）…`
            : `已执行 ${calls.length} 步工具调用`}
        </span>
        {open ? (
          <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <ChevronRight size={12} strokeWidth={1.75} aria-hidden="true" />
        )}
      </button>

      {open ? (
        <ul className="agent-tools-list">
          {calls.map((call) => (
            <li key={call.id} className={`agent-tool-item${call.ok ? '' : ' is-err'}`}>
              {call.ok ? (
                <Check size={12} strokeWidth={1.8} className="agent-icon-ok" aria-hidden="true" />
              ) : (
                <AlertCircle size={12} strokeWidth={1.8} className="agent-icon-err" aria-hidden="true" />
              )}
              <span className="agent-tool-name">{call.name}</span>
              <span className="agent-tool-args" title={call.argsSummary}>
                {call.argsSummary}
              </span>
              <span className="agent-tool-result" title={call.summary}>
                {call.summary}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function AgentPanel({
  bookId,
  bookTitle,
  bookVersion,
  activePath,
  selectionText,
  profiles,
  profilesLoading,
  undoMessageId,
  getOverlay,
  onOpenSettings,
  onReloadBook,
  onApplyProposal,
  onUndoProposal,
}: AgentPanelProps) {
  const [threads, setThreads] = useState<AgentThreadDto[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AgentMessageDto[]>([])
  const [threadsLoading, setThreadsLoading] = useState(true)
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [panelError, setPanelError] = useState<{ code: string; message: string } | null>(null)

  const [selectedProfileId, setSelectedProfileId] = useState<string>('')
  const [input, setInput] = useState('')
  const [attachFile, setAttachFile] = useState(true)
  const [attachSelection, setAttachSelection] = useState(true)
  const [streaming, setStreaming] = useState<StreamingState | null>(null)
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Keep selectedProfileId synced with available profiles & thread preference.
  useEffect(() => {
    if (profiles.length === 0) {
      setSelectedProfileId('')
      return
    }
    setSelectedProfileId((current) => {
      if (current && profiles.some((p) => p.id === current)) return current
      const def = profiles.find((p) => p.isDefault) ?? profiles[0]!
      return def.id
    })
  }, [profiles])

  // Re-enable selection chip whenever the user makes a fresh selection.
  useEffect(() => {
    if (selectionText.trim()) setAttachSelection(true)
  }, [selectionText])

  const loadMessages = useCallback(
    async (threadId: string) => {
      setMessagesLoading(true)
      setPanelError(null)
      try {
        const res = await api.agentThread(bookId, threadId)
        setMessages(res.messages)
        if (res.thread.profileId && profiles.some((p) => p.id === res.thread.profileId)) {
          setSelectedProfileId(res.thread.profileId)
        }
      } catch (cause) {
        setPanelError({
          code: cause instanceof ApiError ? cause.code : 'load_failed',
          message: '读取对话记录失败，请重试。',
        })
      } finally {
        setMessagesLoading(false)
      }
    },
    [bookId, profiles],
  )

  const loadThreads = useCallback(async () => {
    setThreadsLoading(true)
    setPanelError(null)
    try {
      const res = await api.agentThreads(bookId)
      setThreads(res.threads)
      const first = res.threads[0] ?? null
      setActiveThreadId(first?.id ?? null)
      if (first) {
        await loadMessages(first.id)
      } else {
        setMessages([])
      }
    } catch (cause) {
      setPanelError({
        code: cause instanceof ApiError ? cause.code : 'load_failed',
        message: '加载会话列表失败，请稍后重试。',
      })
    } finally {
      setThreadsLoading(false)
    }
  }, [bookId, loadMessages])

  useEffect(() => {
    void loadThreads()
    return () => {
      abortRef.current?.abort()
    }
  }, [bookId])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages.length, streaming?.content, streaming?.toolCalls.length])

  const handleSelectThread = (threadId: string) => {
    if (streaming || threadId === activeThreadId) return
    setActiveThreadId(threadId)
    void loadMessages(threadId)
  }

  const handleCreateThread = async (): Promise<AgentThreadDto | null> => {
    if (streaming) return null
    setPanelError(null)
    try {
      const res = await api.createAgentThread(bookId, {
        ...(selectedProfileId ? { profileId: selectedProfileId } : {}),
      })
      setThreads((current) => [res.thread, ...current])
      setActiveThreadId(res.thread.id)
      setMessages([])
      return res.thread
    } catch {
      setPanelError({ code: 'create_failed', message: '创建新对话失败，请重试。' })
      return null
    }
  }

  const handleDeleteThread = async () => {
    if (!activeThreadId || streaming) return
    const removing = activeThreadId
    setPanelError(null)
    try {
      await api.deleteAgentThread(bookId, removing)
      const remaining = threads.filter((t) => t.id !== removing)
      setThreads(remaining)
      const next = remaining[0] ?? null
      setActiveThreadId(next?.id ?? null)
      if (next) await loadMessages(next.id)
      else setMessages([])
    } catch {
      setPanelError({ code: 'delete_failed', message: '删除对话失败，请重试。' })
    }
  }

  const sendPrompt = async (promptText: string) => {
    const text = promptText.trim()
    if (!text || streaming || profiles.length === 0) return

    setPanelError(null)
    let threadId = activeThreadId
    if (!threadId) {
      const created = await handleCreateThread()
      if (!created) return
      threadId = created.id
    }

    const context = {
      activePath: attachFile ? activePath : null,
      selection: attachSelection && selectionText.trim() ? selectionText.trim() : null,
    }

    const optimisticUser: AgentMessageDto = {
      id: `local-${Date.now()}`,
      threadId,
      role: 'user',
      content: text,
      context,
      toolCalls: [],
      proposal: null,
      proposalStatus: null,
      error: null,
      createdAt: new Date().toISOString(),
    }

    setInput('')
    setMessages((current) => [...current, optimisticUser])

    const controller = new AbortController()
    abortRef.current = controller

    const draft: StreamingState = {
      content: '',
      toolCalls: [],
      runningTool: null,
      proposal: null,
    }
    setStreaming({ ...draft })

    const { dirtyTexts, deletedPaths } = getOverlay()

    let finalMessageId: string | undefined
    let streamError: { code: string; message: string } | null = null

    try {
      await api.streamAgentMessage(
        bookId,
        threadId,
        {
          content: text,
          ...(selectedProfileId ? { profileId: selectedProfileId } : {}),
          baseVersion: bookVersion,
          dirtyTexts,
          deletedPaths,
          context,
        },
        {
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type === 'text_delta') {
              draft.content += event.text
              setStreaming({ ...draft })
            } else if (event.type === 'tool_start') {
              draft.runningTool = { id: event.id, name: event.name, argsSummary: event.argsSummary }
              setStreaming({ ...draft })
            } else if (event.type === 'tool_end') {
              const argsSummary =
                draft.runningTool?.id === event.id ? draft.runningTool.argsSummary : event.name
              draft.runningTool = null
              draft.toolCalls = [
                ...draft.toolCalls,
                { id: event.id, name: event.name, argsSummary, ok: event.ok, summary: event.summary },
              ]
              setStreaming({ ...draft })
            } else if (event.type === 'proposal') {
              draft.proposal = event.proposal
              setStreaming({ ...draft })
            } else if (event.type === 'error') {
              streamError = { code: event.code, message: event.message }
            } else if (event.type === 'done') {
              finalMessageId = event.messageId
              if (event.threadTitle) {
                setThreads((list) =>
                  list.map((t) => (t.id === threadId ? { ...t, title: event.threadTitle! } : t)),
                )
              }
            }
          },
        },
      )

      const finalized: AgentMessageDto = {
        id: finalMessageId ?? `assistant-${Date.now()}`,
        threadId,
        role: 'assistant',
        content: draft.content,
        context: null,
        toolCalls: draft.toolCalls,
        proposal: draft.proposal,
        proposalStatus: draft.proposal ? 'pending' : null,
        error: streamError ? (streamError as { message: string }).message : null,
        createdAt: new Date().toISOString(),
      }
      setMessages((current) => [...current, finalized])
    } catch (cause) {
      if (controller.signal.aborted) {
        if (draft.content || draft.toolCalls.length > 0) {
          setMessages((current) => [
            ...current,
            {
              id: `stopped-${Date.now()}`,
              threadId: threadId!,
              role: 'assistant',
              content: draft.content || '已停止生成。',
              context: null,
              toolCalls: draft.toolCalls,
              proposal: null,
              proposalStatus: null,
              error: null,
              createdAt: new Date().toISOString(),
            },
          ])
        }
      } else if (cause instanceof ApiError) {
        const payload = cause.payload as { message?: string } | undefined
        setPanelError({
          code: cause.code,
          message: payload?.message ?? `请求失败（${cause.code}）`,
        })
        // Roll back optimistic user bubble when request was rejected pre-stream (e.g. 409 / 503).
        setMessages((current) => current.filter((m) => m.id !== optimisticUser.id))
        setInput(text)
      } else {
        setPanelError({ code: 'network_error', message: '流式连接中断，请稍后重试。' })
      }
    } finally {
      abortRef.current = null
      setStreaming(null)
    }
  }

  const handleProposalApply = async (
    messageId: string,
    proposal: AgentProposal,
    selectedPaths?: Set<string>,
  ) => {
    setBusyProposalId(messageId)
    try {
      const ok = await onApplyProposal(messageId, proposal, selectedPaths)
      if (ok) {
        setMessages((list) =>
          list.map((msg) => (msg.id === messageId ? { ...msg, proposalStatus: 'applied' } : msg)),
        )
      }
    } finally {
      setBusyProposalId(null)
    }
  }

  const handleProposalDismiss = async (messageId: string) => {
    setBusyProposalId(messageId)
    try {
      await api.updateProposalStatus(bookId, messageId, 'dismissed')
      setMessages((list) =>
        list.map((msg) => (msg.id === messageId ? { ...msg, proposalStatus: 'dismissed' } : msg)),
      )
    } catch {
      setPanelError({ code: 'dismiss_failed', message: '更新提案状态失败，请重试。' })
    } finally {
      setBusyProposalId(null)
    }
  }

  const isLoadingInit = profilesLoading || threadsLoading

  return (
    <div className="agent-panel">
      <div className="agent-toolbar">
        {profiles.length > 0 ? (
          <>
            <select
              className="agent-thread-select"
              aria-label="切换对话"
              disabled={Boolean(streaming) || threads.length === 0}
              value={activeThreadId ?? ''}
              onChange={(event) => handleSelectThread(event.target.value)}
            >
              {threads.length === 0 ? (
                <option value="">新对话</option>
              ) : (
                threads.map((thread) => (
                  <option key={thread.id} value={thread.id}>
                    {thread.title}
                  </option>
                ))
              )}
            </select>
            <button
              type="button"
              className="agent-icon-btn"
              title="新建对话"
              aria-label="新建对话"
              disabled={Boolean(streaming)}
              onClick={() => void handleCreateThread()}
            >
              <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
            {activeThreadId ? (
              <button
                type="button"
                className="agent-icon-btn"
                title="删除当前对话"
                aria-label="删除当前对话"
                disabled={Boolean(streaming)}
                onClick={() => void handleDeleteThread()}
              >
                <Trash2 size={13} strokeWidth={1.7} aria-hidden="true" />
              </button>
            ) : null}
          </>
        ) : (
          <span className="agent-toolbar-title">EPUB 编辑助手</span>
        )}
        <button
          type="button"
          className="agent-icon-btn"
          title="模型预设设置"
          aria-label="模型预设设置"
          onClick={onOpenSettings}
        >
          <SlidersHorizontal size={14} strokeWidth={1.7} aria-hidden="true" />
        </button>
      </div>

      {isLoadingInit ? (
        <div className="agent-body agent-loading" aria-busy="true" aria-label="正在加载助手">
          <span className="skeleton-line" />
          <span className="skeleton-line short" />
          <span className="skeleton-line" />
        </div>
      ) : profiles.length === 0 ? (
        <div className="agent-body agent-empty-wrap">
          <EmptyState
            title="配置模型以启用助手"
            description="支持 OpenAI 兼容接口（含 DeepSeek、Ollama）与 Anthropic，API Key 加密存放在服务端。"
            action={
              <Button variant="primary" type="button" onClick={onOpenSettings}>
                配置模型预设
              </Button>
            }
          />
        </div>
      ) : (
        <>
          <div className="agent-body" ref={scrollRef}>
            {messagesLoading ? (
              <div className="agent-loading" aria-busy="true" aria-label="正在载入消息">
                <span className="skeleton-line" />
                <span className="skeleton-line short" />
              </div>
            ) : messages.length === 0 && !streaming ? (
              <div className="agent-welcome">
                <p className="agent-welcome-title">当前书籍：{bookTitle}</p>
                <p className="agent-welcome-desc">
                  可以直接阅读、检索、校对、修复结构报错、整理目录与重命名章节；所有改动会先生成 Diff 提案由你审阅后应用。
                </p>
                <div className="agent-starters">
                  {STARTER_PROMPTS.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      className="agent-starter-btn"
                      onClick={() => void sendPrompt(prompt)}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="agent-messages">
                {messages.map((msg) => (
                  <article key={msg.id} className={`agent-msg is-${msg.role}`}>
                    <header className="agent-msg-meta">
                      <span className="agent-msg-role">{msg.role === 'user' ? '你' : '助手'}</span>
                      {msg.context?.activePath ? (
                        <span className="agent-msg-ctx" title={msg.context.activePath}>
                          {basename(msg.context.activePath)}
                        </span>
                      ) : null}
                    </header>

                    {msg.role === 'assistant' ? <ToolSteps calls={msg.toolCalls} /> : null}

                    {msg.content ? <div className="agent-msg-text">{msg.content}</div> : null}

                    {msg.error ? (
                      <p className="banner banner-error agent-inline-banner" role="alert">
                        <AlertCircle size={13} strokeWidth={1.75} aria-hidden="true" />
                        <span>{msg.error}</span>
                      </p>
                    ) : null}

                    {msg.proposal && msg.proposalStatus ? (
                      <AgentProposalCard
                        proposal={msg.proposal}
                        status={msg.proposalStatus}
                        canUndo={undoMessageId === msg.id}
                        busy={busyProposalId === msg.id}
                        onApply={(paths) => void handleProposalApply(msg.id, msg.proposal!, paths)}
                        onDismiss={() => void handleProposalDismiss(msg.id)}
                        onUndo={() => onUndoProposal(msg.id)}
                      />
                    ) : null}
                  </article>
                ))}

                {streaming ? (
                  <article className="agent-msg is-assistant is-streaming" aria-live="polite">
                    <header className="agent-msg-meta">
                      <span className="agent-msg-role">助手</span>
                      <Loader2 size={12} strokeWidth={1.75} className="spin" aria-hidden="true" />
                    </header>
                    <ToolSteps calls={streaming.toolCalls} running={streaming.runningTool} />
                    {streaming.content ? (
                      <div className="agent-msg-text">{streaming.content}</div>
                    ) : !streaming.runningTool ? (
                      <p className="agent-thinking">正在思考…</p>
                    ) : null}
                  </article>
                ) : null}
              </div>
            )}
          </div>

          <div className="agent-composer-wrap">
            {panelError ? (
              <div className="banner banner-error agent-inline-banner" role="alert">
                <AlertCircle size={13} strokeWidth={1.75} aria-hidden="true" />
                <span>{panelError.message}</span>
                {panelError.code === 'version_conflict' ? (
                  <button type="button" className="banner-action" onClick={onReloadBook}>
                    重新加载书籍
                  </button>
                ) : panelError.code === 'agent_secret_not_configured' ||
                  panelError.code === 'agent_key_decrypt_failed' ? (
                  <button type="button" className="banner-action" onClick={onOpenSettings}>
                    模型设置
                  </button>
                ) : null}
              </div>
            ) : null}

            {(activePath && attachFile) || (selectionText.trim() && attachSelection) ? (
              <div className="agent-context-chips">
                {activePath && attachFile ? (
                  <span className="agent-context-chip" title={activePath}>
                    <FileText size={11} strokeWidth={1.75} aria-hidden="true" />
                    <span>{basename(activePath)}</span>
                    <button
                      type="button"
                      aria-label="移除当前文件上下文"
                      onClick={() => setAttachFile(false)}
                    >
                      <X size={11} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  </span>
                ) : null}
                {selectionText.trim() && attachSelection ? (
                  <span className="agent-context-chip">
                    <span>选中片段（{selectionText.trim().length} 字）</span>
                    <button
                      type="button"
                      aria-label="移除选中片段上下文"
                      onClick={() => setAttachSelection(false)}
                    >
                      <X size={11} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  </span>
                ) : null}
              </div>
            ) : null}

            <textarea
              className="agent-textarea"
              rows={3}
              aria-label="向助手输入指令"
              placeholder="输入校对、样式、目录或结构修改指令（Enter 发送，Shift+Enter 换行）"
              value={input}
              disabled={Boolean(streaming)}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void sendPrompt(input)
                }
              }}
            />

            <div className="agent-composer-bar">
              <select
                className="agent-model-select"
                aria-label="选择模型预设"
                disabled={Boolean(streaming)}
                value={selectedProfileId}
                onChange={(event) => setSelectedProfileId(event.target.value)}
              >
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}（{profile.model}）
                  </option>
                ))}
              </select>

              {streaming ? (
                <Button
                  variant="danger"
                  size="sm"
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                >
                  <Square size={12} strokeWidth={2} aria-hidden="true" />
                  <span>停止</span>
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  type="button"
                  disabled={!input.trim()}
                  onClick={() => void sendPrompt(input)}
                >
                  <Send size={12} strokeWidth={1.75} aria-hidden="true" />
                  <span>发送</span>
                </Button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
