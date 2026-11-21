import { FileCode2, Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { basename } from '../state/bookStore'
import { Button } from './Button'
import { Dialog } from './Dialog'

type CheckState = 'all' | 'none' | 'some'

interface LinkStylesheetsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  chapterPaths: string[]
  stylesheets: string[]
  linkedByChapter: Map<string, string[]>
  onApply: (delta: { add: string[]; remove: string[] }) => void
  onCreateStylesheet: (filename?: string) => { path: string } | { error: string }
}

/**
 * Multi-chapter stylesheet linker dialog (`width: min(480px, calc(100vw - 32px))`).
 * Supports tri-state (indeterminate) checkboxes when editing multiple chapters at once.
 * See ADR 2026-11-21-chapter-structure-and-resource-tools.
 */
export function LinkStylesheetsDialog({
  open,
  onOpenChange,
  chapterPaths,
  stylesheets,
  linkedByChapter,
  onApply,
  onCreateStylesheet,
}: LinkStylesheetsDialogProps) {
  const initialStates = useMemo(() => {
    const map = new Map<string, CheckState>()
    const total = chapterPaths.length
    for (const css of stylesheets) {
      let count = 0
      for (const ch of chapterPaths) {
        if (linkedByChapter.get(ch)?.includes(css)) count += 1
      }
      if (count === 0) map.set(css, 'none')
      else if (count === total) map.set(css, 'all')
      else map.set(css, 'some')
    }
    return map
  }, [chapterPaths, stylesheets, linkedByChapter])

  const [states, setStates] = useState<Map<string, CheckState>>(initialStates)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setStates(new Map(initialStates))
      setCreating(false)
      setNewName('')
      setCreateError(null)
    }
  }, [open, initialStates])

  const toggle = (cssPath: string) => {
    setStates((prev) => {
      const next = new Map(prev)
      const current = next.get(cssPath) ?? 'none'
      next.set(cssPath, current === 'all' ? 'none' : 'all')
      return next
    })
  }

  const handleCreate = () => {
    const result = onCreateStylesheet(newName.trim() || undefined)
    if ('error' in result) {
      setCreateError(result.error)
      return
    }
    setStates((prev) => {
      const next = new Map(prev)
      next.set(result.path, 'all')
      return next
    })
    setCreating(false)
    setNewName('')
    setCreateError(null)
  }

  const delta = useMemo(() => {
    const add: string[] = []
    const remove: string[] = []
    for (const css of stylesheets) {
      const next = states.get(css) ?? 'none'
      const orig = initialStates.get(css) ?? 'none'
      if (next === orig) continue
      if (next === 'all') add.push(css)
      else if (next === 'none') remove.push(css)
    }
    return { add, remove }
  }, [stylesheets, states, initialStates])

  const hasChanges = delta.add.length > 0 || delta.remove.length > 0
  const title =
    chapterPaths.length <= 1
      ? `关联样式表 · ${chapterPaths[0] ? basename(chapterPaths[0]) : ''}`
      : `为选中的 ${chapterPaths.length} 个章节关联样式表`

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="关联样式表"
      title={title}
      description="勾选要写入章节 <head> 的 CSS 样式表；部分章节已关联的项会显示为半选态，点击后统一应用。"
      className="stylesheets-dialog"
      footer={
        <>
          <Button variant="ghost" type="button" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="primary"
            type="button"
            disabled={!hasChanges}
            onClick={() => {
              onApply(delta)
              onOpenChange(false)
            }}
          >
            应用样式表
          </Button>
        </>
      }
    >
      <div className="stylesheets-dialog-content">
        {stylesheets.length === 0 ? (
          <div className="structure-empty">
            <FileCode2 size={20} strokeWidth={1.6} aria-hidden="true" />
            <p className="structure-empty-title">这本书还没有 CSS 样式表</p>
            <p className="structure-empty-desc">先新建一个空白样式表，再将其关联到章节。</p>
            {!creating ? (
              <Button variant="secondary" size="sm" type="button" onClick={() => setCreating(true)}>
                <Plus size={13} strokeWidth={1.8} aria-hidden="true" />
                <span>新建样式表</span>
              </Button>
            ) : null}
          </div>
        ) : (
          <ul className="stylesheets-list" role="list">
            {stylesheets.map((cssPath) => {
              const st = states.get(cssPath) ?? 'none'
              return (
                <li key={cssPath} className="stylesheets-row">
                  <label className="stylesheets-option">
                    <input
                      type="checkbox"
                      checked={st === 'all'}
                      ref={(el) => {
                        if (el) el.indeterminate = st === 'some'
                      }}
                      onChange={() => toggle(cssPath)}
                    />
                    <FileCode2 size={14} strokeWidth={1.65} className="stylesheets-icon" aria-hidden="true" />
                    <span className="stylesheets-copy">
                      <span className="stylesheets-name" title={cssPath}>
                        {basename(cssPath)}
                      </span>
                      <span className="stylesheets-path" title={cssPath}>
                        {cssPath}
                      </span>
                    </span>
                    {st === 'some' ? <span className="stylesheets-partial">部分已关联</span> : null}
                  </label>
                </li>
              )
            })}
          </ul>
        )}

        {creating ? (
          <div className="stylesheets-create-box">
            <label className="panel-field">
              <span>新样式表文件名（留空自动编号）</span>
              <div className="stylesheets-create-row">
                <input
                  autoFocus
                  type="text"
                  placeholder="例如 theme.css"
                  aria-invalid={createError ? 'true' : undefined}
                  value={newName}
                  onChange={(event) => {
                    setNewName(event.target.value)
                    setCreateError(null)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      handleCreate()
                    }
                  }}
                />
                <Button variant="secondary" size="sm" type="button" onClick={handleCreate}>
                  创建
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => {
                    setCreating(false)
                    setCreateError(null)
                  }}
                >
                  取消
                </Button>
              </div>
            </label>
            {createError ? <p className="banner banner-error">{createError}</p> : null}
          </div>
        ) : stylesheets.length > 0 ? (
          <div className="stylesheets-toolbar">
            <Button variant="ghost" size="sm" type="button" onClick={() => setCreating(true)}>
              <Plus size={13} strokeWidth={1.8} aria-hidden="true" />
              <span>新建样式表</span>
            </Button>
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}
