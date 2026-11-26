import { planBatchRename, type BatchRenameRule } from '@booksmith/core'
import { AlertCircle, ArrowRight, Check, Minus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { basename, extensionOf } from '../state/bookStore'
import { Button } from './Button'
import { Dialog } from './Dialog'

type RenameMode = BatchRenameRule['mode']

interface BatchRenameDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  paths: string[]
  existingPaths: ReadonlySet<string>
  protectedPaths: ReadonlySet<string>
  onConfirm: (renames: Map<string, string>) => void
}

function defaultPrefixFor(paths: string[]): string {
  if (paths.length === 0) return 'file_'
  const exts = new Set(paths.map((path) => extensionOf(path)))
  if ([...exts].every((ext) => ext === 'xhtml' || ext === 'html' || ext === 'htm')) return 'ch'
  if ([...exts].every((ext) => ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext))) return 'img_'
  if ([...exts].every((ext) => ext === 'css')) return 'style_'
  return 'file_'
}

/**
 * Multi-file rule-based batch rename dialog (`width: min(560px, calc(100vw - 32px))`).
 * Supports sequence numbering, literal find-and-replace, and prefix/suffix affixing with live
 * collision checking and extension protection by default.
 * See ADR 2026-11-26-filetree-batch-operations.
 */
