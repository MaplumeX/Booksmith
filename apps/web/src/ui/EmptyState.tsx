import type { ReactNode } from 'react'

interface EmptyStateProps {
  title: string
  description: string
  action?: ReactNode
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-art-wrap" aria-hidden="true">
        <svg viewBox="0 0 64 48" className="empty-art">
          <rect x="6" y="6" width="34" height="36" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M14 6v36" stroke="currentColor" strokeWidth="1.5" />
          <rect
            x="24"
            y="14"
            width="34"
            height="28"
            rx="2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            opacity="0.55"
          />
        </svg>
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  )
}
