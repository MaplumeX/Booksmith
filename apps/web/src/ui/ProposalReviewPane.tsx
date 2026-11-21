import type { AgentProposal, AgentProposalFile } from '@booksmith/core'
import {
  AlertCircle,
  AlertTriangle,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Code2,
  Eye,
  FileDiff,
  Info,
  Palette,
  RotateCcw,
  SkipForward,
  X,
} from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { patchDocument } from '../preview/patchDocument'
import {
  buildPreviewDocument,
  EMPTY_IFRAME_DOC,
  PreviewBlobCache,
  type PreviewAssetResolver,
} from '../preview/render'
import { buildRevisionStyleCss, buildRevisionXhtml } from '../preview/revisionView'
import { basename, type LoadedBook } from '../state/bookStore'
import {
  buildComposedProposalPlan,
  buildFileHunks,
  buildVirtualReviewBook,
  composeFileFromHunks,
  findReferencingChaptersForCss,
  isChapterPath,
  isCssPath,
  summarizeStructuralProposal,
  validateComposedProposal,
  type FileDiffModel,
  type NumberedDiffLine,
  type ProposalHunk,
} from '../state/proposalReview'
import { useResolvedTheme } from '../state/settingsStore'
import { Button } from './Button'
import { FileTypeIcon } from './FileTypeIcon'

export type ProposalReviewMode = 'revision' | 'final' | 'source'

export interface ProposalReviewPaneProps {
  book: LoadedBook
  texts: ReadonlyMap<string, string>
  proposal: AgentProposal
  selectedPath: string
  readOnly?: boolean
  busy?: boolean
  autoDowngradeReason?: string | null
  skippedByPath: Readonly<Record<string, ReadonlySet<string>>>
  resolveAsset?: PreviewAssetResolver
  onSelectPath: (path: string) => void
  onToggleHunk: (path: string, hunkId: string) => void
  onResetFileHunks: (path: string) => void
  onApply: () => void
  onDismiss: () => void
  onExit: () => void
}

const KIND_LABELS: Record<AgentProposalFile['kind'], string> = {
  create: '新增',
  update: '修改',
  rename: '重命名',
  delete: '删除',
}

const SOURCE_CONTEXT_RADIUS = 4

function buildPaperFrameCss(theme: 'light' | 'dark'): string {
  const isDark = theme === 'dark'
  const canvasBg = isDark ? '#12131a' : '#f4f4f7'
  const paperBg = isDark ? '#1a1b24' : '#ffffff'
  const paperShadow = isDark
    ? '0 10px 28px -6px rgb(6 7 12 / 52%), 0 2px 6px rgb(6 7 12 / 34%)'
    : '0 10px 28px -6px rgb(18 19 26 / 9%), 0 2px 6px -1px rgb(18 19 26 / 5%)'
  return `
html {
  background: ${canvasBg} !important;
  min-height: 100%;
  padding: 20px 16px 48px;
  box-sizing: border-box;
}
body {
  max-width: 760px !important;
  min-height: calc(100vh - 68px);
  margin: 0 auto !important;
  padding: 36px 44px !important;
  background: ${paperBg} !important;
  border-radius: 14px;
  box-shadow: ${paperShadow};
  box-sizing: border-box;
}
@media (max-width: 640px) {
  html { padding: 10px 8px 32px; }
  body { padding: 20px 18px !important; border-radius: 10px; }
}
`
}

interface ReviewBookIframeProps {
  xhtml: string
  path: string
  archive: LoadedBook['archive']
  pkg: LoadedBook['pkg']
  resolveAsset?: PreviewAssetResolver
  extraCss: string
  activeHunkId?: string | null
  scrollSeq?: number
  onToggleHunk?: (hunkId: string) => void
  onGotoSourceHunk?: (hunkId: string) => void
  title: string
}

