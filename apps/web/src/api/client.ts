import type { AgentProposal, AgentToolName } from '@booksmith/core'

export interface UserDto {
  id: string
  email: string
  role: string
}

export interface PageSnapshotDto {
  id: string
  path: string
  byteSize: number
  sha256: string
  /** Protected from automatic pruning. */
  pinned: boolean
  createdAt: string
}

export interface BookDto {
  id: string
  title: string
  author: string
  language: string
  identifier: string
  chapterCount: number
  byteSize: number
  currentVersion: number
  updatedAt: string
  hasCover: boolean
}

export interface WorkspaceEntryDto {
  path: string
  position: number
  isText: boolean
  mediaType: string
  byteSize: number
  sha256: string
}

export interface WorkspaceDto {
  version: number
  entries: WorkspaceEntryDto[]
  texts: Record<string, string>
}

export interface EntryDeltaPayload {
  textUpserts: Record<string, string>
  binaryUpserts: Map<string, { bytes: Uint8Array; mediaType: string }>
  renames: Array<{ from: string; to: string }>
  deletes: string[]
  order: string[]
}

export type AgentProviderType = 'openai-compatible' | 'anthropic'
export type AgentApprovalMode = 'ask' | 'review' | 'auto'

export interface AgentProfileDto {
  id: string
  name: string
  provider: AgentProviderType
  baseUrl: string
  model: string
  models: string[]
  hasApiKey: boolean
  apiKeyLast4: string | null
  isDefault: boolean
  updatedAt: string
}

export interface AgentProfileCreateInput {
  name: string
  provider: AgentProviderType
  baseUrl: string
  model: string
  models?: string[]
  apiKey?: string
  isDefault?: boolean
}

export interface AgentProfileUpdateInput {
  name?: string
  provider?: AgentProviderType
  baseUrl?: string
  model?: string
  models?: string[]
  apiKey?: string
  clearApiKey?: boolean
  isDefault?: boolean
}

export interface AgentUserSettingsDto {
  defaultApprovalMode: AgentApprovalMode
  maxSteps: number
  customInstructions: string
  updatedAt: string | null
}

export interface AgentConnectionTestResult {
  ok: boolean
  latencyMs: number
  reply?: string
  errorCode?: string
  error?: string
}

export interface AgentProviderModelsResult {
  ok: boolean
  models: string[]
  errorCode?: string
  error?: string
}

export interface AgentThreadDto {
  id: string
  bookId: string
  title: string
  profileId: string | null
  model: string | null
  approvalMode: AgentApprovalMode
  createdAt: string
  updatedAt: string
}

export interface AgentToolCallDto {
  id: string
  name: AgentToolName
  argsSummary: string
  ok: boolean
  summary: string
}

export interface AgentMessageDto {
  id: string
  threadId: string
  role: 'user' | 'assistant'
  content: string
  reasoning: string | null
  context: { activePath?: string | null; selection?: string | null } | null
  toolCalls: AgentToolCallDto[]
  proposal: AgentProposal | null
  proposalStatus: 'pending' | 'applied' | 'dismissed' | null
  error: string | null
  createdAt: string
}

export type AgentSseEvent =
  | { type: 'reasoning_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; id: string; name: AgentToolName; argsSummary: string }
  | { type: 'tool_end'; id: string; name: AgentToolName; ok: boolean; summary: string }
  | { type: 'proposal'; proposal: AgentProposal }
  | {
      type: 'done'
      messageId?: string
      threadTitle?: string
      stopped: boolean
      approvalMode?: AgentApprovalMode
      model?: string
      profileId?: string
    }
  | { type: 'error'; code: string; message: string }

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly payload: unknown,
  ) {
    super(code)
    this.name = 'ApiError'
  }
}

/** In-memory conditional ETag cache for `/workspace` so switching back to an unchanged book
 * resolves via HTTP 304 without re-transferring text payloads. */
const workspaceCache = new Map<string, { etag: string; data: WorkspaceDto }>()

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: 'include', ...init })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    const code = (payload as { error?: string }).error ?? `http_${response.status}`
    throw new ApiError(response.status, code, payload)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

async function consumeAgentSse(
  response: Response,
  onEvent: (event: AgentSseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    const code = (payload as { error?: string }).error ?? `http_${response.status}`
    throw new ApiError(response.status, code, payload)
  }

  if (!response.body) throw new ApiError(500, 'empty_stream', {})

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  const throwIfAborted = () => {
    if (!signal?.aborted) return
    void reader.cancel().catch(() => {})
    throw new DOMException('The operation was aborted', 'AbortError')
  }

  while (true) {
    throwIfAborted()
    const { value, done } = await reader.read()
    throwIfAborted()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const chunks = buffer.split('\n\n')
    buffer = chunks.pop() ?? ''
    for (const chunk of chunks) {
      throwIfAborted()
      const line = chunk.split('\n').find((entry) => entry.startsWith('data: '))
      if (!line) continue
      try {
        const parsed = JSON.parse(line.slice(6)) as AgentSseEvent
        onEvent(parsed)
      } catch {
        // Ignore malformed keepalive frames.
      }
    }
  }

  throwIfAborted()
  const tail = buffer.trim()
  if (tail.startsWith('data: ')) {
    try {
      onEvent(JSON.parse(tail.slice(6)) as AgentSseEvent)
    } catch {
      // Ignore incomplete tail on abrupt disconnect.
    }
  }
}

