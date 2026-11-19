export interface UserDto {
  id: string
  email: string
  role: string
}

export interface VersionDto {
  versionNo: number
  byteSize: number
  sha256: string
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

  save: async (id: string, version: number, bytes: Uint8Array): Promise<{ version: number }> => {
    const copy = new Uint8Array(bytes.length)
    copy.set(bytes)
    const response = await fetch(`/api/books/${id}/epub`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/epub+zip', 'if-match': `"${version}"` },
      body: copy.buffer,
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new ApiError(response.status, (payload as { error?: string }).error ?? 'http_error', payload)
    }
    return payload as { version: number }
  },

  versions: (id: string) => request<{ versions: VersionDto[] }>(`/books/${id}/versions`),

  restore: (id: string, versionNo: number) =>
    request<{ version: number; restoredFrom: number }>(`/books/${id}/versions/${versionNo}/restore`, {
      method: 'POST',
    }),

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
}

export const coverUrl = (id: string): string => `/api/books/${id}/cover`
