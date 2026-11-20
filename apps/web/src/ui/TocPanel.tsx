import {
  dirname,
  indentTocEntry,
  insertTocEntry,
  moveTocEntry,
  outdentTocEntry,
  removeTocEntry,
  relativePath,
  updateTocEntry,
  type BrokenAnchor,
  type TocEntry,
} from '@booksmith/core'
import { ArrowDown, ArrowUp, IndentDecrease, IndentIncrease, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from './Button'

interface TocPanelProps {
  entries: TocEntry[]
  broken: BrokenAnchor[]
  /** Used to resolve a chosen file into an href relative to the nav document. */
  tocPath: string
  /** Reading order, offered as options when adding an entry. */
  files: string[]
  suggestTitle: (path: string) => string
  onChange: (next: TocEntry[]) => void
}

interface FlatEntry {
  entry: TocEntry
  depth: number
  path: number[]
}

function flatten(entries: TocEntry[], depth = 0, path: number[] = [], out: FlatEntry[] = []): FlatEntry[] {
  entries.forEach((entry, index) => {
    const nextPath = [...path, index]
    out.push({ entry, depth, path: nextPath })
    flatten(entry.children, depth + 1, nextPath, out)
  })
  return out
}

export function TocPanel({ entries, broken, tocPath, files, suggestTitle, onChange }: TocPanelProps) {
  const [editing, setEditing] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [target, setTarget] = useState('')
  const [label, setLabel] = useState('')
  const brokenHrefs = useMemo(() => new Set(broken.map((entry) => entry.href)), [broken])
  const flat = useMemo(() => flatten(entries), [entries])

  function rename(path: number[], nextLabel: string) {
    const trimmed = nextLabel.trim()
    if (!trimmed) return
    onChange(updateTocEntry(entries, path, (entry) => ({ ...entry, label: trimmed, rawHtml: '' })))
    setEditing(null)
  }

  const options = files.map((file) => relativePath(dirname(tocPath), file))

  function pickTarget(value: string) {
    setTarget(value)
    if (label.trim()) return
    const anchor = value.split('#')[0] ?? ''
    if (!anchor) return
    setLabel(suggestTitle(anchor))
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const href = target.trim()
    const title = label.trim()
    if (!href || !title) return
    onChange(insertTocEntry(entries, [], { label: title, href, rawHtml: '', children: [] }))
    setAdding(false)
    setTarget('')
    setLabel('')
  }

  return (
    <div className="toc-panel">
      <p className="panel-note">
        {flat.length} 项 · 改名请直接点标题，改完回车。保存时 nav 与 NCX 会同步。
        {broken.length > 0 ? ` ${broken.length} 个锚点找不到目标。` : ''}
      </p>

      {adding ? (
        <form className="toc-add" onSubmit={submit}>
          <label className="panel-field">
            <span>目标文件</span>
            <input
              autoFocus
              list="toc-files"
              value={target}
              placeholder="text/ch026.xhtml 或 text/ch001.xhtml#sec"
              onChange={(event) => pickTarget(event.target.value)}
            />
          </label>
          <datalist id="toc-files">
            {options.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
          <label className="panel-field">
            <span>标题</span>
            <input value={label} placeholder="这一章的标题" onChange={(event) => setLabel(event.target.value)} />
          </label>
          <div className="toc-add-actions">
            <Button variant="primary" size="sm" type="submit" disabled={!target.trim() || !label.trim()}>
              添加
            </Button>
            <Button variant="ghost" size="sm" type="button" onClick={() => setAdding(false)}>
              取消
            </Button>
          </div>
        </form>
      ) : (
        <div className="toc-toolbar">
          <Button variant="secondary" size="sm" className="toc-add-open" onClick={() => setAdding(true)}>
            <Plus size={13} strokeWidth={1.75} aria-hidden="true" />
            <span>新增条目</span>
          </Button>
        </div>
      )}

      <ul className="toc-list">
        {flat.map(({ entry, depth, path }) => {
          const key = path.join('.')
          const isBroken = brokenHrefs.has(entry.href)
          return (
            <li
              key={key}
              className={`toc-item${isBroken ? ' broken' : ''}`}
              style={{ paddingLeft: `${8 + depth * 14}px` }}
            >
              {editing === key ? (
                <input
                  className="toc-edit"
                  autoFocus
                  defaultValue={entry.label}
                  onBlur={(event) => rename(path, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') rename(path, event.currentTarget.value)
                    if (event.key === 'Escape') setEditing(null)
                  }}
                />
              ) : (
                <button type="button" className="toc-label" title={entry.href} onClick={() => setEditing(key)}>
                  {entry.label || '（空标题）'}
                  {isBroken ? <span className="toc-warn">锚点失效</span> : null}
                </button>
              )}
              <span className="toc-actions">
                <button
                  type="button"
                  aria-label={`上移 ${entry.label}`}
                  title="上移"
                  onClick={() => onChange(moveTocEntry(entries, path, -1))}
                >
                  <ArrowUp size={12} strokeWidth={1.75} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={`下移 ${entry.label}`}
                  title="下移"
                  onClick={() => onChange(moveTocEntry(entries, path, 1))}
                >
                  <ArrowDown size={12} strokeWidth={1.75} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={`缩进 ${entry.label}`}
                  disabled={path[path.length - 1] === 0}
                  title="成为上一条的子项"
                  onClick={() => onChange(indentTocEntry(entries, path))}
                >
                  <IndentIncrease size={12} strokeWidth={1.75} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={`取消缩进 ${entry.label}`}
                  disabled={depth === 0}
                  title="升为上一级"
                  onClick={() => onChange(outdentTocEntry(entries, path))}
                >
                  <IndentDecrease size={12} strokeWidth={1.75} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="is-danger"
                  aria-label={`删除 ${entry.label}`}
                  title="删除条目"
                  onClick={() => onChange(removeTocEntry(entries, path))}
                >
                  <Trash2 size={12} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
