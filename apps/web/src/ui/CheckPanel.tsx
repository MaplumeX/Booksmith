import type { EpubIssue } from '@booksmith/core'

interface CheckPanelProps {
  issues: EpubIssue[]
  onOpen: (path: string, line?: number) => void
}

/** Codes that are advice, not breakage. Everything else blocks or distorts reading. */
const WARNINGS = new Set(['unused-resource'])

function Group({
  label,
  items,
  onOpen,
}: {
  label: string
  items: EpubIssue[]
  onOpen: CheckPanelProps['onOpen']
}) {
  if (items.length === 0) return null
  return (
    <section className="check-group">
      <h3 className="check-group-label">
        {label}
        <span className="check-count">{items.length}</span>
      </h3>
      <ul className="check-list">
        {items.map((issue, index) => (
          <li key={`${issue.code}:${issue.path ?? ''}:${index}`}>
            <button
              type="button"
              className="check-item"
              disabled={!issue.path}
              onClick={() => issue.path && onOpen(issue.path, issue.line)}
            >
              <span className="check-message">{issue.message}</span>
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
    return <p className="sidebar-note">没有发现问题。</p>
  }

  const errors = issues.filter((issue) => !WARNINGS.has(issue.code))
  const warnings = issues.filter((issue) => WARNINGS.has(issue.code))

  return (
    <div className="check-panel">
      <p className="panel-note">编辑时会重新检查。点一条跳到对应的文件和行。</p>
      <Group label="错误" items={errors} onOpen={onOpen} />
      <Group label="提醒" items={warnings} onOpen={onOpen} />
    </div>
  )
}
