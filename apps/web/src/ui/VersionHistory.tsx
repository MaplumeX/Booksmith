import { browserXmlParser, openEpub, type EpubArchive, type EpubPackage } from '@booksmith/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, api, type VersionDto } from '../api/client'
import { changedNonProseFiles, diffLines, sourceDocument, spinePaths, type LineDiff } from '../diff/document'
import { formatBytes } from '../format'
import { isTextPath } from '../state/bookStore'
import { Button } from './Button'
import { EmptyState } from './EmptyState'

interface VersionHistoryProps {
  bookId: string
  currentVersion: number
  dirtyCount: number
  archive: EpubArchive
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

function groupByDay(versions: VersionDto[]): Array<{ key: string; label: string; items: VersionDto[] }> {
  const today = new Date()
  const groups: Array<{ key: string; label: string; items: VersionDto[] }> = []
  for (const version of versions) {
    const date = new Date(version.createdAt)
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
    const last = groups.at(-1)
    if (last?.key === key) {
      last.items.push(version)
    } else {
      groups.push({ key, label: dayLabel(date, today), items: [version] })
    }
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

export function VersionHistory({
  bookId,
  currentVersion,
  dirtyCount,
  archive,
  pkg,
  texts,
  onRestored,
  onClose,
}: VersionHistoryProps) {
  const [versions, setVersions] = useState<VersionDto[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [diffs, setDiffs] = useState<LineDiff[] | null>(null)
  const [diffState, setDiffState] = useState<DiffState>('idle')
  const [diffError, setDiffError] = useState<string | null>(null)
  const [otherFiles, setOtherFiles] = useState<string[]>([])
  const [confirming, setConfirming] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const diffBox = useRef<HTMLDivElement>(null)

  const loadList = useCallback(async () => {
    setVersions(null)
    setListError(null)
    try {
      const result = await api.versions(bookId)
      setVersions(result.versions)
    } catch (cause) {
      setListError(messageFor(cause, '读取快照'))
    }
  }, [bookId])

  useEffect(() => {
    void loadList()
  }, [loadList])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (selected === null) return
    let cancelled = false

    setDiffState('loading')
    setDiffError(null)
    setOtherFiles([])
    setDiffs(null)

    api
      .versionEpub(bookId, selected)
      .then((bytes) => {
        if (cancelled) return
        const opened = openEpub(bytes, browserXmlParser)
        const decoder = new TextDecoder('utf-8')
        const snapshotTexts = new Map<string, string>()
        for (const [path, data] of opened.archive.entries) {
          if (isTextPath(path)) snapshotTexts.set(path, decoder.decode(data))
        }

        const paths = spinePaths(pkg)
        const next = diffLines(
          sourceDocument(paths, snapshotTexts),
          sourceDocument(paths, texts),
        )
        const others = changedNonProseFiles(opened.archive, archive, new Set(paths))
        setOtherFiles(others)
        if (next.every((entry) => entry.kind === 'same')) {
          // A snapshot can differ only in the OPF or a stylesheet; calling that "no difference"
          // would hide the one change that was made.
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
  }, [selected, bookId, archive, pkg, texts])

  const restore = useCallback(async () => {
    if (selected === null) return
    setRestoring(true)
    setRestoreError(null)
    try {
      await api.restore(bookId, selected)
      onRestored()
    } catch (cause) {
      setRestoreError(messageFor(cause, '恢复'))
    } finally {
      setRestoring(false)
    }
  }, [selected, bookId, onRestored])

  useEffect(() => {
    if (diffState !== 'ready') return
    // The dump covers all 28 documents, so the first change can sit thousands of lines in.
    const first = diffBox.current?.querySelector('.diff-removed, .diff-added, .diff-changed')
    first?.scrollIntoView({ block: 'center' })
  }, [diffs, diffState])

  const groups = useMemo(() => (versions ? groupByDay(versions) : []), [versions])
  const selectedVersion = versions?.find((version) => version.versionNo === selected) ?? null
  const selectedLabel = selectedVersion
    ? `${dayLabel(new Date(selectedVersion.createdAt), new Date())} ${timeLabel(selectedVersion.createdAt)}`
    : ''

  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="快照历史"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="snapshot-dialog">
        <header className="snapshot-head">
          <h2>快照</h2>
          <span className="snapshot-sub">每次保存留一版，最近 10 版全留，更早的每天留最后一版</span>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </header>

        <div className="snapshot-body">
          <nav className="snapshot-timeline" aria-label="快照列表">
            {listError ? (
              <p className="banner banner-error" role="alert">
                {listError}
                <button type="button" className="banner-action" onClick={() => void loadList()}>
                  重试
                </button>
              </p>
            ) : !versions ? (
              <div className="snapshot-timeline-skeleton" aria-busy="true" />
            ) : versions.length === 0 ? (
              <p className="snapshot-note">这本书还没有快照。</p>
            ) : (
              groups.map((group) => (
                <section key={group.key} className="snapshot-group">
                  <h3 className="snapshot-group-label">{group.label}</h3>
                  {group.items.map((version) => {
                    const isCurrent = version.versionNo === currentVersion
                    return (
                      <button
                        key={version.versionNo}
                        type="button"
                        className={`snapshot-item${selected === version.versionNo ? ' on' : ''}`}
                        aria-pressed={selected === version.versionNo}
                        title={`v${version.versionNo}`}
                        onClick={() => {
                          setSelected(version.versionNo)
                          setConfirming(false)
                          setRestoreError(null)
                        }}
                      >
                        <span className="snapshot-time">{timeLabel(version.createdAt)}</span>
                        {isCurrent ? <span className="snapshot-badge">当前</span> : null}
                        <span className="snapshot-size">{formatBytes(version.byteSize)}</span>
                      </button>
                    )
                  })}
                </section>
              ))
            )}
          </nav>

          <section className="snapshot-pane" aria-label="快照差异">
            {diffState === 'idle' ? (
              <p className="snapshot-note">从左侧选一个快照，查看它和现在的差别。</p>
            ) : diffState === 'loading' ? (
              <div className="snapshot-diff-skeleton" aria-busy="true" />
            ) : diffState === 'error' ? (
              <p className="banner banner-error" role="alert">
                {diffError}
              </p>
            ) : diffState === 'empty' ? (
              <EmptyState
                title={otherFiles.length > 0 ? '正文没有改动' : '两版没有差异'}
                description={
                  otherFiles.length > 0
                    ? `这个快照只改了正文以外的文件：${otherFiles.join('、')}`
                    : '这个快照和现在的内容完全相同。'
                }
              />
            ) : (
              <>
                <div className="snapshot-toolbar">
                  <span className="snapshot-label">{selectedLabel}</span>
                  {selected !== currentVersion ? (
                    <Button variant="primary" onClick={() => setConfirming(true)}>
                      恢复到此快照
                    </Button>
                  ) : null}
                </div>
                <div className="snapshot-diff-wrap">
                  <div className="diff-view" ref={diffBox} role="region" aria-label="源码差异">
                    {(diffs ?? []).map((entry, index) => (
                      <DiffRow key={index} entry={entry} />
                    ))}
                  </div>
                </div>
                {otherFiles.length > 0 ? (
                  <p className="snapshot-other" title={otherFiles.join('、')}>
                    另改动：{otherFiles.join('、')}
                  </p>
                ) : null}
              </>
            )}

            {confirming ? (
              <div className="snapshot-confirm" role="alertdialog" aria-label="确认恢复">
                <div className="snapshot-confirm-copy">
                  <p>恢复到 {selectedLabel}？当前内容会被这个快照覆盖，并作为一个新快照保留。</p>
                  {dirtyCount > 0 ? (
                    <p className="snapshot-warn">编辑器里 {dirtyCount} 处未保存的改动将被丢弃。</p>
                  ) : null}
                  {restoreError ? <p className="snapshot-warn">{restoreError}</p> : null}
                </div>
                <div className="snapshot-confirm-actions">
                  <Button variant="primary" onClick={() => void restore()} disabled={restoring}>
                    {restoring ? '恢复中…' : '确认恢复'}
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirming(false)} disabled={restoring}>
                    取消
                  </Button>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  )
}

const FILE_MARKER = /^<!-- .+ -->$/

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

  const marker = entry.kind === 'same' && FILE_MARKER.test(entry.text)
  return (
    <div className={`diff-row diff-${entry.kind}${marker ? ' diff-file' : ''}`}>
      <span className="diff-sign">{entry.kind === 'removed' ? '-' : entry.kind === 'added' ? '+' : ' '}</span>
      <span className="diff-code">{entry.text.length > 0 ? entry.text : '\u00a0'}</span>
    </div>
  )
}
