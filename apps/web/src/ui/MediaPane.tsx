import { useEffect, useState } from 'react'
import { basename } from '../state/bookStore'

interface MediaPaneProps {
  path: string
  bytes: Uint8Array | undefined
  mime: string
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/** Read-only view for archive entries that have no text form, e.g. images and fonts. */
export function MediaPane({ path, bytes, mime }: MediaPaneProps) {
  const isImage = mime.startsWith('image/')
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!isImage || !bytes) return
    const copy = new Uint8Array(bytes.length)
    copy.set(bytes)
    const next = URL.createObjectURL(new Blob([copy.buffer], { type: mime }))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [bytes, mime, isImage])

  const meta = bytes ? `${mime} · ${formatBytes(bytes.length)}` : `${mime} · 文件缺失`

  if (isImage) {
    return (
      <div className="media-pane">
        {url ? <img className="media-image" src={url} alt={basename(path)} /> : null}
        <p className="media-meta">
          {basename(path)} · {meta}
        </p>
      </div>
    )
  }

  return (
    <div className="media-pane">
      <p className="media-note">这是二进制资源，不能在编辑器里修改。</p>
      <p className="media-meta">
        {basename(path)} · {meta}
      </p>
    </div>
  )
}
