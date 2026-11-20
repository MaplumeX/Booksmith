import { BookOpen, Download, Trash2 } from 'lucide-react'
import { coverUrl, downloadUrl, type BookDto } from '../api/client'
import { formatBytes, formatRelative } from '../format'
import { ContextMenu, type ContextMenuEntry } from './ContextMenu'

interface BookCardProps {
  book: BookDto
  onOpen: (id: string) => void
  onDelete: (book: BookDto) => void
}

function triggerDownload(book: BookDto): void {
  const link = document.createElement('a')
  link.href = downloadUrl(book.id)
  link.download = ''
  document.body.append(link)
  link.click()
  link.remove()
}

export function BookCard({ book, onOpen, onDelete }: BookCardProps) {
  const menuItems: ContextMenuEntry[] = [
    {
      id: 'open',
      label: '打开编辑',
      icon: <BookOpen size={14} strokeWidth={1.6} />,
      onSelect: () => onOpen(book.id),
    },
    {
      id: 'download',
      label: '下载 EPUB',
      icon: <Download size={14} strokeWidth={1.6} />,
      onSelect: () => triggerDownload(book),
    },
    {
      id: 'delete',
      label: '删除书籍',
      icon: <Trash2 size={14} strokeWidth={1.6} />,
      danger: true,
      separatorBefore: true,
      opensDialog: true,
      onSelect: () => onDelete(book),
    },
  ]

  return (
    <ContextMenu
      ariaLabel={`${book.title} 的操作`}
      header={
        <>
          <BookOpen size={13} strokeWidth={1.75} aria-hidden="true" />
          <span className="context-menu-title" title={book.title}>
            {book.title}
          </span>
        </>
      }
      items={menuItems}
    >
      <div className="book-card-wrap">
        <button type="button" className="book-card" onClick={() => onOpen(book.id)}>
          <span className="book-cover">
            {book.hasCover ? (
              <img src={coverUrl(book.id)} alt="" loading="lazy" />
            ) : (
              <span className="book-cover-fallback" aria-hidden="true">
                {book.title.slice(0, 1)}
              </span>
            )}
          </span>
          <span className="book-title" title={book.title}>
            {book.title}
          </span>
          <span className="book-author">{book.author || '未知作者'}</span>
          <span className="book-meta">
            {book.chapterCount} 章 · {formatBytes(book.byteSize)} · {formatRelative(book.updatedAt)}
          </span>
        </button>
        <div className="book-card-actions">
          <a className="book-download" href={downloadUrl(book.id)} download title={`下载 ${book.title} 的 EPUB`}>
            <Download size={11} strokeWidth={1.75} aria-hidden="true" />
            <span>下载</span>
          </a>
          <button
            type="button"
            className="book-delete"
            aria-label="删除"
            title={`删除《${book.title}》`}
            onClick={() => onDelete(book)}
          >
            <Trash2 size={12} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </div>
    </ContextMenu>
  )
}
