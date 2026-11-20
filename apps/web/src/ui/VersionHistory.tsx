import type { EpubPackage } from '@booksmith/core'
import { Pin, PinOff, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, api, type PageSnapshotDto } from '../api/client'
import { diffLines, spinePaths, type LineDiff } from '../diff/document'
import { formatBytes } from '../format'
import { basename } from '../state/bookStore'
import { Button } from './Button'
import { Dialog } from './Dialog'
import { EmptyState } from './EmptyState'

interface VersionHistoryProps {
  bookId: string
  /** The entry whose history is open; snapshots are per file, so the surface is one file's timeline. */
  path: string
  dirtyCount: number
  pkg: EpubPackage
  texts: Map<string, string>
  onRestored: () => void
  onClose: () => void
}

type DiffState = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function dayLabel(date: Date, today: Date): string {
  if (sameDay(date, today)) return '今天'
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (sameDay(date, yesterday)) return '昨天'
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function groupByDay(snapshots: PageSnapshotDto[]): Array<{ key: string; label: string; items: PageSnapshotDto[] }> {
  const today = new Date()
  const groups: Array<{ key: string; label: string; items: PageSnapshotDto[] }> = []
  for (const snapshot of snapshots) {
    const date = new Date(snapshot.createdAt)
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
    const last = groups.at(-1)
    if (last?.key === key) last.items.push(snapshot)
    else groups.push({ key, label: dayLabel(date, today), items: [snapshot] })
  }
  return groups
}

function messageFor(error: unknown, action: string): string {
  if (error instanceof ApiError) {
    if (error.code === 'unauthenticated') return '登录已过期，请重新登录'
    return `${action}失败（${error.code}）`
  }
  return `${action}失败`
}

export function VersionHistory({ bookId, path, dirtyCount, pkg, texts, onRestored, onClose }: VersionHistoryProps) {
  const [snapshots, setSnapshots] = useState<PageSnapshotDto[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [selected, setSelected] = useState<PageSnapshotDto | null>(null)
  const [diffs, setDiffs] = useState<LineDiff[] | null>(null)
  const [diffState, setDiffState] = useState<DiffState>('idle')
  const [diffError, setDiffError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const diffBox = useRef<HTMLDivElement>(null)

  const loadList = useCallback(async () => {
    setSnapshots(null)
    setListError(null)
    try {
      const { snapshots: all } = await api.pageVersions(bookId)
      const mine = all
        .filter((entry) => entry.path === path)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      setSnapshots(mine)
      // The newest snapshot is what the editor already holds unless it is dirty, so opening on it
      // would greet the user with "identical". Start at the previous version instead.
      setSelected((dirtyCount > 0 ? mine[0] : (mine[1] ?? mine[0])) ?? null)
    } catch (cause) {
      setListError(messageFor(cause, '读取快照'))
    }
  }, [bookId, path, dirtyCount])

  useEffect(() => {
    void loadList()
  }, [loadList])

  useEffect(() => {
    if (!selected) return
    let cancelled = false

    setDiffState('loading')
    setDiffError(null)
    setDiffs(null)
    setConfirming(false)

    api
      .pageVersionText(bookId, selected.id)
      .then((text) => {
        if (cancelled) return
        const current = texts.get(path) ?? ''
        const next = diffLines(text, current)
        if (next.every((entry) => entry.kind === 'same')) {
          setDiffState('empty')
          return
        }
        setDiffs(next)
        setDiffState('ready')
      })
      .catch((cause) => {
        if (cancelled) return
        setDiffState('error')
        setDiffError(messageFor(cause, '读取快照'))
      })

    return () => {
      cancelled = true
    }
  }, [selected, bookId, path, texts])

  useEffect(() => {
    if (diffState !== 'ready') return
    // A 174KB chapter puts the first change far below the fold.
    const first = diffBox.current?.querySelector('.diff-removed, .diff-added, .diff-changed')
    first?.scrollIntoView({ block: 'center' })
  }, [diffs, diffState])

  const togglePin = useCallback(
    async (snapshot: PageSnapshotDto) => {
      const next = !snapshot.pinned
      const apply = (value: boolean) =>
        setSnapshots((list) => list?.map((entry) => (entry.id === snapshot.id ? { ...entry, pinned: value } : entry)) ?? list)

      apply(next)
      try {
        await api.setPinned(bookId, snapshot.id, next)
      } catch (cause) {
        apply(!next)
        setListError(messageFor(cause, '置顶'))
      }
    },
    [bookId],
  )

  const restore = useCallback(async () => {
    if (!selected) return
    setRestoring(true)
    setRestoreError(null)
    try {
      await api.restorePage(bookId, selected.id)
      onRestored()
    } catch (cause) {
      setRestoreError(messageFor(cause, '恢复'))
    } finally {
      setRestoring(false)
    }
  }, [selected, bookId, onRestored])

  const groups = useMemo(() => (snapshots ? groupByDay(snapshots) : []), [snapshots])
  const spineIndex = spinePaths(pkg).indexOf(path)
  const subtitle =
    spineIndex >= 0 ? `${path} · 正文第 ${spineIndex + 1} 篇` : path

  const selectedLabel = selected ? `${dayLabel(new Date(selected.createdAt), new Date())} ${timeLabel(selected.createdAt)}` : ''

  return (
    <Dialog
      open
      onOpenChange={(openState) => {
        if (!openState) onClose()
      }}
      size="wide"
      className="snapshot-dialog"
      headClassName="snapshot-head"
      ariaLabel={`${basename(path)} 的版本历史`}
      title={basename(path)}
      headerExtra={
        <span className="snapshot-path-label" title={path}>
          {subtitle}
        </span>
      }
    >
      <div className="snapshot-body">
        <nav className="snapshot-timeline" aria-label="版本列表">
          <p className="snapshot-pin-note">置顶的快照不占 100 条上限，也不会被按天清理。</p>
          {listError ? (
            <p className="banner banner-error" role="alert">
              {listError}
              <button type="button" className="banner-action" onClick={() => void loadList()}>
                重试
              </button>
            </p>
          ) : !snapshots ? (
            <div className="snapshot-timeline-skeleton" aria-busy="true" />
          ) : snapshots.length === 0 ? (
            <p className="snapshot-note">这个文件还没有快照。</p>
          ) : (
            groups.map((group) => (
              <section key={group.key} className="snapshot-group">
                <h3 className="snapshot-group-label">{group.label}</h3>
                {group.items.map((item, index) => (
                  <div key={item.id} className={`snapshot-row${selected?.id === item.id ? ' on' : ''}`}>
                    <button
                      type="button"
                      className="snapshot-item"
                      aria-pressed={selected?.id === item.id}
                      title={`${timeLabel(item.createdAt)} · ${formatBytes(item.byteSize)}`}
                      onClick={() => setSelected(item)}
                    >
                      <span className="snapshot-time">{timeLabel(item.createdAt)}</span>
                      {index === 0 && group.key === groups[0]?.key ? (
                        <span className="snapshot-badge">最新</span>
                      ) : null}
                      <span className="snapshot-size">{formatBytes(item.byteSize)}</span>
                    </button>
                    <button
                      type="button"
                      className={`snapshot-pin${item.pinned ? ' on' : ''}`}
                      aria-pressed={item.pinned}
                      aria-label={`${item.pinned ? '取消置顶' : '置顶'} ${timeLabel(item.createdAt)}`}
                      title={item.pinned ? '已置顶：自动清理不会删除它' : '置顶这条，自动清理时保留'}
                      onClick={() => void togglePin(item)}
                    >
                      {item.pinned ? (
                        <Pin size={13} strokeWidth={2} aria-hidden="true" />
                      ) : (
                        <PinOff size={13} strokeWidth={1.6} aria-hidden="true" />
                      )}
                    </button>
                  </div>
                ))}
              </section>
            ))
          )}
        </nav>

        <section className="snapshot-pane" aria-label="版本差异">
          {diffState === 'idle' ? (
            <p className="snapshot-note">从左侧选一个版本，查看它和现在的差别。</p>
          ) : diffState === 'loading' ? (
            <div className="snapshot-diff-skeleton" aria-busy="true" />
          ) : diffState === 'error' ? (
            <p className="banner banner-error" role="alert">
              {diffError}
            </p>
          ) : diffState === 'empty' ? (
            <EmptyState title="这一版和现在相同" description="这个快照的内容与编辑器里现在的文件完全一致。" />
          ) : (
            <>
              <div className="snapshot-toolbar">
                <span className="snapshot-label">{selectedLabel}</span>
                <Button variant="primary" size="sm" onClick={() => setConfirming(true)}>
                  <RotateCcw size={13} strokeWidth={1.75} aria-hidden="true" />
                  <span>恢复这一版</span>
                </Button>
              </div>
              <div className="snapshot-diff-wrap">
                <div className="diff-view" ref={diffBox} role="region" aria-label="源码差异">
                  {(diffs ?? []).map((entry, index) => (
                    <DiffRow key={index} entry={entry} />
                  ))}
                </div>
              </div>
            </>
          )}

          {confirming ? (
            <div className="snapshot-confirm" role="alertdialog" aria-label="确认恢复">
              <div className="snapshot-confirm-copy">
                <p>
                  把 {basename(path)} 恢复到 {selectedLabel}？当前内容会被这个快照覆盖，并作为一条新快照保留。
                </p>
                {dirtyCount > 0 ? (
                  <p className="snapshot-warn">编辑器里 {dirtyCount} 处未保存的改动将被丢弃。</p>
                ) : null}
                {restoreError ? <p className="snapshot-warn">{restoreError}</p> : null}
              </div>
              <div className="snapshot-confirm-actions">
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={restoring}>
                  取消
                </Button>
                <Button variant="primary" size="sm" onClick={() => void restore()} disabled={restoring}>
                  {restoring ? '恢复中…' : '确认恢复'}
                </Button>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </Dialog>
  )
}

function DiffRow({ entry }: { entry: LineDiff }) {
  if (entry.kind === 'changed') {
    return (
      <div className="diff-row diff-changed">
        <span className="diff-sign">~</span>
        <span className="diff-code">
          {entry.segments.map((segment, index) =>
            segment.kind === 'same' ? (
              <span key={index}>{segment.text}</span>
            ) : segment.kind === 'removed' ? (
              <del key={index} className="diff-inline-removed">
                {segment.text}
              </del>
            ) : (
              <ins key={index} className="diff-inline-added">
                {segment.text}
              </ins>
            ),
          )}
        </span>
      </div>
    )
  }

  return (
    <div className={`diff-row diff-${entry.kind}`}>
      <span className="diff-sign">{entry.kind === 'removed' ? '-' : entry.kind === 'added' ? '+' : ' '}</span>
      <span className="diff-code">{entry.text.length > 0 ? entry.text : '\u00a0'}</span>
    </div>
  )
}
