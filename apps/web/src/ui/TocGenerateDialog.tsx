import {
  browserXmlCodec,
  generateTocFromHeadings,
  type EpubPackage,
  type TocEntry,
} from '@booksmith/core'
import { ChevronLeft, ChevronRight, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { basename } from '../state/bookStore'
import { Button } from './Button'
import { Dialog } from './Dialog'

export interface TocGenerateDialogProps {
  open: boolean
  pkg: EpubPackage
  texts: ReadonlyMap<string, string>
  tocPath: string
  existingEntries: TocEntry[]
  onOpenChange: (open: boolean) => void
  onApply: (nextEntries: TocEntry[], updatedChapters: Map<string, string>, summary: string) => void
}

const ALL_LEVELS = [1, 2, 3, 4, 5, 6] as const

export function TocGenerateDialog({
  open,
  pkg,
  texts,
  tocPath,
  existingEntries,
  onOpenChange,
  onApply,
}: TocGenerateDialogProps) {
  const [levels, setLevels] = useState<number[]>([1, 2, 3])
  const [mode, setMode] = useState<'append_missing' | 'replace'>(() =>
    existingEntries.length > 0 ? 'append_missing' : 'replace',
  )
  const [includeUntitledSpine, setIncludeUntitledSpine] = useState(false)
  const [injectMissingIds, setInjectMissingIds] = useState(true)
  const [excludedKeys, setExcludedKeys] = useState<Set<string>>(() => new Set())
  const [levelOverrides, setLevelOverrides] = useState<Record<string, number>>({})

  useEffect(() => {
    if (!open) return
    setMode(existingEntries.length > 0 ? 'append_missing' : 'replace')
    setExcludedKeys(new Set())
    setLevelOverrides({})
  }, [open, existingEntries.length])

  // Initial scan pass to enumerate all matching candidates for interactive toggling.
  const basePreview = useMemo(() => {
    if (!open) return null
    return generateTocFromHeadings(pkg, texts, tocPath, browserXmlCodec, {
      levels,
      includeUntitledSpine,
      injectMissingIds: false,
      mode,
      existingEntries,
      levelOverrides,
    })
  }, [open, pkg, texts, tocPath, levels, includeUntitledSpine, mode, existingEntries, levelOverrides])

  const selectedKeys = useMemo(() => {
    const out = new Set<string>()
    if (!basePreview) return out
    for (const candidate of basePreview.candidates) {
      if (!excludedKeys.has(candidate.key)) out.add(candidate.key)
    }
    return out
  }, [basePreview, excludedKeys])

  // Final dry-run with selection + optional ID injection so affected chapter counts are exact.
  const finalPreview = useMemo(() => {
    if (!open) return null
    return generateTocFromHeadings(pkg, texts, tocPath, browserXmlCodec, {
      levels,
      includeUntitledSpine,
      injectMissingIds,
      mode,
      existingEntries,
      selectedKeys,
      levelOverrides,
    })
  }, [open, pkg, texts, tocPath, levels, includeUntitledSpine, injectMissingIds, mode, existingEntries, selectedKeys, levelOverrides])

  const candidates = finalPreview?.candidates ?? []
  const minEffectiveLevel = useMemo(
    () => (candidates.length > 0 ? Math.min(...candidates.map((c) => c.level)) : 1),
    [candidates],
  )

  function toggleLevel(level: number) {
    setLevels((prev) => {
      if (prev.includes(level)) {
        return prev.filter((item) => item !== level)
      }
      return [...prev, level].sort((a, b) => a - b)
    })
    setExcludedKeys(new Set())
    setLevelOverrides({})
  }

  function toggleCandidate(key: string) {
    setExcludedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function shiftCandidateLevel(key: string, currentLevel: number, delta: -1 | 1) {
    const nextLevel = Math.min(6, Math.max(1, currentLevel + delta))
    setLevelOverrides((prev) => ({ ...prev, [key]: nextLevel }))
  }

  function selectAllCandidates() {
    setExcludedKeys(new Set())
  }

  function clearAllCandidates() {
    setExcludedKeys(new Set(candidates.map((item) => item.key)))
  }

  function handleApply() {
    if (!finalPreview) return
    const chapterCount = finalPreview.updatedChapters.size
    const actionText = mode === 'append_missing' ? `已补全 ${finalPreview.addedCount} 条目录` : `已生成 ${finalPreview.addedCount} 条目录`
    const idText = chapterCount > 0 ? `，为 ${chapterCount} 个章节补写 ${finalPreview.injectedIdCount} 个锚点` : ''
    onApply(finalPreview.entries, finalPreview.updatedChapters, `${actionText}${idText}`)
    onOpenChange(false)
  }

  const actionableCount = finalPreview?.addedCount ?? 0
  const affectedChapters = finalPreview?.updatedChapters.size ?? 0
  const injectedCount = finalPreview?.injectedIdCount ?? 0

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="从正文标题生成目录"
      description="按所选标题级别扫描全书正文章节，可逐条微调层级与勾选范围后再应用；应用后支持目录一键撤销。"
      className="toc-gen-dialog"
      footer={
        <div className="toc-gen-footer">
          <span className="toc-gen-summary">
            {mode === 'append_missing' ? `将追加 ${actionableCount} 项` : `将生成 ${actionableCount} 项`}
            {affectedChapters > 0 ? ` · 写入 ${affectedChapters} 个章节（${injectedCount} 个新锚点）` : ''}
          </span>
          <div className="toc-gen-footer-actions">
            <Button variant="ghost" size="sm" type="button" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              type="button"
              disabled={actionableCount === 0}
              onClick={handleApply}
            >
              <Sparkles size={13} strokeWidth={1.75} aria-hidden="true" />
              <span>{mode === 'append_missing' ? '补全缺失项' : '应用生成结果'}</span>
            </Button>
          </div>
        </div>
      }
    >
      <div className="toc-gen-controls">
        <div className="toc-gen-row">
          <div className="toc-gen-group" role="group" aria-label="纳入标题层级">
            <span className="toc-gen-label">标题层级</span>
            <div className="toc-level-pills">
              {ALL_LEVELS.map((lvl) => {
                const active = levels.includes(lvl)
                return (
                  <button
                    key={lvl}
                    type="button"
                    className={`toc-level-pill${active ? ' is-active' : ''}`}
                    aria-pressed={active}
                    onClick={() => toggleLevel(lvl)}
                  >
                    H{lvl}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="toc-gen-group" role="group" aria-label="落盘模式">
            <span className="toc-gen-label">写入方式</span>
            <div className="toc-mode-segment">
              <button
                type="button"
                className={mode === 'append_missing' ? 'is-active' : ''}
                aria-pressed={mode === 'append_missing'}
                onClick={() => setMode('append_missing')}
              >
                仅补全缺失项
              </button>
              <button
                type="button"
                className={mode === 'replace' ? 'is-active' : ''}
                aria-pressed={mode === 'replace'}
                onClick={() => setMode('replace')}
              >
                重建目录
              </button>
            </div>
          </div>
        </div>

        <div className="toc-gen-checks">
          <label className="toc-gen-check">
            <input
              type="checkbox"
              checked={injectMissingIds}
              onChange={(event) => setInjectMissingIds(event.target.checked)}
            />
            <span>
              自动为无 <code>id</code> 标题写入稳定锚点
              {injectMissingIds ? (
                <em className="toc-gen-hint">
                  {affectedChapters > 0
                    ? `（将修改 ${affectedChapters} 个章节，补写 ${injectedCount} 个 id）`
                    : '（当前已选项均有锚点）'}
                </em>
              ) : null}
            </span>
          </label>
          <label className="toc-gen-check">
            <input
              type="checkbox"
              checked={includeUntitledSpine}
              onChange={(event) => setIncludeUntitledSpine(event.target.checked)}
            />
            <span>将无匹配标题的章节按标题/文件名补入</span>
          </label>
        </div>
      </div>

      <div className="toc-gen-preview-head">
        <span>
          扫描结果（{candidates.length} 项
          {mode === 'append_missing'
            ? `，其中 ${candidates.filter((c) => c.alreadyInToc).length} 项已在目录中`
            : ''}
          ）
        </span>
        {candidates.length > 0 ? (
          <div className="toc-gen-bulk">
            <button type="button" onClick={selectAllCandidates}>
              全选
            </button>
            <button type="button" onClick={clearAllCandidates}>
              全不选
            </button>
          </div>
        ) : null}
      </div>

      {candidates.length === 0 ? (
        <div className="toc-gen-empty">
          <p>当前勾选的标题层级未在正文章节中匹配到标题。</p>
          <p className="toc-gen-empty-sub">请勾选更多标题级别（如 H1–H4），或开启「将无匹配标题的章节按标题/文件名补入」。</p>
        </div>
      ) : (
        <ul className="toc-gen-list" aria-label="生成目录预览">
          {candidates.map((candidate) => {
            const isSkippedExisting = mode === 'append_missing' && candidate.alreadyInToc
            const checked = !excludedKeys.has(candidate.key) && !isSkippedExisting
            const visualDepth = Math.min(5, Math.max(0, candidate.level - minEffectiveLevel))
            return (
              <li
                key={candidate.key}
                className={`toc-gen-item${isSkippedExisting ? ' is-existing' : ''}${!checked ? ' is-unchecked' : ''}`}
                style={{ paddingLeft: `${10 + visualDepth * 16}px` }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={isSkippedExisting}
                  aria-label={`选择 ${candidate.label}`}
                  onChange={() => toggleCandidate(candidate.key)}
                />
                <span className="toc-gen-tag">
                  {candidate.headingIndex < 0 ? '章' : `H${candidate.level}`}
                </span>
                <span className="toc-gen-title" title={`${candidate.label} (${candidate.href})`}>
                  {candidate.label}
                </span>
                <span className="toc-gen-meta">
                  {isSkippedExisting ? <span className="toc-gen-badge is-muted">已有</span> : null}
                  {candidate.willInjectId ? <span className="toc-gen-badge is-accent">+id</span> : null}
                  <span className="toc-gen-file" title={candidate.path}>
                    {basename(candidate.path)}
                  </span>
                </span>
                {!isSkippedExisting ? (
                  <span className="toc-gen-level-ops">
                    <button
                      type="button"
                      aria-label={`提升 ${candidate.label} 层级`}
                      title="提升一级"
                      disabled={candidate.level <= 1}
                      onClick={() => shiftCandidateLevel(candidate.key, candidate.level, -1)}
                    >
                      <ChevronLeft size={12} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label={`降低 ${candidate.label} 层级`}
                      title="降低一级"
                      disabled={candidate.level >= 6}
                      onClick={() => shiftCandidateLevel(candidate.key, candidate.level, 1)}
                    >
                      <ChevronRight size={12} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  </span>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </Dialog>
  )
}
