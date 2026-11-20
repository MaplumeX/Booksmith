import { FileArchive, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { basename } from '../state/bookStore'
import { Button } from './Button'
import { Dialog } from './Dialog'

interface MediaPaneProps {
  path: string
  bytes?: Uint8Array
  srcUrl?: string | null
  byteSize?: number
  mime: string
  onReplace: (path: string, file: File) => void
  onDelete: (path: string) => void
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/** Read-only view for archive entries that have no text form, e.g. images and fonts. */
export function MediaPane({ path, bytes, srcUrl, byteSize, mime, onReplace, onDelete }: MediaPaneProps) {
  const isImage = mime.startsWith('image/')
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [pending, setPending] = useState<File | null>(null)
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isImage || !bytes) {
      setBlobUrl(null)
      return
    }
    const copy = new Uint8Array(bytes.length)
    copy.set(bytes)
    const next = URL.createObjectURL(new Blob([copy.buffer], { type: mime }))
    setBlobUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [bytes, mime, isImage])

  const imageUrl = blobUrl ?? srcUrl ?? null
  const resolvedSize = bytes ? bytes.length : byteSize
  const meta = resolvedSize !== undefined ? `${mime} · ${formatBytes(resolvedSize)}` : `${mime} · 文件缺失`

  return (
    <div className="media-pane">
      {isImage && imageUrl ? (
        <div className="media-frame">
          <img className="media-image" src={imageUrl} alt={basename(path)} />
        </div>
      ) : null}
      {!isImage ? (
        <div className="media-binary-badge">
          <FileArchive size={28} strokeWidth={1.5} aria-hidden="true" />
          <p className="media-note">这是二进制资源，不能在编辑器里修改文字。</p>
        </div>
      ) : null}
      <p className="media-meta">
        {basename(path)} · {meta}
      </p>

      <div className="media-actions">
        {isImage ? (
          <Button variant="secondary" onClick={() => picker.current?.click()}>
            <RefreshCw size={14} strokeWidth={1.65} aria-hidden="true" />
            <span>替换图片</span>
          </Button>
        ) : null}
        <Button variant="ghost" className="btn-danger-ghost" onClick={() => onDelete(path)}>
          <Trash2 size={14} strokeWidth={1.65} aria-hidden="true" />
          <span>删除</span>
        </Button>
      </div>

      <input
        ref={picker}
        type="file"
        accept="image/*"
        hidden
        aria-label={`替换 ${basename(path)}`}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) setPending(file)
        }}
      />

      <Dialog
        open={Boolean(pending)}
        onOpenChange={(openState) => {
          if (!openState) setPending(null)
        }}
        ariaLabel="替换图片"
        title={`替换 ${basename(path)}`}
        description={
          pending
            ? `用「${pending.name}」覆盖这个条目，路径与 manifest 项不变。图片不进快照历史，替换后无法退回旧图。`
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" type="button" onClick={() => setPending(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              type="button"
              onClick={() => {
                if (pending) onReplace(path, pending)
                setPending(null)
              }}
            >
              替换
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </div>
  )
}
