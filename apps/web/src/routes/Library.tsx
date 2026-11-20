import { createEmptyEpub } from '@booksmith/core'
import { AlertCircle, BookOpen, LogOut, Plus, Settings, Upload } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api, type BookDto, type UserDto } from '../api/client'
import { BookCard } from '../ui/BookCard'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { EmptyState } from '../ui/EmptyState'
import { SearchBar } from '../ui/SearchBar'
import { SettingsDialog } from '../ui/SettingsDialog'
import { navigate } from '../router'
import { clearDraft } from '../state/draftStore'

function messageFor(error: unknown, action = '操作失败'): string {
  if (error instanceof ApiError) {
    if (error.code === 'invalid_epub') return '这个文件不是有效的 EPUB，检查后重试'
    if (error.code === 'unauthenticated') return '登录已过期，请重新登录'
    if (error.code === 'not_found') return '这本书不存在或已被删除'
    return `${action}（${error.code}）`
  }
  return '网络异常，请稍后重试'
}

export function Library({ user, onLogout }: { user: UserDto; onLogout: () => void }) {
  const [books, setBooks] = useState<BookDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newAuthor, setNewAuthor] = useState('')
  const [creatingPending, setCreatingPending] = useState(false)
  const [deletingBook, setDeletingBook] = useState<BookDto | null>(null)
  const [deletingPending, setDeletingPending] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await api.books()
      setBooks(result.books)
    } catch (cause) {
      setError(messageFor(cause, '加载书库失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function upload(file: File) {
    setUploading(true)
    setError(null)
    try {
      const { book } = await api.upload(file)
      setBooks((current) => [book, ...current])
    } catch (cause) {
      setError(messageFor(cause, '导入失败'))
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  async function createBook() {
    if (creatingPending) return
    setCreatingPending(true)
    setError(null)
    try {
      const title = newTitle.trim() || '未命名'
      const bytes = createEmptyEpub({ title, author: newAuthor })
      const file = new File([bytes as BlobPart], `${title}.epub`, { type: 'application/epub+zip' })
      const { book } = await api.upload(file)
      setBooks((current) => [book, ...current])
      setCreating(false)
      setNewTitle('')
      setNewAuthor('')
      navigate(`/books/${book.id}`)
    } catch (cause) {
      setError(messageFor(cause, '创建失败'))
    } finally {
      setCreatingPending(false)
    }
  }

  function requestDelete(book: BookDto) {
    setDeleteError(null)
    setDeletingBook(book)
  }

  async function confirmDelete() {
    if (!deletingBook || deletingPending) return
    const target = deletingBook
    setDeletingPending(true)
    setDeleteError(null)
    try {
      await api.deleteBook(target.id)
      void clearDraft(target.id)
      setBooks((current) => current.filter((item) => item.id !== target.id))
      setDeletingBook(null)
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'not_found') {
        void clearDraft(target.id)
        setBooks((current) => current.filter((item) => item.id !== target.id))
        setDeletingBook(null)
        return
      }
      setDeleteError(messageFor(cause, '删除失败'))
    } finally {
      setDeletingPending(false)
    }
  }

  const needle = query.trim().toLowerCase()
  const filtered = needle
    ? books.filter(
        (book) =>
          book.title.toLowerCase().includes(needle) || book.author.toLowerCase().includes(needle),
      )
    : books

  return (
    <div
      className="library-shell"
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        const file = event.dataTransfer.files[0]
        if (file) void upload(file)
      }}
    >
      {/* Library is a floating gallery without the 28px workbench bottom statusbar. See ADR 2026-11-20-soft-craft-studio-ui. */}
      <header className="library-header">
        <div className="library-header-inner">
          <div className="library-brand-group">
            <span className="brand">
              <span className="brand-badge" aria-hidden="true">
                <BookOpen size={16} strokeWidth={1.8} />
              </span>
              <span className="brand-name">Booksmith</span>
            </span>
            <span className="library-count-pill">
              {needle ? `${filtered.length} / ${books.length} 本` : `${books.length} 本`}
            </span>
          </div>

          <SearchBar value={query} onChange={setQuery} placeholder="搜索书名或作者" />

          <div className="library-actions">
            <Button variant="secondary" onClick={() => setCreating(true)}>
              <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>新建书</span>
            </Button>
            <Button variant="primary" onClick={() => fileInput.current?.click()} disabled={uploading}>
              <Upload size={14} strokeWidth={1.75} aria-hidden="true" />
              {uploading ? (
                <span>导入中…</span>
              ) : (
                <>
                  <span className="btn-label-full">导入 EPUB</span>
                  <span className="btn-label-short">导入</span>
                </>
              )}
            </Button>
            <Button
              variant="ghost"
              aria-label="设置"
              onClick={() => setSettingsOpen(true)}
              title="应用设置"
            >
              <Settings size={14} strokeWidth={1.65} aria-hidden="true" />
              <span className="btn-label-full">设置</span>
            </Button>
            <span className="library-user-email" title={user.email}>
              {user.email}
            </span>
            <Button variant="ghost" onClick={onLogout}>
              <LogOut size={14} strokeWidth={1.65} aria-hidden="true" />
              <span>退出</span>
            </Button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".epub,application/epub+zip"
            hidden
            data-testid="upload-input"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void upload(file)
            }}
          />
        </div>
      </header>

      <main className={`library${dragging ? ' is-dragging' : ''}`}>
        {error ? (
          <p className="banner banner-error" role="alert">
            <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{error}</span>
            <button type="button" className="banner-action" onClick={() => void load()}>
              重试
            </button>
          </p>
        ) : null}

        {loading ? (
          <div className="book-grid" aria-busy="true" aria-label="正在载入书库">
            {Array.from({ length: 6 }).map((_, index) => (
              <div className="book-card-wrap skeleton" key={index}>
                <div className="book-card">
                  <span className="book-cover skeleton-block" />
                  <span className="skeleton-line" />
                  <span className="skeleton-line short" />
                </div>
              </div>
            ))}
          </div>
        ) : books.length === 0 ? (
          <EmptyState
            title="书库还是空的"
            description="导入一本 EPUB 开始编辑，也可以直接把文件拖进这个窗口。"
            action={
              <Button variant="primary" onClick={() => fileInput.current?.click()}>
                选择 EPUB 文件
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={`没有匹配「${query.trim()}」的书`}
            description="试试书名的一部分，或者清空关键词。"
            action={
              <Button variant="secondary" onClick={() => setQuery('')}>
                清空搜索
              </Button>
            }
          />
        ) : (
          <div className="book-grid">
            {filtered.map((book) => (
              <BookCard
                key={book.id}
                book={book}
                onOpen={(id) => navigate(`/books/${id}`)}
                onDelete={requestDelete}
              />
            ))}
          </div>
        )}
      </main>

      <Dialog
        open={creating}
        onOpenChange={setCreating}
        ariaLabel="新建书"
        title="新建一本 EPUB"
        description="生成一个最小可用的 EPUB 3 骨架，之后在编辑器里补内容。"
        onSubmit={(event) => {
          event.preventDefault()
          if (!creatingPending) void createBook()
        }}
        footer={
          <>
            <Button variant="ghost" type="button" onClick={() => setCreating(false)}>
              取消
            </Button>
            <Button variant="primary" type="submit" disabled={creatingPending}>
              {creatingPending ? '创建中…' : '创建并打开'}
            </Button>
          </>
        }
      >
        <label className="panel-field">
          <span>书名</span>
          <input
            autoFocus
            type="text"
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
          />
        </label>
        <label className="panel-field">
          <span>作者（可留空）</span>
          <input type="text" value={newAuthor} onChange={(event) => setNewAuthor(event.target.value)} />
        </label>
      </Dialog>

      <Dialog
        open={Boolean(deletingBook)}
        onOpenChange={(open) => {
          if (!open && !deletingPending) {
            setDeletingBook(null)
            setDeleteError(null)
          }
        }}
        ariaLabel="删除书籍"
        title={deletingBook ? `删除《${deletingBook.title}》` : ''}
        description="删除后这本书的 EPUB 文件、历史快照和 AI 对话记录都会一并移除，且无法恢复。"
        footer={
          <>
            <Button
              variant="ghost"
              type="button"
              disabled={deletingPending}
              onClick={() => {
                setDeletingBook(null)
                setDeleteError(null)
              }}
            >
              取消
            </Button>
            <Button
              variant="danger"
              type="button"
              disabled={deletingPending}
              onClick={() => void confirmDelete()}
            >
              {deletingPending ? '删除中…' : '删除'}
            </Button>
          </>
        }
      >
        {deleteError ? (
          <p className="banner banner-error" role="alert">
            <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{deleteError}</span>
          </p>
        ) : null}
      </Dialog>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  )
}
