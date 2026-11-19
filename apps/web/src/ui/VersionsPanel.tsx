import { useCallback, useEffect, useState } from 'react'
import { ApiError, api, type VersionDto } from '../api/client'
import { formatBytes, formatRelative } from '../format'
import { Button } from '../ui/Button'

interface VersionsPanelProps {
  bookId: string
  currentVersion: number
  onRestored: () => void
}

export function VersionsPanel({ bookId, currentVersion, onRestored }: VersionsPanelProps) {
  const [versions, setVersions] = useState<VersionDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)
  const [pending, setPending] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      const result = await api.versions(bookId)
      setVersions(result.versions)
      setError(null)
    } catch (cause) {
      setError(cause instanceof ApiError ? `读取版本失败（${cause.code}）` : '读取版本失败')
    }
  }, [bookId])

  useEffect(() => {
    void load()
  }, [load, currentVersion])

  async function restore(versionNo: number) {
    setPending(versionNo)
    try {
      await api.restore(bookId, versionNo)
      setConfirming(null)
      onRestored()
      await load()
    } catch (cause) {
      setError(cause instanceof ApiError ? `恢复失败（${cause.code}）` : '恢复失败')
    } finally {
      setPending(null)
    }
  }

  if (error) {
    return (
      <p className="banner banner-error" role="alert">
        {error}
        <button type="button" className="banner-action" onClick={() => void load()}>
          重试
        </button>
      </p>
    )
  }

  if (!versions) {
    return <p className="sidebar-note">正在读取版本…</p>
  }

  return (
    <ul className="version-list">
      {versions.map((version) => {
        const isCurrent = version.versionNo === currentVersion
        return (
          <li key={version.versionNo} className={`version-item${isCurrent ? ' on' : ''}`}>
            <div className="version-main">
              <span className="version-no">v{version.versionNo}</span>
              {isCurrent ? <span className="version-badge">当前</span> : null}
              <span className="version-meta">
                {formatBytes(version.byteSize)} · {formatRelative(version.createdAt)}
              </span>
            </div>
            {confirming === version.versionNo ? (
              <div className="version-actions">
                <Button
                  variant="primary"
                  disabled={pending === version.versionNo}
                  onClick={() => void restore(version.versionNo)}
                >
                  {pending === version.versionNo ? '恢复中…' : '确认恢复'}
                </Button>
                <Button variant="ghost" onClick={() => setConfirming(null)}>
                  取消
                </Button>
              </div>
            ) : (
              !isCurrent && (
                <Button variant="secondary" onClick={() => setConfirming(version.versionNo)}>
                  恢复此版本
                </Button>
              )
            )}
          </li>
        )
      })}
    </ul>
  )
}
