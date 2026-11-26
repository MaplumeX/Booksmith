import type { BatchDeleteInspection } from '@booksmith/core'
import { AlertTriangle, Trash2 } from 'lucide-react'
import { basename } from '../state/bookStore'
import { Button } from './Button'
import { Dialog } from './Dialog'

interface BatchDeleteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  inspection: BatchDeleteInspection | null
  onConfirm: () => void
  onRevealReference: (from: string, line: number) => void
}

/**
 * Unified single- and multi-file delete confirmation dialog (`width: min(480px, calc(100vw - 32px))`).
 * Groups remaining external references (excluding mutual links within the deleted batch) and
 * surfaces explicit risk notices for TOC files, cover images, or emptying all spine chapters.
 * See ADR 2026-11-26-filetree-batch-operations.
 */
export function BatchDeleteDialog({
  open,
  onOpenChange,
  inspection,
  onConfirm,
  onRevealReference,
}: BatchDeleteDialogProps) {
  const count = inspection?.paths.length ?? 0
  const isSingle = count === 1
  const singlePath = isSingle ? inspection!.paths[0]! : null

  const riskMessages: string[] = []
  if (inspection?.emptiesAllChapters) {
    riskMessages.push('选中了全部正文章节，删除后这本书将没有可阅读正文。')
  }
  if (inspection?.includesNav || inspection?.includesNcx) {
    const names = [inspection.includesNav ? 'nav.xhtml' : null, inspection.includesNcx ? 'toc.ncx' : null]
      .filter(Boolean)
      .join('、')
    riskMessages.push(`包含书籍目录文件（${names}），删除后目录导航将失效。`)
  }
  if (inspection && inspection.coverPaths.length > 0) {
    const names = inspection.coverPaths.map((path) => basename(path)).join('、')
    riskMessages.push(`包含书籍封面图（${names}），删除后封面展示将失效。`)
  }

  const title = !inspection
    ? ''
    : isSingle && singlePath
      ? `删除 ${basename(singlePath)}`
      : `批量删除 ${count} 个文件`

  const description = !inspection
    ? undefined
    : inspection.totalReferences === 0
      ? isSingle
        ? '没有别的地方引用它。删除后这个文件从书里消失，目录里指向它的条目也会一并移除，可通过底部提示撤销。'
        : `没有其他留存文件引用这 ${count} 个文件。删除后将同步移除 OPF 清单、阅读顺序与对应目录条目，可通过底部提示撤销。`
      : isSingle
        ? `还有 ${inspection.totalReferences} 处引用它。删除后这些引用会断开，需要你自己去改：`
        : `其他留存文件中还有 ${inspection.totalReferences} 处引用指向待删文件（已自动排除同批内部互引）。删除后这些引用会断开：`

  return (
    <Dialog
      open={open && Boolean(inspection)}
      onOpenChange={onOpenChange}
      ariaLabel="删除文件"
      title={title}
      description={description}
      className="batch-delete-dialog"
      footer={
        <>
          <Button variant="ghost" type="button" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="danger"
            type="button"
            disabled={!inspection || count === 0}
            onClick={onConfirm}
          >
            <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
            <span>{isSingle ? '删除' : `删除 ${count} 个文件`}</span>
          </Button>
        </>
      }
    >
      {inspection ? (
        <div className="batch-delete-body">
          {riskMessages.length > 0 ? (
            <div className="batch-delete-risks" role="alert">
              {riskMessages.map((msg) => (
                <p key={msg} className="batch-delete-risk">
                  <AlertTriangle size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{msg}</span>
                </p>
              ))}
            </div>
          ) : null}

          {!isSingle ? (
            <div className="batch-delete-targets">
              <p className="batch-delete-section-label">待删除文件（{count}）</p>
              <ul className="batch-delete-chips" role="list">
                {inspection.paths.map((path) => (
                  <li key={path} className="batch-delete-chip" title={path}>
                    {basename(path)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {inspection.totalReferences > 0 ? (
            isSingle ? (
              <ul className="reference-list">
                {inspection.referenceGroups[0]!.references.map((reference, index) => (
                  <li key={`${reference.from}:${reference.line}:${index}`}>
                    <button
                      type="button"
                      className="reference-item"
                      onClick={() => onRevealReference(reference.from, reference.line)}
                    >
                      {basename(reference.from)} 第 {reference.line} 行
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="batch-delete-ref-groups">
                {inspection.referenceGroups.map((group) => (
                  <section key={group.targetPath} className="batch-delete-ref-group">
                    <h3 className="batch-delete-ref-heading" title={group.targetPath}>
                      <span>{basename(group.targetPath)}</span>
                      <span className="batch-delete-ref-count">{group.references.length} 处</span>
                    </h3>
                    <ul className="reference-list">
                      {group.references.map((reference, index) => (
                        <li key={`${group.targetPath}:${reference.from}:${reference.line}:${index}`}>
                          <button
                            type="button"
                            className="reference-item"
                            onClick={() => onRevealReference(reference.from, reference.line)}
                          >
                            {basename(reference.from)} 第 {reference.line} 行
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )
          ) : null}
        </div>
      ) : null}
    </Dialog>
  )
}
