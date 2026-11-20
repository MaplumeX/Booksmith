import type { AgentProposal, AgentProposalFile } from '@booksmith/core'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileDiff,
  RotateCcw,
  XCircle,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { diffLines, type LineDiff } from '../diff/document'
import { basename } from '../state/bookStore'
import { Button } from './Button'

interface AgentProposalCardProps {
  proposal: AgentProposal
  status: 'pending' | 'applied' | 'dismissed'
  canUndo: boolean
  busy?: boolean
  onApply: (selectedPaths?: Set<string>) => void
  onDismiss: () => void
  onUndo: () => void
}

const CONTEXT_RADIUS = 2
const MAX_COMPACT_ROWS = 80

const KIND_LABELS: Record<AgentProposalFile['kind'], string> = {
  create: '新增',
  update: '修改',
  rename: '重命名',
  delete: '删除',
}

interface RenderRow {
  kind: 'line' | 'gap'
  line?: LineDiff
  skipped?: number
}

function compactDiff(lines: LineDiff[], showAll: boolean): { rows: RenderRow[]; truncated: boolean } {
  if (showAll) {
    return { rows: lines.map((line) => ({ kind: 'line', line })), truncated: false }
  }

  const changedIndices: number[] = []
  lines.forEach((line, index) => {
    if (line.kind !== 'same') changedIndices.push(index)
  })

  if (changedIndices.length === 0) {
    return { rows: [], truncated: false }
  }

  const keep = new Set<number>()
  for (const idx of changedIndices) {
    for (let cursor = Math.max(0, idx - CONTEXT_RADIUS); cursor <= Math.min(lines.length - 1, idx + CONTEXT_RADIUS); cursor += 1) {
      keep.add(cursor)
    }
  }

  const rows: RenderRow[] = []
  let skipped = 0
  let truncated = false
  for (let index = 0; index < lines.length; index += 1) {
    if (keep.has(index)) {
      if (skipped > 0) {
        rows.push({ kind: 'gap', skipped })
        skipped = 0
      }
      if (rows.length >= MAX_COMPACT_ROWS) {
        truncated = true
        break
      }
      rows.push({ kind: 'line', line: lines[index] })
    } else {
      skipped += 1
    }
  }
  if (!truncated && skipped > 0) rows.push({ kind: 'gap', skipped })
  return { rows, truncated }
}

function FileDiffPreview({ file }: { file: AgentProposalFile }) {
  const [showAll, setShowAll] = useState(false)

  const computed = useMemo(() => {
    const before = file.beforeText ?? ''
    const after = file.afterText ?? ''
    const lines = diffLines(before, after)
    return compactDiff(lines, showAll)
  }, [file.beforeText, file.afterText, showAll])

  if (file.kind === 'rename' && file.beforeText === file.afterText) {
    return (
      <p className="agent-proposal-note">
        仅重命名路径：{file.previousPath} → {file.path}（内容未变）。
      </p>
    )
  }

  return (
    <div className="agent-proposal-diff">
      {computed.rows.length === 0 ? (
        <p className="agent-proposal-note">文本内容无差异。</p>
      ) : (
        <div className="agent-diff-lines">
          {computed.rows.map((row, index) => {
            if (row.kind === 'gap') {
              return (
                <div className="agent-diff-gap" key={`gap-${index}`}>
                  … 省略 {row.skipped} 行未修改内容 …
                </div>
              )
            }
            const entry = row.line!
            if (entry.kind === 'changed') {
              return (
                <div className="diff-row diff-changed" key={index}>
                  <span className="diff-sign">~</span>
                  <span className="diff-code">
                    {entry.segments.map((seg, sIdx) => (
                      <span
                        key={sIdx}
                        className={
                          seg.kind === 'removed'
                            ? 'diff-inline-removed'
                            : seg.kind === 'added'
                              ? 'diff-inline-added'
                              : undefined
                        }
                      >
                        {seg.text}
                      </span>
                    ))}
                  </span>
                </div>
              )
            }
            const sign = entry.kind === 'added' ? '+' : entry.kind === 'removed' ? '-' : ' '
            const cls =
              entry.kind === 'added' ? 'diff-added' : entry.kind === 'removed' ? 'diff-removed' : 'diff-same'
            return (
              <div className={`diff-row ${cls}`} key={index}>
                <span className="diff-sign">{sign}</span>
                <span className="diff-code">{entry.text || ' '}</span>
              </div>
            )
          })}
        </div>
      )}
      {computed.truncated && !showAll ? (
        <button type="button" className="agent-link-btn" onClick={() => setShowAll(true)}>
          展开全部变更行
        </button>
      ) : null}
    </div>
  )
}

