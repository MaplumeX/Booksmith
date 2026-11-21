import type { AgentProposal, AgentToolName } from '@booksmith/core'
import {
  AlertCircle,
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  FileText,
  History,
  ListTree,
  Loader2,
  Pencil,
  Plus,
  Quote,
  RotateCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Wrench,
  X,
  Zap,
} from 'lucide-react'
import { DropdownMenu, Popover } from 'radix-ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ApiError,
  api,
  type AgentApprovalMode,
  type AgentMessageDto,
  type AgentProfileDto,
  type AgentThreadDto,
  type AgentToolCallDto,
} from '../api/client'
import { evaluateAutoApply } from '../state/agentProposal'
import { basename } from '../state/bookStore'
import { AgentMarkdown } from './AgentMarkdown'
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
  defaultApprovalMode?: AgentApprovalMode
  undoMessageId: string | null
  getOverlay: () => { dirtyTexts: Record<string, string>; deletedPaths: string[] }
  onOpenSettings: () => void
  onClose?: () => void
  onReloadBook: () => void
  onApplyProposal: (messageId: string, proposal: AgentProposal, selectedPaths?: Set<string>) => Promise<boolean>
  onUndoProposal: (messageId: string) => void
}

interface StreamingState {
  content: string
  reasoning: string
  toolCalls: AgentToolCallDto[]
  runningTool: { id: string; name: AgentToolName; argsSummary: string } | null
  proposal: AgentProposal | null
  replacingMessageId?: string
}

const APPROVAL_META: Record<
  AgentApprovalMode,
  { label: string; desc: string; icon: typeof ShieldCheck }
> = {
  ask: {
    label: '只读',
    desc: '仅开放查询工具，禁止任何写入修改',
    icon: Eye,
  },
  review: {
    label: '审阅',
    desc: '写操作生成 Diff 提案，确认后再应用',
    icon: ShieldCheck,
  },
  auto: {
    label: '自动',
    desc: '预检通过自动应用到工作区（可随时撤销）',
    icon: Zap,
  },
}

const APPROVAL_ORDER: AgentApprovalMode[] = ['ask', 'review', 'auto']

const TOOL_LABELS: Record<AgentToolName, string> = {
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

const STARTER_PROMPTS: Array<{ icon: typeof ShieldCheck; title: string; prompt: string }> = [
  {
    icon: ShieldCheck,
    title: '全书结构排查',
    prompt: '检查全书结构问题，并说明哪些可以直接修复',
  },
  {
    icon: FileText,
    title: '当前章节校对',
    prompt: '校对当前章节的错别字、标点与语病',
  },
  {
    icon: ListTree,
    title: '元数据与目录核对',
    prompt: '核对书籍 OPF 元数据和目录结构是否完整',
  },
]

function encodeModelChoice(profileId: string, model: string): string {
  return `${profileId}::${model}`
}

function decodeModelChoice(encoded: string): { profileId: string; model: string } | null {
  const sep = encoded.indexOf('::')
  if (sep <= 0) return null
  return { profileId: encoded.slice(0, sep), model: encoded.slice(sep + 2) }
}

function profileModelsOf(profile: AgentProfileDto): string[] {
  if (Array.isArray(profile.models) && profile.models.length > 0) {
    return profile.models.includes(profile.model) ? profile.models : [profile.model, ...profile.models]
  }
  return [profile.model]
}

function formatClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function formatThreadTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return formatClock(iso)
  }
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function summarizeCalls(calls: AgentToolCallDto[]): string {
  if (calls.length === 0) return ''
  const uniqueLabels: string[] = []
  for (const call of calls) {
    const label = TOOL_LABELS[call.name] ?? call.name
    if (!uniqueLabels.includes(label)) uniqueLabels.push(label)
  }
  const preview = uniqueLabels.slice(0, 2).join('、')
  const suffix = uniqueLabels.length > 2 ? ' 等' : ''
  return `已执行 ${calls.length} 步 · ${preview}${suffix}`
}

