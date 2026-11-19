import { useEffect, useRef, useState } from 'react'
import { basename } from '../state/bookStore'
import { Button } from './Button'

interface MediaPaneProps {
  path: string
  bytes: Uint8Array | undefined
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
export function MediaPane({ path, bytes, mime, onReplace, onDelete }: MediaPaneProps) {
  const isImage = mime.startsWith('image/')
  const [url, setUrl] = useState<string | null>(null)
  const [pending, setPending] = useState<File | null>(null)
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isImage || !bytes) return
    const copy = new Uint8Array(bytes.length)
    copy.set(bytes)
    const next = URL.createObjectURL(new Blob([copy.buffer], { type: mime }))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [bytes, mime, isImage])

  const meta = bytes ? `${mime} · ${formatBytes(bytes.length)}` : `${mime} · 文件缺失`

  return (
    <div className="media-pane">
      {isImage && url ? <img className="media-image" src={url} alt={basename(path)} /> : null}
      {!isImage ? <p className="media-note">这是二进制资源，不能在编辑器里修改文字。</p> : null}
      <p className="media-meta">
        {basename(path)} · {meta}
      </p>

      <div className="media-actions">
        {isImage ? (
          <Button variant="secondary" onClick={() => picker.current?.click()}>
            替换图片
          </Button>
        ) : null}
        <Button variant="ghost" onClick={() => onDelete(path)}>
          删除
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

      {pending ? (
        <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="替换图片">
          <div className="dialog">
            <h2>替换 {basename(path)}</h2>
            <p className="panel-note">
              用「{pending.name}」覆盖这个条目，路径与 manifest 项不变。图片不进快照历史，替换后无法退回旧图。
            </p>
            <div className="dialog-actions">
              <Button
                variant="primary"
                onClick={() => {
                  onReplace(path, pending)
                  setPending(null)
                }}
              >
                替换
              </Button>
              <Button variant="ghost" onClick={() => setPending(null)}>
                取消
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
