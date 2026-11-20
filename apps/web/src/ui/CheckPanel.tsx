import type { EpubIssue } from '@booksmith/core'
import { AlertCircle, AlertTriangle, CheckCircle2 } from 'lucide-react'

interface CheckPanelProps {
  issues: EpubIssue[]
  onOpen: (path: string, line?: number) => void
}

/** Codes that are advice, not breakage. Everything else blocks or distorts reading. */
const WARNINGS = new Set(['unused-resource'])

function Group({
  label,
  tone,
  items,
  onOpen,
}: {
  label: string
  tone: 'error' | 'warn'
  items: EpubIssue[]
  onOpen: CheckPanelProps['onOpen']
}) {
  if (items.length === 0) return null
  const Icon = tone === 'error' ? AlertCircle : AlertTriangle
  return (
    <section className="check-group">
      <h3 className="check-group-label">
        <span>{label}</span>
        <span className="check-count">{items.length}</span>
      </h3>
      <ul className="check-list">
        {items.map((issue, index) => (
          <li key={`${issue.code}:${issue.path ?? ''}:${index}`}>
            <button
              type="button"
              className={`check-item is-${tone}`}
              disabled={!issue.path}
              onClick={() => issue.path && onOpen(issue.path, issue.line)}
            >
              <span className="check-head">
                <Icon size={13} strokeWidth={1.75} className="check-icon" aria-hidden="true" />
                <span className="check-message">{issue.message}</span>
              </span>
              {issue.path ? (
                <span className="check-path">
                  {issue.path}
                  {issue.line ? `:${issue.line}` : ''}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function CheckPanel({ issues, onOpen }: CheckPanelProps) {
  if (issues.length === 0) {
    return (
      <div className="check-empty">
        <CheckCircle2 size={20} strokeWidth={1.6} aria-hidden="true" />
        <p>没有发现问题。</p>
      </div>
    )
  }

  const errors = issues.filter((issue) => !WARNINGS.has(issue.code))
  const warnings = issues.filter((issue) => WARNINGS.has(issue.code))

  return (
    <div className="check-panel">
      <p className="panel-note">编辑时会重新检查。点一条跳到对应的文件和行。</p>
      <Group label="错误" tone="error" items={errors} onOpen={onOpen} />
      <Group label="提醒" tone="warn" items={warnings} onOpen={onOpen} />
    </div>
  )
}
