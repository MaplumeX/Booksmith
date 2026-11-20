import { Download } from 'lucide-react'
import { coverUrl, downloadUrl, type BookDto } from '../api/client'
import { formatBytes, formatRelative } from '../format'

interface BookCardProps {
  book: BookDto
  onOpen: (id: string) => void
}

export function BookCard({ book, onOpen }: BookCardProps) {
  return (
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
      <a className="book-download" href={downloadUrl(book.id)} download title={`下载 ${book.title} 的 EPUB`}>
        <Download size={11} strokeWidth={1.75} aria-hidden="true" />
        <span>下载</span>
      </a>
    </div>
  )
}
