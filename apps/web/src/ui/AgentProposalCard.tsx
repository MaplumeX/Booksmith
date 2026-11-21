import type { AgentProposal, AgentProposalFile } from '@booksmith/core'
import {
  AlertCircle,
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Eye,
  FileDiff,
  RotateCcw,
  XCircle,
} from 'lucide-react'
import { useMemo } from 'react'
import { basename } from '../state/bookStore'
import { buildComposedProposalPlan, buildFileHunks, type FileDiffModel } from '../state/proposalReview'
import { Button } from './Button'

/**
 * Slimmed sidebar summary & navigation card for an Agent proposal.
 * Full book-page revision, final preview, and source diffs live in the main canvas `ProposalReviewPane`
 * rather than squeezing code diffs into the narrow sidebar.
 * See ADR 2026-11-21-in-canvas-agent-proposal-review.
 */

interface AgentProposalCardProps {
  proposal: AgentProposal
  status: 'pending' | 'applied' | 'dismissed'
  canUndo: boolean
  busy?: boolean
  autoApplied?: boolean
  autoDowngradeReason?: string | null
  isReviewing?: boolean
  activeReviewPath?: string | null
  skippedByPath?: Readonly<Record<string, ReadonlySet<string>>>
  xmlBlocked?: boolean
  onOpenReview?: (path?: string) => void
  onApply: (selectedPaths?: Set<string>) => void
  onDismiss: () => void
  onUndo: () => void
}

const KIND_LABELS: Record<AgentProposalFile['kind'], string> = {
  create: '新增',
  update: '修改',
  rename: '重命名',
  delete: '删除',
}

