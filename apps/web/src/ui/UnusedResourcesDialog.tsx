import type { UnusedResource, UnusedResourceCategory } from '@booksmith/core'
import { CheckCircle2, FileCode2, FileType, Image as ImageIcon, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { formatBytes } from '../format'
import type { PreviewAssetResolver } from '../preview/render'
import { basename } from '../state/bookStore'
import { Button } from './Button'
import { Dialog } from './Dialog'

interface UnusedResourcesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  resources: UnusedResource[]
  resolveAsset?: PreviewAssetResolver
  onConfirmDelete: (paths: string[]) => void
}

const CATEGORY_META: Record<UnusedResourceCategory, { label: string; icon: typeof ImageIcon }> = {
  image: { label: '图片', icon: ImageIcon },
  font: { label: '字体', icon: FileType },
  stylesheet: { label: '未关联样式表', icon: FileCode2 },
}

const CATEGORY_ORDER: UnusedResourceCategory[] = ['image', 'font', 'stylesheet']

/**
 * Grouped cleanup dialog for unreferenced media, fonts, and unlinked CSS (`width: min(560px, calc(100vw - 32px))`).
 * Cover images (`cover-image` / EPUB2 cover) are excluded upstream in `@booksmith/core`.
 * See ADR 2026-11-21-chapter-structure-and-resource-tools.
 */
export function UnusedResourcesDialog({
  open,
  onOpenChange,
  resources,
  resolveAsset,
  onConfirmDelete,
}: UnusedResourcesDialogProps) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(resources.map((r) => r.path)))

  useEffect(() => {
    if (open) {
      setSelected(new Set(resources.map((r) => r.path)))
    }
  }, [open, resources])

  const thumbnails = useMemo(() => {
    const urls = new Map<string, string>()
    const blobs: string[] = []
    if (!open || !resolveAsset) return { urls, blobs }

    for (const item of resources) {
      if (item.category !== 'image') continue
      const resolved = resolveAsset(item.path)
      if (!resolved) continue
      if (resolved.kind === 'url') {
        urls.set(item.path, resolved.url)
      } else {
        const copy = new Uint8Array(resolved.bytes.length)
        copy.set(resolved.bytes)
        const url = URL.createObjectURL(new Blob([copy.buffer], { type: resolved.mime }))
        urls.set(item.path, url)
        blobs.push(url)
      }
    }
    return { urls, blobs }
  }, [open, resources, resolveAsset])

  useEffect(() => {
    return () => {
      for (const url of thumbnails.blobs) URL.revokeObjectURL(url)
    }
  }, [thumbnails])

  const grouped = useMemo(() => {
    return CATEGORY_ORDER.map((cat) => ({
      category: cat,
      ...CATEGORY_META[cat],
      items: resources.filter((item) => item.category === cat),
    })).filter((group) => group.items.length > 0)
  }, [resources])

  const selectedBytes = useMemo(
    () => resources.filter((r) => selected.has(r.path)).reduce((sum, r) => sum + r.byteSize, 0),
    [resources, selected],
  )

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const allSelected = resources.length > 0 && selected.size === resources.length

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="清理未引用资源"
      title="清理未引用资源"
      description={
        resources.length > 0
          ? '以下资源未在任何正文、样式表或目录中被引用（已自动排除书籍封面）。清理后可通过底部撤销条还原。'
          : undefined
      }
      className="unused-resources-dialog"
      footer={
        resources.length > 0 ? (
          <>
            <Button variant="ghost" type="button" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              type="button"
              disabled={selected.size === 0}
              onClick={() => {
                onConfirmDelete(Array.from(selected))
                onOpenChange(false)
              }}
            >
              <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
              <span>
                删除选中的 {selected.size} 项{selectedBytes > 0 ? `（${formatBytes(selectedBytes)}）` : ''}
              </span>
            </Button>
          </>
        ) : (
          <Button variant="primary" type="button" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        )
      }
    >
      {resources.length === 0 ? (
        <div className="structure-empty">
          <CheckCircle2 size={22} strokeWidth={1.6} className="structure-empty-ok" aria-hidden="true" />
          <p className="structure-empty-title">没有发现未引用资源</p>
          <p className="structure-empty-desc">当前所有图片、字体与样式表都已被正文或样式引用。</p>
        </div>
      ) : (
        <div className="unused-dialog-content">
          <div className="unused-select-bar">
            <span className="unused-summary">
              共发现 {resources.length} 项未引用资源
            </span>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => setSelected(allSelected ? new Set() : new Set(resources.map((r) => r.path)))}
            >
              {allSelected ? '取消全选' : '全选'}
            </Button>
          </div>

          <div className="unused-groups">
            {grouped.map((group) => {
              const Icon = group.icon
              return (
                <section key={group.category} className="unused-group">
                  <h3 className="unused-group-title">
                    <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
                    <span>{group.label}</span>
                    <span className="unused-group-count">{group.items.length}</span>
                  </h3>
                  <ul className="unused-list" role="list">
                    {group.items.map((item) => {
                      const thumb = thumbnails.urls.get(item.path)
                      return (
                        <li key={item.path} className="unused-row">
                          <label className="unused-option">
                            <input
                              type="checkbox"
                              checked={selected.has(item.path)}
                              onChange={() => toggle(item.path)}
                            />
                            {item.category === 'image' && thumb ? (
                              <img src={thumb} alt="" className="unused-thumb" />
                            ) : (
                              <span className="unused-thumb-fallback" aria-hidden="true">
                                <Icon size={14} strokeWidth={1.65} />
                              </span>
                            )}
                            <span className="unused-copy">
                              <span className="unused-name" title={item.path}>
                                {basename(item.path)}
                              </span>
                              <span className="unused-path" title={item.path}>
                                {item.path}
                              </span>
                            </span>
                            <span className="unused-size">{formatBytes(item.byteSize)}</span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )
            })}
          </div>
        </div>
      )}
    </Dialog>
  )
}