export function BatchRenameDialog({
  open,
  onOpenChange,
  paths,
  existingPaths,
  protectedPaths,
  onConfirm,
}: BatchRenameDialogProps) {
  const [mode, setMode] = useState<RenameMode>('sequence')
  const [seqPrefix, setSeqPrefix] = useState('ch')
  const [seqStart, setSeqStart] = useState('1')
  const [seqPadWidth, setSeqPadWidth] = useState('3')
  const [findText, setFindText] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(true)
  const [affixPrefix, setAffixPrefix] = useState('')
  const [affixSuffix, setAffixSuffix] = useState('')
  const [preserveExtension, setPreserveExtension] = useState(true)

  useEffect(() => {
    if (!open) return
    setMode('sequence')
    setSeqPrefix(defaultPrefixFor(paths))
    setSeqStart('1')
    setSeqPadWidth(String(Math.max(3, String(paths.length).length)))
    setFindText('')
    setReplaceText('')
    setCaseSensitive(true)
    setAffixPrefix('')
    setAffixSuffix('')
    setPreserveExtension(true)
  }, [open, paths])

  const rule = useMemo<BatchRenameRule>(() => {
    if (mode === 'sequence') {
      const parsedStart = Number.parseInt(seqStart, 10)
      const parsedPad = Number.parseInt(seqPadWidth, 10)
      return {
        mode: 'sequence',
        prefix: seqPrefix,
        start: Number.isNaN(parsedStart) ? 1 : Math.max(0, parsedStart),
        padWidth: Number.isNaN(parsedPad) ? 3 : Math.max(1, Math.min(8, parsedPad)),
        preserveExtension,
      }
    }
    if (mode === 'replace') {
      return {
        mode: 'replace',
        find: findText,
        replace: replaceText,
        caseSensitive,
        preserveExtension,
      }
    }
    return {
      mode: 'affix',
      prefix: affixPrefix,
      suffix: affixSuffix,
      preserveExtension,
    }
  }, [
    mode,
    seqPrefix,
    seqStart,
    seqPadWidth,
    findText,
    replaceText,
    caseSensitive,
    affixPrefix,
    affixSuffix,
    preserveExtension,
  ])

  const plan = useMemo(
    () => planBatchRename(paths, rule, existingPaths, protectedPaths),
    [paths, rule, existingPaths, protectedPaths],
  )

  const handleSubmit = () => {
    if (!plan.canApply) return
    onConfirm(plan.renames)
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="批量重命名"
      title={`批量重命名 ${paths.length} 个文件`}
      description="仅修改各文件所在目录内的文件名，并自动同步 OPF 清单、目录与全书引用；支持同批链式或互换命名，应用后可撤销。"
      className="batch-rename-dialog"
      onSubmit={(event) => {
        event.preventDefault()
        handleSubmit()
      }}
      footer={
        <>
          <span className="batch-rename-footer-summary">
            将变更 {plan.changedCount} 项
            {plan.errorCount > 0 ? ` · ${plan.errorCount} 项存在冲突或非法名` : ''}
          </span>
          <div className="batch-rename-footer-actions">
            <Button variant="ghost" type="button" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button variant="primary" type="submit" disabled={!plan.canApply}>
              应用重命名
            </Button>
          </div>
        </>
      }
    >
      <div className="batch-rename-body">
        <div className="batch-rename-modes" role="tablist" aria-label="重命名规则模式">
          {(
            [
              { id: 'sequence', label: '按序编号' },
              { id: 'replace', label: '查找替换' },
              { id: 'affix', label: '添加前后缀' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={mode === tab.id}
              className={`batch-rename-mode-btn${mode === tab.id ? ' on' : ''}`}
              onClick={() => setMode(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {mode === 'sequence' ? (
          <div className="batch-rename-fields batch-rename-fields-seq">
            <label className="panel-field">
              <span>前缀</span>
              <input
                autoFocus
                type="text"
                value={seqPrefix}
                placeholder="例如 ch"
                onChange={(event) => setSeqPrefix(event.target.value)}
              />
            </label>
            <label className="panel-field">
              <span>起始编号</span>
              <input
                type="number"
                min={0}
                value={seqStart}
                onChange={(event) => setSeqStart(event.target.value)}
              />
            </label>
            <label className="panel-field">
              <span>补零位数</span>
              <input
                type="number"
                min={1}
                max={8}
                value={seqPadWidth}
                onChange={(event) => setSeqPadWidth(event.target.value)}
              />
            </label>
          </div>
        ) : mode === 'replace' ? (
          <div className="batch-rename-fields batch-rename-fields-pair">
            <label className="panel-field">
              <span>查找文本</span>
              <input
                autoFocus
                type="text"
                value={findText}
                placeholder="要替换的文件名片段"
                onChange={(event) => setFindText(event.target.value)}
              />
            </label>
            <label className="panel-field">
              <span>替换为</span>
              <input
                type="text"
                value={replaceText}
                placeholder="留空表示移除匹配片段"
                onChange={(event) => setReplaceText(event.target.value)}
              />
            </label>
          </div>
        ) : (
          <div className="batch-rename-fields batch-rename-fields-pair">
            <label className="panel-field">
              <span>前缀</span>
              <input
                autoFocus
                type="text"
                value={affixPrefix}
                placeholder="例如 part1_"
                onChange={(event) => setAffixPrefix(event.target.value)}
              />
            </label>
            <label className="panel-field">
              <span>后缀</span>
              <input
                type="text"
                value={affixSuffix}
                placeholder="例如 _v2"
                onChange={(event) => setAffixSuffix(event.target.value)}
              />
            </label>
          </div>
        )}

        <div className="batch-rename-options">
          <label className="batch-rename-check">
            <input
              type="checkbox"
              checked={preserveExtension}
              onChange={(event) => setPreserveExtension(event.target.checked)}
            />
            <span>锁定原扩展名（只修改主文件名）</span>
          </label>
          {mode === 'replace' ? (
            <label className="batch-rename-check">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(event) => setCaseSensitive(event.target.checked)}
              />
              <span>区分大小写</span>
            </label>
          ) : null}
        </div>

        {plan.errorCount > 0 ? (
          <p className="banner banner-error" role="alert">
            <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>
              有 {plan.errorCount} 个目标文件名存在冲突或非法字符，调整规则消除所有冲突后才能应用。
            </span>
          </p>
        ) : null}

        <div className="batch-rename-preview" role="region" aria-label="重命名预览">
          <div className="batch-rename-preview-head" aria-hidden="true">
            <span>原文件名</span>
            <span />
            <span>新文件名</span>
            <span>状态</span>
          </div>
          {plan.items.length === 0 ? (
            <p className="batch-rename-empty">当前没有可重命名的文件。</p>
          ) : (
            <ul className="batch-rename-list" role="list">
              {plan.items.map((item) => (
                <li key={item.from} className={`batch-rename-row is-${item.status}`}>
                  <span className="batch-rename-name" title={item.from}>
                    {basename(item.from)}
                  </span>
                  <ArrowRight size={12} strokeWidth={1.75} className="batch-rename-arrow" aria-hidden="true" />
                  <span className="batch-rename-target" title={item.to}>
                    {item.toName || '（空）'}
                  </span>
                  <span
                    className={`batch-rename-status is-${item.status}`}
                    title={item.reason}
                  >
                    {item.status === 'changed' ? (
                      <>
                        <Check size={11} strokeWidth={2} aria-hidden="true" />
                        <span>变更</span>
                      </>
                    ) : item.status === 'unchanged' ? (
                      <>
                        <Minus size={11} strokeWidth={2} aria-hidden="true" />
                        <span>未变</span>
                      </>
                    ) : (
                      <>
                        <AlertCircle size={11} strokeWidth={2} aria-hidden="true" />
                        <span>{item.status === 'conflict' ? '冲突' : '非法'}</span>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  )
}