export const api = {
  me: () => request<{ user: UserDto | null }>('/auth/me'),

  login: (email: string, password: string) =>
    request<{ user: UserDto }>('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),

  logout: () => {
    workspaceCache.clear()
    return request<void>('/auth/logout', { method: 'POST' })
  },

  books: () => request<{ books: BookDto[] }>('/books'),

  deleteBook: (id: string) => {
    workspaceCache.delete(id)
    return request<void>(`/books/${id}`, { method: 'DELETE' })
  },

  workspace: async (id: string): Promise<WorkspaceDto> => {
    const cached = workspaceCache.get(id)
    const headers: Record<string, string> = {}
    if (cached) headers['if-none-match'] = cached.etag
    const response = await fetch(`/api/books/${id}/workspace`, {
      credentials: 'include',
      headers,
    })
    if (response.status === 304 && cached) {
      return cached.data
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      throw new ApiError(response.status, (payload as { error?: string }).error ?? 'http_error', payload)
    }
    const data = (await response.json()) as WorkspaceDto
    const etag = response.headers.get('etag') ?? `"${data.version}"`
    workspaceCache.set(id, { etag, data })
    return data
  },

  saveEntries: async (
    id: string,
    version: number,
    delta: EntryDeltaPayload,
    options: { checkpoint?: boolean } = {},
  ): Promise<{ book: BookDto; version: number; entries: WorkspaceEntryDto[] }> => {
    const headers: Record<string, string> = { 'if-match': `"${version}"` }
    if (options.checkpoint) headers['x-booksmith-checkpoint'] = 'manual'

    let body: BodyInit
    if (delta.binaryUpserts.size === 0) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify({
        textUpserts: delta.textUpserts,
        renames: delta.renames,
        deletes: delta.deletes,
        order: delta.order,
      })
    } else {
      const form = new FormData()
      const binaryMediaTypes: Record<string, string> = {}
      for (const [path, file] of delta.binaryUpserts) {
        binaryMediaTypes[path] = file.mediaType
      }
      form.append(
        'ops',
        JSON.stringify({
          textUpserts: delta.textUpserts,
          renames: delta.renames,
          deletes: delta.deletes,
          order: delta.order,
          binaryMediaTypes,
        }),
      )
      for (const [path, file] of delta.binaryUpserts) {
        const copy = new Uint8Array(file.bytes.byteLength)
        copy.set(file.bytes)
        form.append(`bin:${path}`, new Blob([copy.buffer], { type: file.mediaType }), path.split('/').pop() || 'asset')
      }
      body = form
    }

    const response = await fetch(`/api/books/${id}/entries`, {
      method: 'PATCH',
      credentials: 'include',
      headers,
      body,
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new ApiError(response.status, (payload as { error?: string }).error ?? 'http_error', payload)
    }
    workspaceCache.delete(id)
    return payload as { book: BookDto; version: number; entries: WorkspaceEntryDto[] }
  },

  pageVersions: (id: string) => request<{ snapshots: PageSnapshotDto[] }>(`/books/${id}/page-versions`),

  pageVersionText: async (id: string, snapshotId: string): Promise<string> => {
    const response = await fetch(`/api/books/${id}/page-versions/${snapshotId}`, { credentials: 'include' })
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      throw new ApiError(response.status, (payload as { error?: string }).error ?? 'http_error', payload)
    }
    return response.text()
  },

  setPinned: (id: string, snapshotId: string, pinned: boolean) =>
    request<{ snapshot: PageSnapshotDto }>(`/books/${id}/page-versions/${snapshotId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned }),
    }),

  restorePage: (id: string, snapshotId: string) => {
    workspaceCache.delete(id)
    return request<{ version: number; path: string }>(`/books/${id}/page-versions/${snapshotId}/restore`, {
      method: 'POST',
    })
  },

  upload: (file: File) =>
    request<{ book: BookDto }>('/books', {
      method: 'POST',
      headers: { 'content-type': 'application/epub+zip' },
      body: file,
    }),

  agentSettings: () => request<{ settings: AgentUserSettingsDto }>('/agent/settings'),

  updateAgentSettings: (input: {
    defaultApprovalMode?: AgentApprovalMode
    maxSteps?: number
    customInstructions?: string
  }) =>
    request<{ settings: AgentUserSettingsDto }>('/agent/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),

  agentProfiles: () => request<{ secretConfigured: boolean; profiles: AgentProfileDto[] }>('/agent/profiles'),

  createAgentProfile: (input: AgentProfileCreateInput) =>
    request<{ profile: AgentProfileDto }>('/agent/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),

  updateAgentProfile: (profileId: string, input: AgentProfileUpdateInput) =>
    request<{ profile: AgentProfileDto }>(`/agent/profiles/${profileId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),

  deleteAgentProfile: (profileId: string) =>
    request<void>(`/agent/profiles/${profileId}`, { method: 'DELETE' }),

  testAgentProfile: (input: {
    profileId?: string
    provider: AgentProviderType
    baseUrl: string
    model: string
    apiKey?: string
  }) =>
    request<AgentConnectionTestResult>('/agent/profiles/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),

  fetchAgentProfileModels: (input: {
    profileId?: string
    provider: AgentProviderType
    baseUrl: string
    apiKey?: string
  }) =>
    request<AgentProviderModelsResult>('/agent/profiles/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),

  agentThreads: (bookId: string) => request<{ threads: AgentThreadDto[] }>(`/books/${bookId}/agent/threads`),

  createAgentThread: (
    bookId: string,
    input: { title?: string; profileId?: string; model?: string; approvalMode?: AgentApprovalMode } = {},
  ) =>
    request<{ thread: AgentThreadDto }>(`/books/${bookId}/agent/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),

  agentThread: (bookId: string, threadId: string) =>
    request<{ thread: AgentThreadDto; messages: AgentMessageDto[] }>(
      `/books/${bookId}/agent/threads/${threadId}`,
    ),

  updateAgentThread: (
    bookId: string,
    threadId: string,
    input: {
      title?: string
      profileId?: string | null
      model?: string | null
      approvalMode?: AgentApprovalMode
    },
  ) =>
    request<{ thread: AgentThreadDto }>(`/books/${bookId}/agent/threads/${threadId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),

  deleteAgentThread: (bookId: string, threadId: string) =>
    request<void>(`/books/${bookId}/agent/threads/${threadId}`, { method: 'DELETE' }),

  updateProposalStatus: (bookId: string, messageId: string, status: 'applied' | 'dismissed') =>
    request<{ message: AgentMessageDto }>(`/books/${bookId}/agent/proposals/${messageId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    }),

  abortAgentThread: (bookId: string, threadId: string) =>
    request<{ aborted: boolean }>(`/books/${bookId}/agent/threads/${threadId}/abort`, {
      method: 'POST',
      keepalive: true,
    }),

  streamAgentMessage: async (
    bookId: string,
    threadId: string,
    body: {
      content: string
      profileId?: string
      model?: string
      approvalMode?: AgentApprovalMode
      baseVersion: number
      dirtyTexts?: Record<string, string>
      deletedPaths?: string[]
      context?: { activePath?: string | null; selection?: string | null }
    },
    options: { onEvent: (event: AgentSseEvent) => void; signal?: AbortSignal },
  ): Promise<void> => {
    const response = await fetch(`/api/books/${bookId}/agent/threads/${threadId}/messages`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: options.signal,
    })
    await consumeAgentSse(response, options.onEvent, options.signal)
  },

  retryAgentMessage: async (
    bookId: string,
    threadId: string,
    messageId: string,
    body: {
      profileId?: string
      model?: string
      approvalMode?: AgentApprovalMode
      baseVersion: number
      dirtyTexts?: Record<string, string>
      deletedPaths?: string[]
    },
    options: { onEvent: (event: AgentSseEvent) => void; signal?: AbortSignal },
  ): Promise<void> => {
    const response = await fetch(`/api/books/${bookId}/agent/threads/${threadId}/messages/${messageId}/retry`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: options.signal,
    })
    await consumeAgentSse(response, options.onEvent, options.signal)
  },
}

export const coverUrl = (id: string): string => `/api/books/${id}/cover`

/** Direct link so the browser's download manager streams the pack instead of JS buffering it. */
export const downloadUrl = (id: string): string => `/api/books/${id}/download`

/**
 * Origin-qualified URL for a single book entry. Preview and WYSIWYG run inside `iframe srcDoc`
 * where relative URLs fail against `about:srcdoc`, so the host origin must be prepended.
 * See ADR 2026-11-20-entry-level-book-storage.
 */
export function entryAssetUrl(bookId: string, path: string, sha256?: string | null): string {
  const origin =
    typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null'
      ? window.location.origin
      : ''
  const query = `path=${encodeURIComponent(path)}${sha256 ? `&sha=${encodeURIComponent(sha256)}` : ''}`
  return `${origin}/api/books/${bookId}/entry?${query}`
}