export function AgentProposalCard({
  proposal,
  status,
  canUndo,
  busy = false,
  autoApplied = false,
  autoDowngradeReason = null,
  isReviewing = false,
  activeReviewPath = null,
  skippedByPath = {},
  xmlBlocked = false,
  onOpenReview,
  onApply,
  onDismiss,
  onUndo,
}: AgentProposalCardProps) {
  const modelsByPath = useMemo(() => {
    const map = new Map<string, FileDiffModel>()
    for (const file of proposal.files) {
      map.set(file.path, buildFileHunks(file))
    }
    return map
  }, [proposal.files])

  const totalStats = useMemo(() => {
    let added = 0
    let removed = 0
    for (const model of modelsByPath.values()) {
      added += model.added
      removed += model.removed
    }
    return { added, removed }
  }, [modelsByPath])

  const plan = useMemo(
    () => buildComposedProposalPlan(proposal, modelsByPath, skippedByPath),
    [proposal, modelsByPath, skippedByPath],
  )

  const hasIssues = proposal.validationIssues.length > 0

  if (status === 'dismissed') {
    return (
      <div className="agent-proposal-card is-dismissed">
        <div className="agent-proposal-compact">
          <XCircle size={14} strokeWidth={1.7} aria-hidden="true" />
          <span>已放弃变更提案（{proposal.files.length} 个文件）</span>
        </div>
      </div>
    )
  }

  if (status === 'applied') {
    return (
      <div className={`agent-proposal-card is-applied${isReviewing ? ' is-reviewing' : ''}`}>
        <div className="agent-proposal-compact">
          <CheckCircle2 size={14} strokeWidth={1.75} className="agent-icon-ok" aria-hidden="true" />
          <span className="agent-proposal-compact-label">
            {autoApplied
              ? `已自动应用到工作区（${proposal.files.length} 个文件）`
              : `已应用变更到工作区（${proposal.files.length} 个文件）`}
          </span>
          <div className="agent-proposal-compact-actions">
            {onOpenReview ? (
              <Button variant="ghost" size="sm" type="button" onClick={() => onOpenReview()}>
                <Eye size={12} strokeWidth={1.8} aria-hidden="true" />
                <span>{isReviewing ? '回看中' : '查看改动'}</span>
              </Button>
            ) : null}
            {canUndo ? (
              <Button variant="secondary" size="sm" type="button" onClick={onUndo}>
                <RotateCcw size={12} strokeWidth={1.75} aria-hidden="true" />
                <span>撤销本次应用</span>
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    )
  }

  const applyDisabled =
    busy ||
    hasIssues ||
    xmlBlocked ||
    (!proposal.isStructural && plan.selectedPaths.size === 0)

  const applyText = proposal.isStructural
    ? '应用全部变更'
    : plan.totalHunks > 0 && plan.keptHunks < plan.totalHunks
      ? `应用已选（${plan.keptHunks}/${plan.totalHunks} 处）`
      : '应用变更'

  return (
    <section
      className={`agent-proposal-card${isReviewing ? ' is-reviewing' : ''}`}
      aria-label="变更提案"
    >
      <header className="agent-proposal-head">
        <div className="agent-proposal-title">
          <FileDiff size={13} strokeWidth={1.75} aria-hidden="true" />
          <span>变更提案 · {proposal.files.length} 个文件</span>
          {totalStats.added > 0 || totalStats.removed > 0 ? (
            <span
              className="agent-diff-stats"
              aria-label={`新增 ${totalStats.added} 行，删除 ${totalStats.removed} 行`}
            >
              {totalStats.added > 0 ? <span className="is-add">+{totalStats.added}</span> : null}
              {totalStats.removed > 0 ? <span className="is-del">-{totalStats.removed}</span> : null}
            </span>
          ) : null}
        </div>
        {isReviewing ? (
          <span className="agent-proposal-reviewing-pill">审阅中</span>
        ) : (
          <span className={`agent-proposal-mode${proposal.isStructural ? ' is-structural' : ''}`}>
            {proposal.isStructural ? '结构变更 · 整批应用' : '逐处可审阅'}
          </span>
        )}
      </header>

      {autoDowngradeReason ? (
        <div className="banner banner-warn agent-proposal-downgrade" role="status">
          <AlertTriangle size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>{autoDowngradeReason}</span>
        </div>
      ) : null}

      {hasIssues ? (
        <div className="banner banner-error agent-proposal-issues" role="alert">
          <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />
          <div>
            <strong>结构预检未通过，已阻断应用</strong>
            <ul>
              {proposal.validationIssues.map((issue, idx) => (
                <li key={`${issue.code}-${idx}`}>{issue.message}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {xmlBlocked ? (
        <div className="banner banner-error agent-proposal-issues" role="alert">
          <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>部分跳过改动导致 XML 未闭合，请在主区恢复或切源码核对。</span>
        </div>
      ) : null}

      <ul className="agent-proposal-files">
        {proposal.files.map((file) => {
          const model = modelsByPath.get(file.path)
          const state = plan.fileStates.get(file.path)
          const isCurrentFile = isReviewing && activeReviewPath === file.path
          const label =
            file.kind === 'rename' && file.previousPath
              ? `${basename(file.previousPath)} → ${basename(file.path)}`
              : basename(file.path)
          return (
            <li
              key={`${file.kind}:${file.path}`}
              className={`agent-proposal-file${isCurrentFile ? ' is-active' : ''}`}
            >
              <button
                type="button"
                className="agent-proposal-file-nav"
                aria-current={isCurrentFile ? 'true' : undefined}
                title={`在主区审阅 ${file.path}`}
                onClick={() => onOpenReview?.(file.path)}
              >
                <span className={`agent-kind-tag is-${file.kind}`}>{KIND_LABELS[file.kind]}</span>
                <span className="agent-proposal-path">{label}</span>
                {!proposal.isStructural && state && state.total > 0 && state.kept < state.total ? (
                  <span className="agent-proposal-kept-badge" title={`保留 ${state.kept}/${state.total} 处变更`}>
                    {state.kept}/{state.total}
                  </span>
                ) : null}
                {model && (model.added > 0 || model.removed > 0) ? (
                  <span className="agent-diff-stats">
                    {model.added > 0 ? <span className="is-add">+{model.added}</span> : null}
                    {model.removed > 0 ? <span className="is-del">-{model.removed}</span> : null}
                  </span>
                ) : null}
                <ChevronRight size={12} strokeWidth={1.75} className="agent-proposal-chevron" aria-hidden="true" />
              </button>

              {file.referencesAffected && file.referencesAffected.length > 0 ? (
                <p className="agent-proposal-ref-warn">
                  <AlertTriangle size={12} strokeWidth={1.75} aria-hidden="true" />
                  <span>
                    有 {file.referencesAffected.length} 处外部引用将失效：
                    {file.referencesAffected
                      .slice(0, 3)
                      .map((r) => `${basename(r.from)}:${r.line}`)
                      .join('、')}
                  </span>
                </p>
              ) : null}
            </li>
          )
        })}
      </ul>

      <footer className="agent-proposal-actions">
        {onOpenReview ? (
          <Button
            variant="secondary"
            size="sm"
            type="button"
            className="agent-proposal-review-btn"
            onClick={() => onOpenReview()}
          >
            <BookOpen size={12} strokeWidth={1.8} aria-hidden="true" />
            <span>{isReviewing ? '定位审阅' : '审阅变更'}</span>
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" type="button" disabled={busy} onClick={onDismiss}>
          放弃
        </Button>
        <Button
          variant="primary"
          size="sm"
          type="button"
          disabled={applyDisabled}
          onClick={() => onApply()}
        >
          {applyText}
        </Button>
      </footer>
    </section>
  )
}
