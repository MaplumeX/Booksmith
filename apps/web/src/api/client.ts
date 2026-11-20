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

export type AgentProviderType = 'openai-compatible' | 'anthropic'

export interface AgentProfileDto {
  id: string
  name: string
  provider: AgentProviderType
  baseUrl: string
  model: string
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
  apiKey?: string
  isDefault?: boolean
}

export interface AgentProfileUpdateInput {
  name?: string
  provider?: AgentProviderType
  baseUrl?: string
  model?: string
  apiKey?: string
  clearApiKey?: boolean
  isDefault?: boolean
}

export interface AgentConnectionTestResult {
  ok: boolean
  latencyMs: number
  reply?: string
  errorCode?: string
  error?: string
}

export interface AgentThreadDto {
  id: string
  bookId: string
  title: string
  profileId: string | null
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
  context: { activePath?: string | null; selection?: string | null } | null
  toolCalls: AgentToolCallDto[]
  proposal: AgentProposal | null
  proposalStatus: 'pending' | 'applied' | 'dismissed' | null
  error: string | null
  createdAt: string
}

export type AgentSseEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; id: string; name: AgentToolName; argsSummary: string }
  | { type: 'tool_end'; id: string; name: AgentToolName; ok: boolean; summary: string }
  | { type: 'proposal'; proposal: AgentProposal }
  | { type: 'done'; messageId?: string; threadTitle?: string; stopped: boolean }
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

export const api = {
  me: () => request<{ user: UserDto | null }>('/auth/me'),

  login: (email: string, password: string) =>
    request<{ user: UserDto }>('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),

  logout: () => request<void>('/auth/logout', { method: 'POST' }),

  books: () => request<{ books: BookDto[] }>('/books'),

  deleteBook: (id: string) => request<void>(`/books/${id}`, { method: 'DELETE' }),

  save: async (id: string, version: number, bytes: Uint8Array, options: { checkpoint?: boolean } = {}): Promise<{ version: number }> => {
    const copy = new Uint8Array(bytes.length)
    copy.set(bytes)
    const headers: Record<string, string> = { 'content-type': 'application/epub+zip', 'if-match': `"${version}"` }
    if (options.checkpoint) headers['x-booksmith-checkpoint'] = 'manual'
    const response = await fetch(`/api/books/${id}/epub`, {
      method: 'PUT',
      credentials: 'include',
      headers,
      body: copy.buffer,
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new ApiError(response.status, (payload as { error?: string }).error ?? 'http_error', payload)
    }
    return payload as { version: number }
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

  restorePage: (id: string, snapshotId: string) =>
    request<{ version: number; path: string }>(`/books/${id}/page-versions/${snapshotId}/restore`, { method: 'POST' }),

  upload: (file: File) =>
    request<{ book: BookDto }>('/books', {
      method: 'POST',
      headers: { 'content-type': 'application/epub+zip' },
      body: file,
    }),

  epub: async (id: string): Promise<{ bytes: Uint8Array; version: number }> => {
    const response = await fetch(`/api/books/${id}/epub`, { credentials: 'include' })
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      throw new ApiError(response.status, (payload as { error?: string }).error ?? 'http_error', payload)
    }
    const etag = response.headers.get('etag') ?? ''
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      version: Number(etag.replace(/[^0-9]/g, '')) || 0,
    }
  },

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

  agentThreads: (bookId: string) => request<{ threads: AgentThreadDto[] }>(`/books/${bookId}/agent/threads`),

  createAgentThread: (bookId: string, input: { title?: string; profileId?: string } = {}) =>
    request<{ thread: AgentThreadDto }>(`/books/${bookId}/agent/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),

  agentThread: (bookId: string, threadId: string) =>
    request<{ thread: AgentThreadDto; messages: AgentMessageDto[] }>(
      `/books/${bookId}/agent/threads/${threadId}`,
    ),

  updateAgentThread: (bookId: string, threadId: string, input: { title?: string; profileId?: string | null }) =>
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

  streamAgentMessage: async (
    bookId: string,
    threadId: string,
    body: {
      content: string
      profileId?: string
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

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      const code = (payload as { error?: string }).error ?? `http_${response.status}`
      throw new ApiError(response.status, code, payload)
    }

    if (!response.body) throw new ApiError(500, 'empty_stream', {})

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const chunks = buffer.split('\n\n')
      buffer = chunks.pop() ?? ''
      for (const chunk of chunks) {
        const line = chunk
          .split('\n')
          .find((entry) => entry.startsWith('data: '))
        if (!line) continue
        try {
          const parsed = JSON.parse(line.slice(6)) as AgentSseEvent
          options.onEvent(parsed)
        } catch {
          // Ignore malformed keepalive frames.
        }
      }
    }

    const tail = buffer.trim()
    if (tail.startsWith('data: ')) {
      try {
        options.onEvent(JSON.parse(tail.slice(6)) as AgentSseEvent)
      } catch {
        // Ignore incomplete tail on abrupt disconnect.
      }
    }
  },
}

export const coverUrl = (id: string): string => `/api/books/${id}/cover`

/** Direct link so the browser's download manager streams the pack instead of JS buffering it. */
export const downloadUrl = (id: string): string => `/api/books/${id}/download`