function ReasoningBlock({
  text,
  streaming = false,
  hasAnswer = false,
}: {
  text: string
  streaming?: boolean
  hasAnswer?: boolean
}) {
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const trimmed = text.trim()
  if (!trimmed) return null

  const autoOpen = streaming && !hasAnswer
  const open = userToggled ?? autoOpen

  return (
    <div className={`agent-reasoning-box${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="agent-reasoning-toggle"
        aria-expanded={open}
        onClick={() => setUserToggled((cur) => !(cur ?? autoOpen))}
      >
        {streaming && !hasAnswer ? (
          <Loader2 size={12} strokeWidth={1.8} className="spin agent-icon-accent" aria-hidden="true" />
        ) : (
          <Brain size={12} strokeWidth={1.75} className="agent-icon-muted" aria-hidden="true" />
        )}
        <span className="agent-reasoning-summary">
          {streaming && !hasAnswer ? '正在深度思考…' : `思考过程 · ${trimmed.length} 字`}
        </span>
        {open ? (
          <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <ChevronRight size={12} strokeWidth={1.75} aria-hidden="true" />
        )}
      </button>
      {open ? <div className="agent-reasoning-content">{trimmed}</div> : null}
    </div>
  )
}

function ToolSteps({
  calls,
  running,
}: {
  calls: AgentToolCallDto[]
  running?: { id: string; name: AgentToolName; argsSummary: string } | null
}) {
  const [open, setOpen] = useState(false)
  if (calls.length === 0 && !running) return null

  const hasError = calls.some((c) => !c.ok)
  const runningLabel = running ? TOOL_LABELS[running.name] ?? running.name : ''

  return (
    <div className={`agent-tools-box${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="agent-tools-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {running ? (
          <Loader2 size={12} strokeWidth={1.8} className="spin agent-icon-accent" aria-hidden="true" />
        ) : hasError ? (
          <AlertCircle size={12} strokeWidth={1.8} className="agent-icon-err" aria-hidden="true" />
        ) : (
          <Wrench size={12} strokeWidth={1.75} className="agent-icon-muted" aria-hidden="true" />
        )}
        <span className="agent-tools-summary">
          {running
            ? `正在${runningLabel}${running.argsSummary ? `（${running.argsSummary}）` : ''}…`
            : summarizeCalls(calls)}
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
              <span className="agent-tool-status" aria-hidden="true">
                {call.ok ? (
                  <Check size={12} strokeWidth={2} className="agent-icon-ok" />
                ) : (
                  <AlertCircle size={12} strokeWidth={1.9} className="agent-icon-err" />
                )}
              </span>
              <div className="agent-tool-main">
                <div className="agent-tool-head">
                  <span className="agent-tool-label">{TOOL_LABELS[call.name] ?? call.name}</span>
                  {call.argsSummary ? (
                    <span className="agent-tool-args" title={call.argsSummary}>
                      {call.argsSummary}
                    </span>
                  ) : null}
                </div>
                {call.summary ? (
                  <span className="agent-tool-result" title={call.summary}>
                    {call.summary}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function CopyReplyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <button
      type="button"
      className="agent-msg-action-btn"
      aria-label={copied ? '已复制回复' : '复制回复'}
      title={copied ? '已复制' : '复制回复'}
      onClick={handleCopy}
    >
      {copied ? (
        <>
          <Check size={11} strokeWidth={2} aria-hidden="true" />
          <span>已复制</span>
        </>
      ) : (
        <>
          <Copy size={11} strokeWidth={1.75} aria-hidden="true" />
          <span>复制</span>
        </>
      )}
    </button>
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
  defaultApprovalMode = 'review',
  undoMessageId,
  getOverlay,
  onOpenSettings,
  onClose,
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

  const [historyOpen, setHistoryOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const [selectedProfileId, setSelectedProfileId] = useState<string>('')
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [approvalMode, setApprovalMode] = useState<AgentApprovalMode>(defaultApprovalMode)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [modelSearch, setModelSearch] = useState('')

  const [input, setInput] = useState('')
  const [attachFile, setAttachFile] = useState(true)
  const [attachSelection, setAttachSelection] = useState(true)
  const [streaming, setStreaming] = useState<StreamingState | null>(null)
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null)
  const [autoAppliedIds, setAutoAppliedIds] = useState<Set<string>>(() => new Set())
  const [downgradeReasons, setDowngradeReasons] = useState<Record<string, string>>({})

  const abortRef = useRef<{ controller: AbortController; bookId: string; threadId: string } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const stopActiveTurn = useCallback(() => {
    const active = abortRef.current
    if (!active) return
    active.controller.abort()
    void api.abortAgentThread(active.bookId, active.threadId).catch(() => {})
  }, [])

  // Keep selectedProfileId & selectedModel synced with available profiles & multi-model lists.
  useEffect(() => {
    if (profiles.length === 0) {
      setSelectedProfileId('')
      setSelectedModel('')
      return
    }
    const existing = profiles.find((p) => p.id === selectedProfileId)
    if (existing) {
      const models = profileModelsOf(existing)
      if (!selectedModel || !models.includes(selectedModel)) {
        setSelectedModel(existing.model)
      }
      return
    }
    const def = profiles.find((p) => p.isDefault) ?? profiles[0]!
    setSelectedProfileId(def.id)
    setSelectedModel(def.model)
  }, [profiles, selectedProfileId, selectedModel])

  // When no active thread exists yet, follow updated cloud default approval mode.
  useEffect(() => {
    if (!activeThreadId) {
      setApprovalMode(defaultApprovalMode)
    }
  }, [activeThreadId, defaultApprovalMode])

  // Re-enable selection chip whenever the user makes a fresh selection.
  useEffect(() => {
    if (selectionText.trim()) setAttachSelection(true)
  }, [selectionText])

  // Auto-grow composer textarea between 1 and ~6 lines without a resize handle.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [input])

  const loadMessages = useCallback(
    async (threadId: string) => {
      setMessagesLoading(true)
      setPanelError(null)
      try {
        const res = await api.agentThread(bookId, threadId)
        setMessages(res.messages)
        setApprovalMode(res.thread.approvalMode ?? defaultApprovalMode)
        if (res.thread.profileId) {
          const matchedProfile = profiles.find((p) => p.id === res.thread.profileId)
          if (matchedProfile) {
            setSelectedProfileId(matchedProfile.id)
            setSelectedModel(res.thread.model || matchedProfile.model)
          }
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
    [bookId, profiles, defaultApprovalMode],
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
        setApprovalMode(defaultApprovalMode)
      }
    } catch (cause) {
      setPanelError({
        code: cause instanceof ApiError ? cause.code : 'load_failed',
        message: '加载会话列表失败，请稍后重试。',
      })
    } finally {
      setThreadsLoading(false)
    }
  }, [bookId, loadMessages, defaultApprovalMode])

  useEffect(() => {
    void loadThreads()
    return () => {
      stopActiveTurn()
    }
  }, [bookId, stopActiveTurn])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [
    messages.length,
    streaming?.content,
    streaming?.reasoning,
    streaming?.toolCalls.length,
    streaming?.runningTool?.id,
  ])

  const handleSelectThread = (threadId: string) => {
    if (streaming) return
    setHistoryOpen(false)
    setRenamingId(null)
    setConfirmDeleteId(null)
    if (threadId === activeThreadId) return
    setActiveThreadId(threadId)
    void loadMessages(threadId)
  }

  const handleCreateThread = async (): Promise<AgentThreadDto | null> => {
    if (streaming) return null
    setPanelError(null)
    setHistoryOpen(false)
    setRenamingId(null)
    setConfirmDeleteId(null)
    try {
      const res = await api.createAgentThread(bookId, {
        ...(selectedProfileId ? { profileId: selectedProfileId } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        approvalMode: defaultApprovalMode,
      })
      setThreads((current) => [res.thread, ...current])
      setActiveThreadId(res.thread.id)
      setApprovalMode(res.thread.approvalMode)
      setMessages([])
      return res.thread
    } catch {
      setPanelError({ code: 'create_failed', message: '创建新对话失败，请重试。' })
      return null
    }
  }

  const handleRenameSubmit = async (threadId: string) => {
    const trimmed = renameDraft.trim()
    setRenamingId(null)
    if (!trimmed) return
    const existing = threads.find((t) => t.id === threadId)
    if (existing && existing.title === trimmed) return
    setPanelError(null)
    try {
      const res = await api.updateAgentThread(bookId, threadId, { title: trimmed })
      setThreads((current) => current.map((t) => (t.id === threadId ? res.thread : t)))
    } catch {
      setPanelError({ code: 'rename_failed', message: '重命名对话失败，请重试。' })
    }
  }

  const handleDeleteThread = async (threadId: string) => {
    if (streaming) return
    setPanelError(null)
    setConfirmDeleteId(null)
    try {
      await api.deleteAgentThread(bookId, threadId)
      const remaining = threads.filter((t) => t.id !== threadId)
      setThreads(remaining)
      if (activeThreadId === threadId) {
        const next = remaining[0] ?? null
        setActiveThreadId(next?.id ?? null)
        if (next) await loadMessages(next.id)
        else {
          setMessages([])
          setApprovalMode(defaultApprovalMode)
        }
      }
    } catch {
      setPanelError({ code: 'delete_failed', message: '删除对话失败，请重试。' })
    }
  }

  const handleChangeApprovalMode = (nextMode: AgentApprovalMode) => {
    if (streaming || nextMode === approvalMode) return
    setApprovalMode(nextMode)
    if (activeThreadId) {
      void api
        .updateAgentThread(bookId, activeThreadId, { approvalMode: nextMode })
        .then((res) => {
          setThreads((list) => list.map((t) => (t.id === res.thread.id ? res.thread : t)))
        })
        .catch(() => {})
    }
  }

  const handleSelectModelChoice = (encoded: string) => {
    const decoded = decodeModelChoice(encoded)
    if (!decoded) return
    setSelectedProfileId(decoded.profileId)
    setSelectedModel(decoded.model)
    setModelMenuOpen(false)
    setModelSearch('')
    if (activeThreadId) {
      void api
        .updateAgentThread(bookId, activeThreadId, {
          profileId: decoded.profileId,
          model: decoded.model,
        })
        .then((res) => {
          setThreads((list) => list.map((t) => (t.id === res.thread.id ? res.thread : t)))
        })
        .catch(() => {})
    }
  }

  const finalizeAssistantTurn = async (options: {
    threadId: string
    messageId: string
    draft: StreamingState
    streamError: { code: string; message: string } | null
    effectiveMode: AgentApprovalMode
    replacingMessageId?: string
  }) => {
    const { threadId, messageId, draft, streamError, effectiveMode, replacingMessageId } = options
    let proposalStatus: 'pending' | 'applied' | 'dismissed' | null = draft.proposal ? 'pending' : null

    if (draft.proposal && !streamError && effectiveMode === 'auto') {
      const check = evaluateAutoApply(draft.proposal)
      if (check.eligible) {
        const appliedOk = await onApplyProposal(messageId, draft.proposal)
        if (appliedOk) {
          proposalStatus = 'applied'
          setAutoAppliedIds((prev) => new Set(prev).add(messageId))
        }
      } else if (check.reason) {
        setDowngradeReasons((prev) => ({ ...prev, [messageId]: check.reason! }))
      }
    }

    const finalized: AgentMessageDto = {
      id: messageId,
      threadId,
      role: 'assistant',
      content: draft.content,
      reasoning: draft.reasoning.trim() ? draft.reasoning : null,
      context: null,
      toolCalls: draft.toolCalls,
      proposal: draft.proposal,
      proposalStatus,
      error: streamError ? streamError.message : null,
      createdAt: new Date().toISOString(),
    }

    setMessages((current) => {
      if (replacingMessageId) {
        return current.map((m) => (m.id === replacingMessageId ? finalized : m))
      }
      return [...current, finalized]
    })
  }

  const sendPrompt = async (promptText: string) => {
    const text = promptText.trim()
    if (!text || streaming || profiles.length === 0) return

    setPanelError(null)
    let threadId = activeThreadId
    const effectiveMode = approvalMode
    if (!threadId) {
      const created = await handleCreateThread()
      if (!created) return
      threadId = created.id
      if (created.approvalMode !== effectiveMode) {
        void api.updateAgentThread(bookId, threadId, { approvalMode: effectiveMode }).catch(() => {})
      }
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
      reasoning: null,
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
    abortRef.current = { controller, bookId, threadId }

    const draft: StreamingState = {
      content: '',
      reasoning: '',
      toolCalls: [],
      runningTool: null,
      proposal: null,
    }
    setStreaming({ ...draft })

    const { dirtyTexts, deletedPaths } = getOverlay()

    let finalMessageId: string | undefined
    let streamStopped = false
    let streamError: { code: string; message: string } | null = null

    const commitStoppedNewMessage = () => {
      if (draft.content || draft.reasoning || draft.toolCalls.length > 0) {
        setMessages((current) => [
          ...current,
          {
            id: finalMessageId ?? `stopped-${Date.now()}`,
            threadId: threadId!,
            role: 'assistant',
            content: draft.content || '已停止生成。',
            reasoning: draft.reasoning.trim() ? draft.reasoning : null,
            context: null,
            toolCalls: draft.toolCalls,
            proposal: null,
            proposalStatus: null,
            error: null,
            createdAt: new Date().toISOString(),
          },
        ])
      }
    }

    try {
      await api.streamAgentMessage(
        bookId,
        threadId,
        {
          content: text,
          ...(selectedProfileId ? { profileId: selectedProfileId } : {}),
          ...(selectedModel ? { model: selectedModel } : {}),
          approvalMode: effectiveMode,
          baseVersion: bookVersion,
          dirtyTexts,
          deletedPaths,
          context,
        },
        {
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type === 'reasoning_delta') {
              draft.reasoning += event.text
              setStreaming({ ...draft })
            } else if (event.type === 'text_delta') {
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
              streamStopped = Boolean(event.stopped)
              if (event.threadTitle) {
                setThreads((list) =>
                  list.map((t) =>
                    t.id === threadId
                      ? {
                          ...t,
                          title: event.threadTitle!,
                          approvalMode: event.approvalMode ?? t.approvalMode,
                          model: event.model ?? t.model,
                          profileId: event.profileId ?? t.profileId,
                          updatedAt: new Date().toISOString(),
                        }
                      : t,
                  ),
                )
              }
            }
          },
        },
      )

      if (controller.signal.aborted || streamStopped) {
        commitStoppedNewMessage()
      } else {
        await finalizeAssistantTurn({
          threadId,
          messageId: finalMessageId ?? `assistant-${Date.now()}`,
          draft,
          streamError,
          effectiveMode,
        })
      }
    } catch (cause) {
      if (controller.signal.aborted) {
        commitStoppedNewMessage()
      } else if (cause instanceof ApiError) {
        const payload = cause.payload as { message?: string } | undefined
        setPanelError({
          code: cause.code,
          message: payload?.message ?? `请求失败（${cause.code}）`,
        })
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

  const handleRetryLastMessage = async (messageId: string) => {
    if (streaming || !activeThreadId || profiles.length === 0) return
    setPanelError(null)
    setDowngradeReasons((prev) => {
      if (!(messageId in prev)) return prev
      const next = { ...prev }
      delete next[messageId]
      return next
    })

    const effectiveMode = approvalMode
    const controller = new AbortController()
    abortRef.current = { controller, bookId, threadId: activeThreadId }

    const draft: StreamingState = {
      content: '',
      reasoning: '',
      toolCalls: [],
      runningTool: null,
      proposal: null,
      replacingMessageId: messageId,
    }
    setStreaming({ ...draft })

    const { dirtyTexts, deletedPaths } = getOverlay()
    let finalMessageId: string | undefined
    let streamStopped = false
    let streamError: { code: string; message: string } | null = null

    const commitStoppedRetryMessage = () => {
      if (draft.content || draft.reasoning || draft.toolCalls.length > 0) {
        setMessages((current) =>
          current.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  content: draft.content || '已停止生成。',
                  reasoning: draft.reasoning.trim() ? draft.reasoning : null,
                  toolCalls: draft.toolCalls,
                  proposal: null,
                  proposalStatus: null,
                  error: null,
                }
              : m,
          ),
        )
      }
    }

    try {
      await api.retryAgentMessage(
        bookId,
        activeThreadId,
        messageId,
        {
          ...(selectedProfileId ? { profileId: selectedProfileId } : {}),
          ...(selectedModel ? { model: selectedModel } : {}),
          approvalMode: effectiveMode,
          baseVersion: bookVersion,
          dirtyTexts,
          deletedPaths,
        },
        {
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type === 'reasoning_delta') {
              draft.reasoning += event.text
              setStreaming({ ...draft })
            } else if (event.type === 'text_delta') {
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
              streamStopped = Boolean(event.stopped)
              setThreads((list) =>
                list.map((t) =>
                  t.id === activeThreadId
                    ? {
                        ...t,
                        approvalMode: event.approvalMode ?? t.approvalMode,
                        model: event.model ?? t.model,
                        profileId: event.profileId ?? t.profileId,
                        updatedAt: new Date().toISOString(),
                      }
                    : t,
                ),
              )
            }
          },
        },
      )

      if (controller.signal.aborted || streamStopped) {
        commitStoppedRetryMessage()
      } else {
        await finalizeAssistantTurn({
          threadId: activeThreadId,
          messageId: finalMessageId ?? messageId,
          draft,
          streamError,
          effectiveMode,
          replacingMessageId: messageId,
        })
      }
    } catch (cause) {
      if (controller.signal.aborted) {
        commitStoppedRetryMessage()
      } else if (cause instanceof ApiError) {
        const payload = cause.payload as { message?: string } | undefined
        setPanelError({
          code: cause.code,
          message: payload?.message ?? `重试失败（${cause.code}）`,
        })
      } else {
        setPanelError({ code: 'network_error', message: '重试连接中断，请稍后重试。' })
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
        setDowngradeReasons((prev) => {
          if (!(messageId in prev)) return prev
          const next = { ...prev }
          delete next[messageId]
          return next
        })
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

  const totalModelCount = useMemo(
    () => profiles.reduce((acc, p) => acc + profileModelsOf(p).length, 0),
    [profiles],
  )

  const filteredProfileGroups = useMemo(() => {
    const q = modelSearch.trim().toLowerCase()
    return profiles
      .map((profile) => {
        const models = profileModelsOf(profile)
        const matchingModels = !q
          ? models
          : profile.name.toLowerCase().includes(q)
            ? models
            : models.filter((m) => m.toLowerCase().includes(q))
        return { profile, models: matchingModels }
      })
      .filter((group) => group.models.length > 0)
  }, [profiles, modelSearch])

  const isLoadingInit = profilesLoading || threadsLoading
  const activeThread = threads.find((t) => t.id === activeThreadId) ?? null
  const selectedProfile = profiles.find((p) => p.id === selectedProfileId) ?? profiles[0] ?? null
  const activeModelName = selectedModel || selectedProfile?.model || ''
  const selectedEncoded = selectedProfile ? encodeModelChoice(selectedProfile.id, activeModelName) : ''
  const approvalMeta = APPROVAL_META[approvalMode]
  const ApprovalIcon = approvalMeta.icon
  const hasSelection = Boolean(selectionText.trim())
  const showContextStrip = Boolean(activePath || hasSelection)

  return (
    <div className="agent-panel">
      {/* Single-row 38px header aligned with TabBar; history uses Radix Popover instead of native <select>. See ADR 2026-11-20-agent-sidebar-chat-ui. */}
      <header className="agent-header">
        {profiles.length > 0 ? (
          <Popover.Root
            open={historyOpen}
            onOpenChange={(nextOpen) => {
              setHistoryOpen(nextOpen)
              if (!nextOpen) {
                setRenamingId(null)
                setConfirmDeleteId(null)
              }
            }}
          >
            <Popover.Trigger asChild>
              <button
                type="button"
                className="agent-thread-trigger"
                aria-label="切换历史对话"
                disabled={Boolean(streaming)}
                title={activeThread?.title ?? '新对话'}
              >
                <History size={13} strokeWidth={1.75} className="agent-thread-trigger-icon" aria-hidden="true" />
                <span className="agent-thread-trigger-title">{activeThread?.title ?? '新对话'}</span>
                <ChevronDown size={13} strokeWidth={1.75} className="agent-thread-trigger-caret" aria-hidden="true" />
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                className="agent-history-popover"
                align="start"
                sideOffset={6}
                collisionPadding={8}
                aria-label="历史对话列表"
              >
                <div className="agent-history-head">
                  <span className="agent-history-label">历史对话（{threads.length}）</span>
                  <button
                    type="button"
                    className="agent-history-new-btn"
                    onClick={() => void handleCreateThread()}
                  >
                    <Plus size={12} strokeWidth={1.8} aria-hidden="true" />
                    <span>新对话</span>
                  </button>
                </div>

                {threads.length === 0 ? (
                  <p className="agent-history-empty">还没有历史对话，发送第一条消息即可自动保存。</p>
                ) : (
                  <ul className="agent-history-list">
                    {threads.map((thread) => {
                      const isCurrent = thread.id === activeThreadId
                      const isRenaming = renamingId === thread.id
                      const isConfirmingDelete = confirmDeleteId === thread.id

                      return (
                        <li key={thread.id} className={`agent-history-item${isCurrent ? ' is-current' : ''}`}>
                          {isRenaming ? (
                            <form
                              className="agent-history-rename"
                              onSubmit={(event) => {
                                event.preventDefault()
                                void handleRenameSubmit(thread.id)
                              }}
                            >
                              <input
                                type="text"
                                className="agent-history-rename-input"
                                aria-label="输入新对话标题"
                                autoFocus
                                value={renameDraft}
                                onChange={(event) => setRenameDraft(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Escape') {
                                    event.stopPropagation()
                                    setRenamingId(null)
                                  }
                                }}
                              />
                              <button
                                type="submit"
                                className="agent-icon-btn"
                                aria-label="保存标题"
                                title="保存标题"
                              >
                                <Check size={12} strokeWidth={2} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="agent-icon-btn"
                                aria-label="取消重命名"
                                title="取消"
                                onClick={() => setRenamingId(null)}
                              >
                                <X size={12} strokeWidth={1.8} aria-hidden="true" />
                              </button>
                            </form>
                          ) : isConfirmingDelete ? (
                            <div className="agent-history-delete-confirm">
                              <span className="agent-history-delete-msg">删除这条对话？</span>
                              <div className="agent-history-delete-actions">
                                <button
                                  type="button"
                                  className="agent-history-confirm-btn is-danger"
                                  onClick={() => void handleDeleteThread(thread.id)}
                                >
                                  确认删除
                                </button>
                                <button
                                  type="button"
                                  className="agent-history-confirm-btn"
                                  onClick={() => setConfirmDeleteId(null)}
                                >
                                  取消
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="agent-history-row">
                              <button
                                type="button"
                                className="agent-history-select"
                                onClick={() => handleSelectThread(thread.id)}
                              >
                                <span className="agent-history-title" title={thread.title}>
                                  {thread.title}
                                </span>
                                <span className="agent-history-time">{formatThreadTime(thread.updatedAt)}</span>
                              </button>
                              <div className="agent-history-row-actions">
                                <button
                                  type="button"
                                  className="agent-icon-btn"
                                  aria-label={`重命名 ${thread.title}`}
                                  title="重命名对话"
                                  onClick={() => {
                                    setConfirmDeleteId(null)
                                    setRenamingId(thread.id)
                                    setRenameDraft(thread.title)
                                  }}
                                >
                                  <Pencil size={12} strokeWidth={1.7} aria-hidden="true" />
                                </button>
                                <button
                                  type="button"
                                  className="agent-icon-btn is-danger"
                                  aria-label={`删除 ${thread.title}`}
                                  title="删除对话"
                                  onClick={() => {
                                    setRenamingId(null)
                                    setConfirmDeleteId(thread.id)
                                  }}
                                >
                                  <Trash2 size={12} strokeWidth={1.7} aria-hidden="true" />
                                </button>
                              </div>
                            </div>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        ) : (
          <div className="agent-header-brand">
            <Sparkles size={13} strokeWidth={1.75} className="agent-icon-accent" aria-hidden="true" />
            <span className="agent-toolbar-title">EPUB 编辑助手</span>
          </div>
        )}

        <div className="agent-header-actions">
          {profiles.length > 0 ? (
            <button
              type="button"
              className="agent-icon-btn"
              title="新建对话"
              aria-label="新建对话"
              disabled={Boolean(streaming)}
              onClick={() => void handleCreateThread()}
            >
              <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            className="agent-icon-btn"
            title="模型预设设置"
            aria-label="模型预设设置"
            onClick={onOpenSettings}
          >
            <SlidersHorizontal size={14} strokeWidth={1.7} aria-hidden="true" />
          </button>
          {onClose ? (
            <button
              type="button"
              className="agent-icon-btn"
              title="关闭助手栏"
              aria-label="关闭助手栏"
              onClick={onClose}
            >
              <X size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>

      {isLoadingInit ? (
        <div className="agent-body agent-loading-bubbles" aria-busy="true" aria-label="正在加载助手">
          <div className="agent-skeleton-bubble is-user">
            <span className="skeleton-line" />
          </div>
          <div className="agent-skeleton-bubble is-assistant">
            <span className="skeleton-line" />
            <span className="skeleton-line short" />
          </div>
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
              <div className="agent-loading-bubbles" aria-busy="true" aria-label="正在载入消息">
                <div className="agent-skeleton-bubble is-user">
                  <span className="skeleton-line" />
                </div>
                <div className="agent-skeleton-bubble is-assistant">
                  <span className="skeleton-line" />
                  <span className="skeleton-line short" />
                </div>
              </div>
            ) : messages.length === 0 && !streaming ? (
              <div className="agent-welcome">
                <div className="agent-welcome-badge" aria-hidden="true">
                  <Sparkles size={18} strokeWidth={1.75} />
                </div>
                <h2 className="agent-welcome-title">EPUB 校对与编辑助手</h2>
                <p className="agent-welcome-book" title={bookTitle}>
                  当前书籍 · {bookTitle}
                </p>
                <p className="agent-welcome-desc">
                  可直接读取章节、排查结构报错、整理目录与重命名；可在底栏切换只读、审阅与自动应用模式。
                </p>
                <div className="agent-starters">
                  {STARTER_PROMPTS.map(({ icon: Icon, title, prompt }) => (
                    <button
                      key={prompt}
                      type="button"
                      className="agent-starter-btn"
                      onClick={() => void sendPrompt(prompt)}
                    >
                      <span className="agent-starter-icon" aria-hidden="true">
                        <Icon size={14} strokeWidth={1.7} />
                      </span>
                      <span className="agent-starter-copy">
                        <span className="agent-starter-title">{title}</span>
                        <span className="agent-starter-prompt">{prompt}</span>
                      </span>
                      <ChevronRight size={13} strokeWidth={1.75} className="agent-starter-arrow" aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="agent-messages">
                {messages.map((msg, index) => {
                  // Hide the message currently being replaced in-place by a live retry stream.
                  if (streaming?.replacingMessageId === msg.id) return null

                  const clock = formatClock(msg.createdAt)
                  const isLastMessage = index === messages.length - 1
                  const canShowRetry =
                    isLastMessage &&
                    msg.role === 'assistant' &&
                    !streaming &&
                    !msg.id.startsWith('local-') &&
                    !msg.id.startsWith('stopped-') &&
                    !msg.id.startsWith('assistant-')
                  const retryBlockedApplied = msg.proposalStatus === 'applied'

                  if (msg.role === 'user') {
                    return (
                      <article key={msg.id} className="agent-turn is-user">
                        <div className="agent-bubble is-user">
                          {msg.context?.activePath || msg.context?.selection ? (
                            <div className="agent-bubble-ctx-row">
                              {msg.context.activePath ? (
                                <span className="agent-bubble-ctx" title={msg.context.activePath}>
                                  <FileText size={11} strokeWidth={1.75} aria-hidden="true" />
                                  <span>{basename(msg.context.activePath)}</span>
                                </span>
                              ) : null}
                              {msg.context.selection ? (
                                <span className="agent-bubble-ctx">
                                  <Quote size={10} strokeWidth={1.8} aria-hidden="true" />
                                  <span>选中 {msg.context.selection.length} 字</span>
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                          <div className="agent-bubble-user-text">{msg.content}</div>
                        </div>
                        {clock ? <time className="agent-msg-time">{clock}</time> : null}
                      </article>
                    )
                  }

                  return (
                    <article key={msg.id} className="agent-turn is-assistant">
                      <ToolSteps calls={msg.toolCalls} />
                      {msg.reasoning ? <ReasoningBlock text={msg.reasoning} /> : null}

                      {msg.content || msg.error ? (
                        <div className="agent-assistant-row">
                          <div className="agent-avatar" aria-hidden="true">
                            <Sparkles size={13} strokeWidth={1.8} />
                          </div>
                          <div className="agent-assistant-col">
                            <div className="agent-bubble is-assistant">
                              {msg.content ? <AgentMarkdown content={msg.content} /> : null}
                              {msg.error ? (
                                <p className="banner banner-error agent-inline-banner" role="alert">
                                  <AlertCircle size={13} strokeWidth={1.75} aria-hidden="true" />
                                  <span>{msg.error}</span>
                                </p>
                              ) : null}
                            </div>
                            <div className="agent-assistant-meta">
                              {clock ? <time className="agent-msg-time">{clock}</time> : null}
                              {msg.content ? <CopyReplyButton text={msg.content} /> : null}
                              {canShowRetry ? (
                                <button
                                  type="button"
                                  className="agent-msg-action-btn"
                                  disabled={retryBlockedApplied}
                                  aria-label="重试此回复"
                                  title={
                                    retryBlockedApplied
                                      ? '该回复的提案已应用到工作区，请先撤销或继续追问'
                                      : '使用当前模型和模式重新生成此回复'
                                  }
                                  onClick={() => void handleRetryLastMessage(msg.id)}
                                >
                                  <RotateCw size={11} strokeWidth={1.8} aria-hidden="true" />
                                  <span>重试</span>
                                </button>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      ) : null}

                      {/* Proposal card stays full-width outside the bubble so narrow-sidebar diff lines stay legible. See ADR 2026-11-20-agent-sidebar-chat-ui. */}
                      {msg.proposal && msg.proposalStatus ? (
                        <AgentProposalCard
                          proposal={msg.proposal}
                          status={msg.proposalStatus}
                          canUndo={undoMessageId === msg.id}
                          busy={busyProposalId === msg.id}
                          autoApplied={autoAppliedIds.has(msg.id)}
                          autoDowngradeReason={downgradeReasons[msg.id] ?? null}
                          onApply={(paths) => void handleProposalApply(msg.id, msg.proposal!, paths)}
                          onDismiss={() => void handleProposalDismiss(msg.id)}
                          onUndo={() => onUndoProposal(msg.id)}
                        />
                      ) : null}
                    </article>
                  )
                })}

                {streaming ? (
                  <article className="agent-turn is-assistant is-streaming" aria-live="polite">
                    <ToolSteps calls={streaming.toolCalls} running={streaming.runningTool} />
                    {streaming.reasoning ? (
                      <ReasoningBlock
                        text={streaming.reasoning}
                        streaming
                        hasAnswer={Boolean(streaming.content)}
                      />
                    ) : null}
                    <div className="agent-assistant-row">
                      <div className="agent-avatar is-pulsing" aria-hidden="true">
                        <Sparkles size={13} strokeWidth={1.8} />
                      </div>
                      <div className="agent-assistant-col">
                        <div className="agent-bubble is-assistant">
                          {streaming.content ? (
                            <AgentMarkdown content={streaming.content} />
                          ) : (
                            <div className="agent-thinking">
                              <Loader2 size={12} strokeWidth={1.8} className="spin" aria-hidden="true" />
                              <span>
                                {streaming.runningTool
                                  ? '正在处理工具返回…'
                                  : streaming.reasoning
                                    ? '正在整理回复…'
                                    : '正在思考…'}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </article>
                ) : null}
              </div>
            )}
          </div>

          <div className="agent-composer-area">
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

            <div className="agent-composer-card">
              {showContextStrip ? (
                <div className="agent-context-chips">
                  {activePath ? (
                    attachFile ? (
                      <span className="agent-context-chip" title={activePath}>
                        <FileText size={11} strokeWidth={1.75} aria-hidden="true" />
                        <span className="agent-context-chip-text">{basename(activePath)}</span>
                        <button
                          type="button"
                          aria-label="移除当前文件上下文"
                          onClick={() => setAttachFile(false)}
                        >
                          <X size={11} strokeWidth={1.75} aria-hidden="true" />
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="agent-context-restore"
                        aria-label="重新挂载当前文件上下文"
                        title={`挂载当前文件：${activePath}`}
                        onClick={() => setAttachFile(true)}
                      >
                        <Plus size={11} strokeWidth={1.8} aria-hidden="true" />
                        <span>{basename(activePath)}</span>
                      </button>
                    )
                  ) : null}

                  {hasSelection ? (
                    attachSelection ? (
                      <span className="agent-context-chip">
                        <Quote size={10} strokeWidth={1.8} aria-hidden="true" />
                        <span>选中片段（{selectionText.trim().length} 字）</span>
                        <button
                          type="button"
                          aria-label="移除选中片段上下文"
                          onClick={() => setAttachSelection(false)}
                        >
                          <X size={11} strokeWidth={1.75} aria-hidden="true" />
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="agent-context-restore"
                        aria-label="重新挂载选中片段上下文"
                        onClick={() => setAttachSelection(true)}
                      >
                        <Plus size={11} strokeWidth={1.8} aria-hidden="true" />
                        <span>选中片段（{selectionText.trim().length} 字）</span>
                      </button>
                    )
                  ) : null}
                </div>
              ) : null}

              <textarea
                ref={textareaRef}
                className="agent-textarea"
                rows={2}
                aria-label="向助手输入指令"
                placeholder={
                  approvalMode === 'ask'
                    ? '当前为只读模式：输入咨询、排查或校对建议问题（Enter 发送）'
                    : approvalMode === 'auto'
                      ? '当前为自动模式：预检通过将自动应用到工作区（Enter 发送）'
                      : '输入校对、样式、目录或结构修改指令（Enter 发送，Shift+Enter 换行）'
                }
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

              {/* Compact dual-pill footer keeps approval mode and provider-grouped model picker adjacent to send. See ADR 2026-11-20-agent-modes-and-multimodel. */}
              <div className="agent-composer-footer">
                <div className="agent-composer-controls">
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button
                        type="button"
                        className={`agent-mode-trigger${approvalMode === 'auto' ? ' is-auto' : ''}`}
                        aria-label="切换审批模式"
                        disabled={Boolean(streaming)}
                        title={`审批模式：${approvalMeta.label} — ${approvalMeta.desc}`}
                      >
                        <ApprovalIcon size={12} strokeWidth={1.85} aria-hidden="true" />
                        <span>{approvalMeta.label}</span>
                        <ChevronDown size={11} strokeWidth={1.8} aria-hidden="true" />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        className="agent-mode-menu"
                        align="start"
                        side="top"
                        sideOffset={6}
                        collisionPadding={8}
                      >
                        <DropdownMenu.RadioGroup
                          value={approvalMode}
                          onValueChange={(value) => handleChangeApprovalMode(value as AgentApprovalMode)}
                        >
                          {APPROVAL_ORDER.map((modeKey) => {
                            const meta = APPROVAL_META[modeKey]
                            const ModeIcon = meta.icon
                            return (
                              <DropdownMenu.RadioItem
                                key={modeKey}
                                value={modeKey}
                                className="agent-model-item"
                              >
                                <span className="agent-model-item-check" aria-hidden="true">
                                  <DropdownMenu.ItemIndicator>
                                    <Check size={12} strokeWidth={2} />
                                  </DropdownMenu.ItemIndicator>
                                </span>
                                <span className="agent-model-item-text">
                                  <span className="agent-mode-item-head">
                                    <ModeIcon size={12} strokeWidth={1.8} aria-hidden="true" />
                                    <span className="agent-model-item-name">{meta.label}</span>
                                  </span>
                                  <span className="agent-mode-item-desc">{meta.desc}</span>
                                </span>
                              </DropdownMenu.RadioItem>
                            )
                          })}
                        </DropdownMenu.RadioGroup>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>

                  <DropdownMenu.Root
                    open={modelMenuOpen}
                    onOpenChange={(next) => {
                      setModelMenuOpen(next)
                      if (!next) setModelSearch('')
                    }}
                  >
                    <DropdownMenu.Trigger asChild>
                      <button
                        type="button"
                        className="agent-model-trigger"
                        aria-label="选择模型预设"
                        disabled={Boolean(streaming)}
                        title={
                          selectedProfile
                            ? `${selectedProfile.name} · ${activeModelName}`
                            : '选择模型预设'
                        }
                      >
                        <span className="agent-model-trigger-name">
                          {activeModelName || selectedProfile?.name || '选择模型'}
                        </span>
                        <ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        className="agent-model-menu"
                        align="start"
                        side="top"
                        sideOffset={6}
                        collisionPadding={8}
                      >
                        {totalModelCount > 8 ? (
                          <div
                            className="agent-model-search"
                            onKeyDown={(event) => event.stopPropagation()}
                          >
                            <Search size={12} strokeWidth={1.75} aria-hidden="true" />
                            <input
                              type="text"
                              aria-label="搜索可用模型"
                              placeholder="搜索供应商或模型…"
                              value={modelSearch}
                              onChange={(event) => setModelSearch(event.target.value)}
                            />
                          </div>
                        ) : null}

                        <div className="agent-model-groups">
                          {filteredProfileGroups.length === 0 ? (
                            <p className="agent-model-empty">无匹配模型</p>
                          ) : (
                            <DropdownMenu.RadioGroup
                              value={selectedEncoded}
                              onValueChange={handleSelectModelChoice}
                            >
                              {filteredProfileGroups.map(({ profile, models }, groupIdx) => (
                                <DropdownMenu.Group key={profile.id}>
                                  {groupIdx > 0 ? <DropdownMenu.Separator className="agent-menu-sep" /> : null}
                                  <DropdownMenu.Label className="agent-model-group-label">
                                    <span>{profile.name}</span>
                                    <span className="agent-model-group-provider">
                                      {profile.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'}
                                    </span>
                                  </DropdownMenu.Label>
                                  {models.map((modelId) => {
                                    const encoded = encodeModelChoice(profile.id, modelId)
                                    return (
                                      <DropdownMenu.RadioItem
                                        key={encoded}
                                        value={encoded}
                                        className="agent-model-item"
                                      >
                                        <span className="agent-model-item-check" aria-hidden="true">
                                          <DropdownMenu.ItemIndicator>
                                            <Check size={12} strokeWidth={2} />
                                          </DropdownMenu.ItemIndicator>
                                        </span>
                                        <span className="agent-model-item-text">
                                          <span className="agent-model-item-name" title={`${profile.name} · ${modelId}`}>
                                            {modelId}
                                          </span>
                                          {models.length === 1 ? (
                                            <span className="agent-model-item-meta">{profile.name}</span>
                                          ) : null}
                                        </span>
                                      </DropdownMenu.RadioItem>
                                    )
                                  })}
                                </DropdownMenu.Group>
                              ))}
                            </DropdownMenu.RadioGroup>
                          )}
                        </div>

                        <DropdownMenu.Separator className="agent-menu-sep" />
                        <DropdownMenu.Item className="agent-model-manage" onSelect={onOpenSettings}>
                          <SlidersHorizontal size={12} strokeWidth={1.75} aria-hidden="true" />
                          <span>管理供应商与模型…</span>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </div>

                {streaming ? (
                  <button
                    type="button"
                    className="agent-send-btn is-stop"
                    aria-label="停止"
                    title="停止生成"
                    onClick={stopActiveTurn}
                  >
                    <Square size={11} strokeWidth={2.2} fill="currentColor" aria-hidden="true" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="agent-send-btn"
                    aria-label="发送"
                    title="发送（Enter）"
                    disabled={!input.trim()}
                    onClick={() => void sendPrompt(input)}
                  >
                    <ArrowUp size={15} strokeWidth={2.1} aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