function ReviewBookIframe({
  xhtml,
  path,
  archive,
  pkg,
  resolveAsset,
  extraCss,
  activeHunkId = null,
  scrollSeq = 0,
  onToggleHunk,
  onGotoSourceHunk,
  title,
}: ReviewBookIframeProps) {
  const theme = useResolvedTheme()
  const frameRef = useRef<HTMLIFrameElement>(null)
  const blobCacheRef = useRef<PreviewBlobCache>(new PreviewBlobCache())
  const readyDocsRef = useRef<WeakSet<Document>>(new WeakSet())
  const [error, setError] = useState<string | null>(null)
  const callbacksRef = useRef({ onToggleHunk, onGotoSourceHunk })
  callbacksRef.current = { onToggleHunk, onGotoSourceHunk }

  const isDocReady = useCallback((): boolean => {
    const doc = frameRef.current?.contentDocument
    if (!doc?.documentElement || !doc.body) return false
    return doc.documentElement.hasAttribute('data-booksmith-shell') || readyDocsRef.current.has(doc)
  }, [])

  const scrollToHunk = useCallback((hunkId: string | null) => {
    const doc = frameRef.current?.contentDocument
    if (!doc || !hunkId) return
    const target = doc.querySelector<HTMLElement>(`[data-bs-hunk="${hunkId}"]`)
    if (!target) return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' })
  }, [])

  const renderNow = useCallback(() => {
    const iframe = frameRef.current
    const doc = iframe?.contentDocument
    if (!iframe || !doc || !isDocReady()) return

    try {
      const built = buildPreviewDocument({
        xhtml,
        path,
        archive,
        pkg,
        theme,
        blobCache: blobCacheRef.current,
        resolveAsset,
      })
      const styleEl = built.doc.createElement('style')
      styleEl.setAttribute('data-booksmith-review-style', 'true')
      styleEl.textContent = extraCss
      built.doc.head?.appendChild(styleEl)

      readyDocsRef.current.add(doc)
      patchDocument(doc, built.doc)
      blobCacheRef.current.flushObsolete(archive)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '书页预览渲染失败')
    }
  }, [xhtml, path, archive, pkg, theme, resolveAsset, extraCss, isDocReady])

  useEffect(() => {
    renderNow()
  }, [renderNow])

  useEffect(() => {
    if (!isDocReady()) return
    const doc = frameRef.current?.contentDocument
    if (!doc) return
    for (const el of Array.from(doc.querySelectorAll('[data-bs-hunk]'))) {
      if (el.getAttribute('data-bs-hunk') === activeHunkId) {
        el.setAttribute('data-bs-active', 'true')
      } else {
        el.removeAttribute('data-bs-active')
      }
    }
    if (activeHunkId) scrollToHunk(activeHunkId)
  }, [activeHunkId, scrollSeq, xhtml, isDocReady, scrollToHunk])

  const bindClickHandler = useCallback(() => {
    const doc = frameRef.current?.contentDocument
    if (!doc) return () => {}
    const onClick = (event: MouseEvent) => {
      // `event.target` belongs to the iframe realm, so `instanceof Element` (parent realm) is false.
      const raw = event.target as { closest?: (selector: string) => Element | null } | null
      const target = typeof raw?.closest === 'function' ? raw.closest('[data-bs-action]') : null
      if (!target) return
      const action = target.getAttribute('data-bs-action')
      const hunkId = target.getAttribute('data-bs-target-hunk') ?? target.getAttribute('data-bs-hunk')
      if (!hunkId) return
      event.preventDefault()
      event.stopPropagation()
      if (action === 'toggle-hunk') {
        callbacksRef.current.onToggleHunk?.(hunkId)
      } else if (action === 'goto-source') {
        callbacksRef.current.onGotoSourceHunk?.(hunkId)
      }
    }
    doc.addEventListener('click', onClick)
    return () => doc.removeEventListener('click', onClick)
  }, [])

  const cleanupClickRef = useRef<(() => void) | null>(null)

  const ensureClickBound = useCallback(() => {
    cleanupClickRef.current?.()
    cleanupClickRef.current = bindClickHandler()
  }, [bindClickHandler])

  const handleLoad = useCallback(() => {
    const doc = frameRef.current?.contentDocument
    if (doc) readyDocsRef.current.add(doc)
    ensureClickBound()
    renderNow()
    if (activeHunkId) {
      requestAnimationFrame(() => scrollToHunk(activeHunkId))
    }
  }, [ensureClickBound, renderNow, activeHunkId, scrollToHunk])

  useEffect(() => {
    if (isDocReady()) ensureClickBound()
    return () => {
      cleanupClickRef.current?.()
      blobCacheRef.current.dispose()
    }
  }, [isDocReady, ensureClickBound])

  return (
    <div className="review-book-wrap">
      {error ? (
        <p className="banner banner-error review-frame-error" role="alert">
          <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
      <iframe
        ref={frameRef}
        className="review-book-frame"
        title={title}
        sandbox="allow-same-origin"
        srcDoc={EMPTY_IFRAME_DOC}
        onLoad={handleLoad}
        hidden={Boolean(error)}
      />
    </div>
  )
}

interface SourceSegment {
  kind: 'gap' | 'same-group' | 'hunk'
  id: string
  rows: NumberedDiffLine[]
  hunk?: ProposalHunk
}

function buildSourceSegments(model: FileDiffModel): SourceSegment[] {
  const { allLines, hunks } = model
  if (allLines.length === 0) return []
  const hunkMap = new Map(hunks.map((h) => [h.id, h]))

  const keep = new Set<number>()
  allLines.forEach((row, idx) => {
    if (row.hunkId !== null) {
      for (
        let c = Math.max(0, idx - SOURCE_CONTEXT_RADIUS);
        c <= Math.min(allLines.length - 1, idx + SOURCE_CONTEXT_RADIUS);
        c += 1
      ) {
        keep.add(c)
      }
    }
  })

  const segments: SourceSegment[] = []
  let idx = 0
  while (idx < allLines.length) {
    const row = allLines[idx]!
    if (row.hunkId !== null) {
      const hunkId = row.hunkId
      const rows: NumberedDiffLine[] = []
      while (idx < allLines.length && allLines[idx]!.hunkId === hunkId) {
        rows.push(allLines[idx]!)
        idx += 1
      }
      segments.push({ kind: 'hunk', id: hunkId, rows, hunk: hunkMap.get(hunkId) })
      continue
    }

    if (!keep.has(idx)) {
      const startIdx = idx
      const rows: NumberedDiffLine[] = []
      while (idx < allLines.length && allLines[idx]!.hunkId === null && !keep.has(idx)) {
        rows.push(allLines[idx]!)
        idx += 1
      }
      segments.push({ kind: 'gap', id: `gap-${startIdx}`, rows })
      continue
    }

    const startIdx = idx
    const rows: NumberedDiffLine[] = []
    while (idx < allLines.length && allLines[idx]!.hunkId === null && keep.has(idx)) {
      rows.push(allLines[idx]!)
      idx += 1
    }
    segments.push({ kind: 'same-group', id: `same-${startIdx}`, rows })
  }

  return segments
}

function renderSourceRow(row: NumberedDiffLine) {
  const entry = row.diff
  if (entry.kind === 'changed') {
    return (
      <div className="review-src-row diff-changed" key={row.index}>
        <span className="review-src-ln">{row.beforeLine ?? ''}</span>
        <span className="review-src-ln">{row.afterLine ?? ''}</span>
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
    <div className={`review-src-row ${cls}`} key={row.index}>
      <span className="review-src-ln">{row.beforeLine ?? ''}</span>
      <span className="review-src-ln">{row.afterLine ?? ''}</span>
      <span className="diff-sign">{sign}</span>
      <span className="diff-code">{entry.text || ' '}</span>
    </div>
  )
}

export function ProposalReviewPane({
  book,
  texts,
  proposal,
  selectedPath,
  readOnly = false,
  busy = false,
  autoDowngradeReason = null,
  skippedByPath,
  resolveAsset,
  onSelectPath,
  onToggleHunk,
  onResetFileHunks,
  onApply,
  onDismiss,
  onExit,
}: ProposalReviewPaneProps) {
  const theme = useResolvedTheme()

  const modelsByPath = useMemo(() => {
    const map = new Map<string, FileDiffModel>()
    for (const file of proposal.files) {
      map.set(file.path, buildFileHunks(file))
    }
    return map
  }, [proposal.files])

  const activeFile = useMemo(
    () => proposal.files.find((f) => f.path === selectedPath) ?? proposal.files[0] ?? null,
    [proposal.files, selectedPath],
  )
  const activeModel = activeFile ? modelsByPath.get(activeFile.path) ?? null : null
  const activeFileIndex = activeFile ? proposal.files.findIndex((f) => f.path === activeFile.path) : 0

  const isChapter = activeFile ? isChapterPath(activeFile.path) : false
  const isCss = activeFile ? isCssPath(activeFile.path) : false
  const allowHunkToggle = !readOnly && !proposal.isStructural && activeFile?.kind === 'update'

  const [viewMode, setViewMode] = useState<ProposalReviewMode>(() => (isChapter ? 'revision' : 'source'))
  const [activeHunkIdx, setActiveHunkIdx] = useState(0)
  const [scrollSeq, setScrollSeq] = useState(0)
  const [expandedGaps, setExpandedGaps] = useState<Set<string>>(() => new Set())
  const [cssPreviewChapter, setCssPreviewChapter] = useState<string | null>(null)
  const [cssCompareMode, setCssCompareMode] = useState<'after' | 'before'>('after')

  const sourceContainerRef = useRef<HTMLDivElement>(null)

  // Reset per-file defaults when switching files inside the review pane.
  useEffect(() => {
    if (!activeFile) return
    setViewMode(isChapterPath(activeFile.path) ? 'revision' : 'source')
    setActiveHunkIdx(0)
    setScrollSeq((v) => v + 1)
    setExpandedGaps(new Set())
    setCssPreviewChapter(null)
    setCssCompareMode('after')
  }, [activeFile?.path, proposal.id])

  const plan = useMemo(
    () => buildComposedProposalPlan(proposal, modelsByPath, skippedByPath),
    [proposal, modelsByPath, skippedByPath],
  )

  const xmlFailures = useMemo(
    () => (readOnly ? [] : validateComposedProposal(proposal, plan)),
    [proposal, plan, readOnly],
  )

  const structuralSummary = useMemo(
    () => (proposal.isStructural ? summarizeStructuralProposal(proposal, book.pkg) : []),
    [proposal, book.pkg],
  )

  const virtualBook = useMemo(
    () =>
      buildVirtualReviewBook({
        book,
        texts,
        proposal,
        modelsByPath,
        skippedByPath,
        readOnly,
        cssOverride:
          isCss && cssPreviewChapter && activeFile
            ? { path: activeFile.path, mode: cssCompareMode }
            : null,
      }),
    [book, texts, proposal, modelsByPath, skippedByPath, readOnly, isCss, cssPreviewChapter, activeFile, cssCompareMode],
  )

  const cssReferencingChapters = useMemo(() => {
    if (!isCss || !activeFile) return []
    return findReferencingChaptersForCss(activeFile.path, virtualBook.pkg, virtualBook.texts)
  }, [isCss, activeFile, virtualBook.pkg, virtualBook.texts])

  const hunks = activeModel?.hunks ?? []
  const clampedHunkIdx = hunks.length > 0 ? Math.min(activeHunkIdx, hunks.length - 1) : -1
  const activeHunk = clampedHunkIdx >= 0 ? hunks[clampedHunkIdx]! : null

  const activeSkippedSet = activeFile ? skippedByPath[activeFile.path] : undefined

  const revisionResult = useMemo(() => {
    if (!activeModel || !isChapter) return null
    return buildRevisionXhtml({
      model: activeModel,
      skippedHunkIds: readOnly ? undefined : activeSkippedSet,
      allowHunkToggle,
      activeHunkId: activeHunk?.id ?? null,
    })
  }, [activeModel, isChapter, readOnly, activeSkippedSet, allowHunkToggle, activeHunk?.id])

  const finalChapterXhtml = useMemo(() => {
    if (!activeModel || !isChapter) return ''
    if (activeModel.file.kind === 'delete') return activeModel.file.beforeText ?? ''
    if (readOnly || proposal.isStructural) return activeModel.file.afterText ?? ''
    return composeFileFromHunks(activeModel, activeSkippedSet)
  }, [activeModel, isChapter, readOnly, proposal.isStructural, activeSkippedSet])

  const sourceSegments = useMemo(
    () => (activeModel ? buildSourceSegments(activeModel) : []),
    [activeModel],
  )

  const revisionCss = useMemo(() => buildRevisionStyleCss(theme), [theme])
  const paperCss = useMemo(() => buildPaperFrameCss(theme), [theme])

  const jumpHunk = (delta: -1 | 1) => {
    if (hunks.length === 0) return
    setActiveHunkIdx((cur) => (cur + delta + hunks.length) % hunks.length)
    setScrollSeq((v) => v + 1)
  }

  // Scroll active hunk into view when in source diff view.
  useEffect(() => {
    if (viewMode !== 'source' || !activeHunk || !sourceContainerRef.current) return
    const target = sourceContainerRef.current.querySelector<HTMLElement>(
      `[data-review-source-hunk="${activeHunk.id}"]`,
    )
    if (!target) return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' })
  }, [viewMode, activeHunk?.id, scrollSeq])

  const handleGotoSourceHunk = useCallback(
    (hunkId: string) => {
      const idx = hunks.findIndex((h) => h.id === hunkId)
      if (idx >= 0) setActiveHunkIdx(idx)
      setViewMode('source')
      setScrollSeq((v) => v + 1)
    },
    [hunks],
  )

  if (!activeFile || !activeModel) {
    return (
      <section className="review-pane" aria-label="提案审阅">
        <div className="review-empty">
          <p>该提案不包含可审阅的文件变更。</p>
          <Button variant="secondary" size="sm" type="button" onClick={onExit}>
            返回编辑
          </Button>
        </div>
      </section>
    )
  }

  const hasValidationIssues = proposal.validationIssues.length > 0
  const hasXmlFailures = xmlFailures.length > 0
  const applyDisabled =
    busy ||
    hasValidationIssues ||
    hasXmlFailures ||
    (!proposal.isStructural && plan.selectedPaths.size === 0)

  const applyLabel = proposal.isStructural
    ? '应用全部变更'
    : plan.totalHunks > 0 && plan.keptHunks < plan.totalHunks
      ? `应用已选（${plan.keptHunks}/${plan.totalHunks} 处）`
      : '应用变更'

  const fileSelectionState = plan.fileStates.get(activeFile.path)
  const activeFileAllSkipped =
    !readOnly &&
    !proposal.isStructural &&
    activeModel.hunks.length > 0 &&
    (fileSelectionState?.kept ?? 0) === 0

  return (
    <section className="review-pane" aria-label="书籍变更审阅">
      <header className="review-toolbar">
        <div className="review-toolbar-left">
          {readOnly ? (
            <span className="review-readonly-pill">
              <CheckCircle2 size={12} strokeWidth={1.85} aria-hidden="true" />
              <span>已应用回看</span>
            </span>
          ) : (
            <span className="review-mode-pill">
              <FileDiff size={12} strokeWidth={1.85} aria-hidden="true" />
              <span>审阅提案</span>
            </span>
          )}

          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="review-file-trigger"
                aria-label="切换待审阅文件"
                title={activeFile.path}
              >
                <FileTypeIcon path={activeFile.path} size={13} />
                <span className={`agent-kind-tag is-${activeFile.kind}`}>{KIND_LABELS[activeFile.kind]}</span>
                <span className="review-file-trigger-name">
                  {activeFile.kind === 'rename' && activeFile.previousPath
                    ? `${basename(activeFile.previousPath)} → ${basename(activeFile.path)}`
                    : basename(activeFile.path)}
                </span>
                {proposal.files.length > 1 ? (
                  <span className="review-file-count">
                    {activeFileIndex + 1}/{proposal.files.length}
                  </span>
                ) : null}
                <ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="review-file-menu"
                align="start"
                sideOffset={6}
                collisionPadding={10}
              >
                {proposal.files.map((file) => {
                  const m = modelsByPath.get(file.path)
                  const state = plan.fileStates.get(file.path)
                  const isCurrent = file.path === activeFile.path
                  return (
                    <DropdownMenu.Item
                      key={`${file.kind}:${file.path}`}
                      className={`review-file-menu-item${isCurrent ? ' is-current' : ''}`}
                      onSelect={() => onSelectPath(file.path)}
                    >
                      <span className="review-file-menu-check" aria-hidden="true">
                        {isCurrent ? <Check size={12} strokeWidth={2} /> : null}
                      </span>
                      <span className={`agent-kind-tag is-${file.kind}`}>{KIND_LABELS[file.kind]}</span>
                      <span className="review-file-menu-name" title={file.path}>
                        {file.kind === 'rename' && file.previousPath
                          ? `${basename(file.previousPath)} → ${basename(file.path)}`
                          : basename(file.path)}
                      </span>
                      {m && (m.added > 0 || m.removed > 0) ? (
                        <span className="agent-diff-stats">
                          {m.added > 0 ? <span className="is-add">+{m.added}</span> : null}
                          {m.removed > 0 ? <span className="is-del">-{m.removed}</span> : null}
                        </span>
                      ) : null}
                      {!readOnly && !proposal.isStructural && state && state.total > 0 && state.kept < state.total ? (
                        <span className="review-file-menu-kept">
                          {state.kept}/{state.total}
                        </span>
                      ) : null}
                    </DropdownMenu.Item>
                  )
                })}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>

          {isChapter ? (
            <div className="review-view-switch" role="group" aria-label="审阅视角">
              <button
                type="button"
                className={`review-view-btn${viewMode === 'revision' ? ' on' : ''}`}
                aria-pressed={viewMode === 'revision'}
                onClick={() => setViewMode('revision')}
              >
                <BookOpen size={12} strokeWidth={1.8} aria-hidden="true" />
                <span>修订</span>
              </button>
              <button
                type="button"
                className={`review-view-btn${viewMode === 'final' ? ' on' : ''}`}
                aria-pressed={viewMode === 'final'}
                onClick={() => setViewMode('final')}
              >
                <Eye size={12} strokeWidth={1.8} aria-hidden="true" />
                <span>终稿</span>
              </button>
              <button
                type="button"
                className={`review-view-btn${viewMode === 'source' ? ' on' : ''}`}
                aria-pressed={viewMode === 'source'}
                onClick={() => setViewMode('source')}
              >
                <Code2 size={12} strokeWidth={1.8} aria-hidden="true" />
                <span>源码</span>
              </button>
            </div>
          ) : null}
        </div>

        <div className="review-toolbar-right">
          {hunks.length > 0 && !cssPreviewChapter ? (
            <div className="review-hunk-nav" aria-label="变更定位">
              <button
                type="button"
                className="review-nav-btn"
                aria-label="上一处变更"
                title="上一处变更"
                disabled={hunks.length <= 1}
                onClick={() => jumpHunk(-1)}
              >
                <ChevronUp size={13} strokeWidth={1.85} aria-hidden="true" />
              </button>
              <span className="review-nav-counter">
                {clampedHunkIdx + 1}/{hunks.length}
              </span>
              <button
                type="button"
                className="review-nav-btn"
                aria-label="下一处变更"
                title="下一处变更"
                disabled={hunks.length <= 1}
                onClick={() => jumpHunk(1)}
              >
                <ChevronDown size={13} strokeWidth={1.85} aria-hidden="true" />
              </button>
            </div>
          ) : null}

          {!readOnly ? (
            <div className="review-actions">
              <Button variant="ghost" size="sm" type="button" disabled={busy} onClick={onDismiss}>
                放弃
              </Button>
              <Button variant="primary" size="sm" type="button" disabled={applyDisabled} onClick={onApply}>
                {applyLabel}
              </Button>
            </div>
          ) : null}

          <button
            type="button"
            className="review-exit-btn"
            aria-label={readOnly ? '退出回看' : '退出审阅'}
            title={readOnly ? '退出回看，返回编辑' : '退出审阅（保留已选草稿）'}
            onClick={onExit}
          >
            <X size={14} strokeWidth={1.85} aria-hidden="true" />
            <span>{readOnly ? '退出回看' : '退出'}</span>
          </button>
        </div>
      </header>

      <div className="review-banners">
        {proposal.isStructural && structuralSummary.length > 0 ? (
          <div className="review-context-strip is-structural" role="status">
            <Info size={13} strokeWidth={1.8} aria-hidden="true" />
            <span>
              <strong>结构变更 · 整批应用：</strong>
              {structuralSummary.join(' · ')}
            </span>
          </div>
        ) : null}

        {autoDowngradeReason ? (
          <div className="banner banner-warn review-banner" role="status">
            <AlertTriangle size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>{autoDowngradeReason}</span>
          </div>
        ) : null}

        {hasValidationIssues ? (
          <div className="banner banner-error review-banner" role="alert">
            <AlertCircle size={14} strokeWidth={1.8} aria-hidden="true" />
            <div>
              <strong>结构预检未通过，已阻断应用</strong>
              <ul className="review-issue-list">
                {proposal.validationIssues.map((issue, idx) => (
                  <li key={`${issue.code}-${idx}`}>{issue.message}</li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}

        {hasXmlFailures ? (
          <div className="banner banner-error review-banner" role="alert">
            <AlertCircle size={14} strokeWidth={1.8} aria-hidden="true" />
            <div className="review-xml-fail-body">
              <strong>部分跳过导致 XML 不闭合，已阻断应用</strong>
              {xmlFailures.map((fail) => (
                <div className="review-xml-fail-row" key={fail.path}>
                  <span>{fail.message}</span>
                  <span className="review-xml-fail-actions">
                    <button
                      type="button"
                      className="banner-action"
                      onClick={() => onResetFileHunks(fail.path)}
                    >
                      恢复该文件全部改动
                    </button>
                    <button
                      type="button"
                      className="banner-action"
                      onClick={() => {
                        onSelectPath(fail.path)
                        setViewMode('source')
                      }}
                    >
                      切源码查看
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {activeFile.referencesAffected && activeFile.referencesAffected.length > 0 ? (
          <div className="banner banner-warn review-banner" role="status">
            <AlertTriangle size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>
              删除此文件将导致 {activeFile.referencesAffected.length} 处外部引用失效：
              {activeFile.referencesAffected
                .slice(0, 4)
                .map((r) => `${basename(r.from)}:${r.line}`)
                .join('、')}
            </span>
          </div>
        ) : null}

        {isChapter && viewMode === 'revision' && revisionResult && revisionResult.headHunkIds.length > 0 ? (
          <div className="review-context-strip" role="status">
            <Info size={13} strokeWidth={1.8} aria-hidden="true" />
            <span>另有 {revisionResult.headHunkIds.length} 处文档头（&lt;head&gt;）或样式链接改动。</span>
            <button
              type="button"
              className="review-inline-link"
              onClick={() => handleGotoSourceHunk(revisionResult.headHunkIds[0]!)}
            >
              切源码查看
            </button>
          </div>
        ) : null}

        {activeFileAllSkipped ? (
          <div className="review-context-strip" role="status">
            <SkipForward size={13} strokeWidth={1.8} aria-hidden="true" />
            <span>当前文件已跳过全部 {activeModel.hunks.length} 处改动，应用时将保持原文不变。</span>
            <button
              type="button"
              className="review-inline-link"
              onClick={() => onResetFileHunks(activeFile.path)}
            >
              恢复本文件全部改动
            </button>
          </div>
        ) : null}

        {isCss && cssReferencingChapters.length > 0 ? (
          <div className="review-context-strip is-css">
            <Palette size={13} strokeWidth={1.8} aria-hidden="true" />
            {cssPreviewChapter ? (
              <>
                <span>
                  正在书页终稿中预览 <strong>{basename(activeFile.path)}</strong> 对{' '}
                  <strong>{basename(cssPreviewChapter)}</strong> 的样式效果
                </span>
                {cssReferencingChapters.length > 1 ? (
                  <select
                    className="review-css-chapter-select"
                    aria-label="选择预览章节"
                    value={cssPreviewChapter}
                    onChange={(event) => setCssPreviewChapter(event.target.value)}
                  >
                    {cssReferencingChapters.map((ch) => (
                      <option key={ch} value={ch}>
                        {basename(ch)}
                      </option>
                    ))}
                  </select>
                ) : null}
                <div className="review-css-toggle" role="group" aria-label="样式对比状态">
                  <button
                    type="button"
                    className={`review-css-toggle-btn${cssCompareMode === 'after' ? ' on' : ''}`}
                    aria-pressed={cssCompareMode === 'after'}
                    onClick={() => setCssCompareMode('after')}
                  >
                    修改后样式
                  </button>
                  <button
                    type="button"
                    className={`review-css-toggle-btn${cssCompareMode === 'before' ? ' on' : ''}`}
                    aria-pressed={cssCompareMode === 'before'}
                    onClick={() => setCssCompareMode('before')}
                  >
                    修改前样式
                  </button>
                </div>
                <button
                  type="button"
                  className="review-inline-link"
                  onClick={() => setCssPreviewChapter(null)}
                >
                  返回样式源码
                </button>
              </>
            ) : (
              <>
                <span>该样式表被 {cssReferencingChapters.length} 个章节引用。</span>
                <button
                  type="button"
                  className="review-inline-link"
                  onClick={() => {
                    setCssPreviewChapter(cssReferencingChapters[0]!)
                    setCssCompareMode('after')
                  }}
                >
                  在引用章节终稿中预览样式（{basename(cssReferencingChapters[0]!)}）
                </button>
              </>
            )}
          </div>
        ) : null}
      </div>

      <div className="review-body">
        {isCss && cssPreviewChapter ? (
          <ReviewBookIframe
            xhtml={virtualBook.texts.get(cssPreviewChapter) ?? ''}
            path={cssPreviewChapter}
            archive={virtualBook.archive}
            pkg={virtualBook.pkg}
            resolveAsset={resolveAsset}
            extraCss={paperCss}
            title={`样式终稿预览：${basename(cssPreviewChapter)}`}
          />
        ) : activeFile.kind === 'rename' && activeModel.isNoopText ? (
          <div className="review-empty">
            <p className="review-empty-title">仅重命名路径（正文内容无差异）</p>
            <p className="review-empty-sub">
              <code>{activeFile.previousPath}</code> → <code>{activeFile.path}</code>
            </p>
          </div>
        ) : isChapter && viewMode === 'revision' && revisionResult ? (
          <ReviewBookIframe
            xhtml={revisionResult.xhtml}
            path={activeFile.path}
            archive={virtualBook.archive}
            pkg={virtualBook.pkg}
            resolveAsset={resolveAsset}
            extraCss={revisionCss}
            activeHunkId={activeHunk?.id ?? null}
            scrollSeq={scrollSeq}
            onToggleHunk={allowHunkToggle ? (hunkId) => onToggleHunk(activeFile.path, hunkId) : undefined}
            onGotoSourceHunk={handleGotoSourceHunk}
            title={`书页修订视图：${basename(activeFile.path)}`}
          />
        ) : isChapter && viewMode === 'final' ? (
          <ReviewBookIframe
            xhtml={finalChapterXhtml}
            path={activeFile.path}
            archive={virtualBook.archive}
            pkg={virtualBook.pkg}
            resolveAsset={resolveAsset}
            extraCss={paperCss}
            title={`书页终稿预览：${basename(activeFile.path)}`}
          />
        ) : (
          <div className="review-source-scroll" ref={sourceContainerRef}>
            <div className="review-source-sheet">
              {sourceSegments.length === 0 ? (
                <div className="review-empty">
                  <p>文本内容无差异。</p>
                </div>
              ) : (
                sourceSegments.map((seg) => {
                  if (seg.kind === 'gap') {
                    const isExpanded = expandedGaps.has(seg.id)
                    if (isExpanded) {
                      return <div key={seg.id}>{seg.rows.map(renderSourceRow)}</div>
                    }
                    return (
                      <button
                        key={seg.id}
                        type="button"
                        className="review-src-gap-btn"
                        onClick={() =>
                          setExpandedGaps((prev) => {
                            const next = new Set(prev)
                            next.add(seg.id)
                            return next
                          })
                        }
                      >
                        展开省略的 {seg.rows.length} 行未修改内容
                      </button>
                    )
                  }

                  if (seg.kind === 'same-group') {
                    return <div key={seg.id}>{seg.rows.map(renderSourceRow)}</div>
                  }

                  const hunk = seg.hunk!
                  const isSkipped = Boolean(!readOnly && activeSkippedSet?.has(hunk.id))
                  const isFocused = activeHunk?.id === hunk.id
                  const lineRange =
                    hunk.afterCount > 0
                      ? `第 ${hunk.afterStart}–${hunk.afterStart + hunk.afterCount - 1} 行`
                      : `原第 ${hunk.beforeStart}–${hunk.beforeStart + Math.max(hunk.beforeCount - 1, 0)} 行`

                  return (
                    <section
                      key={hunk.id}
                      data-review-source-hunk={hunk.id}
                      className={`review-src-hunk${isFocused ? ' is-focused' : ''}${isSkipped ? ' is-skipped' : ''}`}
                    >
                      <div className="review-src-hunk-bar">
                        <span className="review-src-hunk-meta">
                          第 {hunk.index + 1}/{hunks.length} 处 · {lineRange}
                          <span className="agent-diff-stats">
                            {hunk.addedCount > 0 ? <span className="is-add">+{hunk.addedCount}</span> : null}
                            {hunk.removedCount > 0 ? <span className="is-del">-{hunk.removedCount}</span> : null}
                          </span>
                        </span>
                        {allowHunkToggle ? (
                          <button
                            type="button"
                            className={`review-src-hunk-toggle${isSkipped ? ' is-skipped' : ''}`}
                            onClick={() => onToggleHunk(activeFile.path, hunk.id)}
                          >
                            {isSkipped ? (
                              <>
                                <RotateCcw size={11} strokeWidth={1.85} aria-hidden="true" />
                                <span>已跳过 · 恢复保留</span>
                              </>
                            ) : (
                              <span>跳过此处</span>
                            )}
                          </button>
                        ) : null}
                      </div>
                      <div className="review-src-hunk-lines">{seg.rows.map(renderSourceRow)}</div>
                    </section>
                  )
                })
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