export function AgentProposalCard({
  proposal,
  status,
  canUndo,
  busy = false,
  onApply,
  onDismiss,
  onUndo,
}: AgentProposalCardProps) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(proposal.files.map((f) => f.path)))
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    proposal.files.length === 1 ? new Set([proposal.files[0]!.path]) : new Set(),
  )

  const hasIssues = proposal.validationIssues.length > 0
  const selectedCount = proposal.isStructural ? proposal.files.length : selected.size

  const toggleExpanded = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const toggleSelected = (path: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

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
      <div className="agent-proposal-card is-applied">
        <div className="agent-proposal-compact">
          <CheckCircle2 size={14} strokeWidth={1.75} className="agent-icon-ok" aria-hidden="true" />
          <span>已应用变更到工作区（{proposal.files.length} 个文件）</span>
          {canUndo ? (
            <Button variant="secondary" size="sm" type="button" onClick={onUndo}>
              <RotateCcw size={12} strokeWidth={1.75} aria-hidden="true" />
              <span>撤销本次应用</span>
            </Button>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <section className="agent-proposal-card" aria-label="变更提案">
      <header className="agent-proposal-head">
        <div className="agent-proposal-title">
          <FileDiff size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>变更提案 · {proposal.files.length} 个文件</span>
        </div>
        <span className={`agent-proposal-mode${proposal.isStructural ? ' is-structural' : ''}`}>
          {proposal.isStructural ? '结构变更 · 整批应用' : '纯文本 · 可勾选'}
        </span>
      </header>

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

      <ul className="agent-proposal-files">
        {proposal.files.map((file) => {
          const isOpen = expanded.has(file.path)
          const isChecked = proposal.isStructural || selected.has(file.path)
          const label =
            file.kind === 'rename' && file.previousPath
              ? `${basename(file.previousPath)} → ${basename(file.path)}`
              : basename(file.path)
          return (
            <li key={`${file.kind}:${file.path}`} className="agent-proposal-file">
              <div className="agent-proposal-file-row">
                {!proposal.isStructural ? (
                  <input
                    type="checkbox"
                    aria-label={`选择 ${file.path}`}
                    checked={isChecked}
                    onChange={() => toggleSelected(file.path)}
                  />
                ) : null}
                <button
                  type="button"
                  className="agent-proposal-file-toggle"
                  aria-expanded={isOpen}
                  onClick={() => toggleExpanded(file.path)}
                >
                  {isOpen ? (
                    <ChevronDown size={13} strokeWidth={1.75} aria-hidden="true" />
                  ) : (
                    <ChevronRight size={13} strokeWidth={1.75} aria-hidden="true" />
                  )}
                  <span className={`agent-kind-tag is-${file.kind}`}>{KIND_LABELS[file.kind]}</span>
                  <span className="agent-proposal-path" title={file.path}>
                    {label}
                  </span>
                </button>
              </div>

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

              {isOpen ? <FileDiffPreview file={file} /> : null}
            </li>
          )
        })}
      </ul>

      <footer className="agent-proposal-actions">
        <Button variant="ghost" size="sm" type="button" disabled={busy} onClick={onDismiss}>
          放弃
        </Button>
        <Button
          variant="primary"
          size="sm"
          type="button"
          disabled={busy || hasIssues || selectedCount === 0}
          onClick={() => onApply(proposal.isStructural ? undefined : selected)}
        >
          {proposal.isStructural
            ? '应用全部变更'
            : selectedCount === proposal.files.length
              ? '应用变更'
              : `应用已选（${selectedCount}/${proposal.files.length}）`}
        </Button>
      </footer>
    </section>
  )
}
