import type { BrokenAnchor, TocEntry } from '@booksmith/core'
import { useMemo, useState } from 'react'

interface TocPanelProps {
  entries: TocEntry[]
  broken: BrokenAnchor[]
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

function updateAt(entries: TocEntry[], path: number[], update: (entry: TocEntry) => TocEntry): TocEntry[] {
  const [head, ...rest] = path
  if (head === undefined) return entries
  return entries.map((entry, index) => {
    if (index !== head) return entry
    if (rest.length === 0) return update(entry)
    return { ...entry, children: updateAt(entry.children, rest, update) }
  })
}

function removeAt(entries: TocEntry[], path: number[]): TocEntry[] {
  const [head, ...rest] = path
  if (head === undefined) return entries
  return entries
    .filter((_, index) => !(rest.length === 0 && index === head))
    .map((entry, index) =>
      index === head && rest.length > 0 ? { ...entry, children: removeAt(entry.children, rest) } : entry,
    )
}

function moveAt(entries: TocEntry[], path: number[], delta: number): TocEntry[] {
  const [head, ...rest] = path
  if (head === undefined) return entries
  if (rest.length > 0) {
    return entries.map((entry, index) =>
      index === head ? { ...entry, children: moveAt(entry.children, rest, delta) } : entry,
    )
  }
  const target = head + delta
  if (target < 0 || target >= entries.length) return entries
  const next = [...entries]
  const [moved] = next.splice(head, 1)
  if (!moved) return entries
  next.splice(target, 0, moved)
  return next
}

export function TocPanel({ entries, broken, onChange }: TocPanelProps) {
  const [editing, setEditing] = useState<string | null>(null)
  const brokenHrefs = useMemo(() => new Set(broken.map((entry) => entry.href)), [broken])
  const flat = useMemo(() => flatten(entries), [entries])

  function rename(path: number[], label: string) {
    const trimmed = label.trim()
    if (!trimmed) return
    onChange(updateAt(entries, path, (entry) => ({ ...entry, label: trimmed, rawHtml: '' })))
    setEditing(null)
  }

  return (
    <div className="toc-panel">
      <p className="panel-note">
        {flat.length} 项 · 改名请直接点标题，改完回车。保存时 nav 与 NCX 会同步。
        {broken.length > 0 ? ` ${broken.length} 个锚点找不到目标。` : ''}
      </p>
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
                <button
                  type="button"
                  className="toc-label"
                  title={entry.href}
                  onClick={() => setEditing(key)}
                >
                  {entry.label || '（空标题）'}
                  {isBroken ? <span className="toc-warn">锚点失效</span> : null}
                </button>
              )}
              <span className="toc-actions">
                <button
                  type="button"
                  aria-label={`上移 ${entry.label}`}
                  onClick={() => onChange(moveAt(entries, path, -1))}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`下移 ${entry.label}`}
                  onClick={() => onChange(moveAt(entries, path, 1))}
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={`删除 ${entry.label}`}
                  onClick={() => onChange(removeAt(entries, path))}
                >
                  ✕
                </button>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
