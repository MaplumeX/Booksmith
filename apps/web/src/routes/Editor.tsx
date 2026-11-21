import {
  addManifestItem,
  addSpineDocument,
  countSplitMarkers,
  createBlankStylesheet,
  deleteUnusedResourcesInBook,
  duplicateChapterInBook,
  findUnusedResources,
  formatCss,
  formatXhtml,
  getLinkedStylesheets,
  hasPageHistory,
  browserXmlCodec,
  browserXmlParser,
  collectReferences,
  dirname,
  findBrokenAnchors,
  initializeBookToc,
  isTextEntry,
  lintBook,
  listBookStylesheets,
  mergeChaptersInBook,
  parsePackage,
  readNavToc,
  readNcxToc,
  rebaseTocHrefs,
  relativePath,
  removeManifestEntry,
  renameManifestEntry,
  reorderSpine,
  setManifestMediaType,
  resolvePath,
  rewriteReferences,
  SPLIT_MARKER_HTML,
  splitChapterAtMarkersInBook,
  splitChapterInBook,
  splitFragment,
  touchOpfModified,
  updateChaptersStylesheets,
  writeNavToc,
  writeNcxToc,
  writeOpfMeta,
  writeOpfMetadata,
  type AgentProposal,
  type AgentProposalFile,
  type EpubArchive,
  type EpubIssue,
  type EpubPackage,
  type OpfMetaRow,
  type SearchFile,
  type TocEntry,
} from '@booksmith/core'
import {
  AlertCircle,
  AlertTriangle,
  AlignLeft,
  ArrowLeft,
  Bold,
  Check,
  Code2,
  Columns2,
  Copy,
  Download,
  FileCode2,
  FilePenLine,
  FilePlus2,
  FolderTree,
  History,
  ImagePlus,
  Italic,
  ListTree,
  Loader2,
  Merge,
  Save,
  Scissors,
  Search,
  SeparatorHorizontal,
  Settings,
  ShieldCheck,
  Sparkles,
  Split,
  Tags,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import { Popover } from 'radix-ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, api, downloadUrl, type AgentProfileDto, type AgentUserSettingsDto } from '../api/client'
import {
  insertAnchorId,
  insertHorizontalRule,
  insertImageTag,
  insertLinkTag,
  insertRawText,
  wrapBlockTag,
  wrapInlineTag,
  wrapList,
} from '../editor/codeActions'
import { formatShortcut } from '../editor/shortcuts'
import { mediaTypeFromExtension, mediaTypeOf } from '../preview/render'
import { spinePaths } from '../diff/document'
import { navigate } from '../router'
import {
  applyProposalToBook,
  collectDirtyTexts,
  computeDeletedPaths,
  createUndoSnapshot,
  type WorkspaceSnapshot,
} from '../state/agentProposal'
import {
  buildComposedProposalPlan,
  buildFileHunks,
  detectProposalStaleness,
  validateComposedProposal,
  type FileDiffModel,
} from '../state/proposalReview'
import {
  basename,
  extensionOf,
  groupFiles,
  loadBook,
  proseLength,
  resolveBookAsset,
  type LoadedBook,
} from '../state/bookStore'
import { applySavedEntriesToBook, buildEntryDelta } from '../state/entryDelta'
import { createAutosave, type Autosave } from '../state/autosave'
import {
  computeDirtySummary,
  createSavedBaseline,
  setsEqual,
  type DirtySummary,
  type SavedBaseline,
} from '../state/dirtyState'
import type { ReplacePlan } from '../state/replacePlan'
import { DRAFT_DEBOUNCE_MS, clearDraft, planDraftRestore, readDraft, writeDraft } from '../state/draftStore'
import { getSettings, useSettings } from '../state/settingsStore'
import {
  popStructureHistory,
  pushStructureHistory,
  type StructureHistoryEntry,
} from '../state/structureHistory'
import { AgentPanel, type ProposalStatusSyncEvent } from '../ui/AgentPanel'
import { Button } from '../ui/Button'
import { CheckPanel } from '../ui/CheckPanel'
import { CodePane, type CodePaneHandle } from '../ui/CodePane'
import { CodeToolbar, type CodeFileKind } from '../ui/CodeToolbar'
import { CommandPalette, type CommandItem } from '../ui/CommandPalette'
import type { ContextMenuEntry } from '../ui/ContextMenu'
import { Dialog } from '../ui/Dialog'
import { EmptyState } from '../ui/EmptyState'
import { FileTree } from '../ui/FileTree'
import { LinkStylesheetsDialog } from '../ui/LinkStylesheetsDialog'
import { MediaPane } from '../ui/MediaPane'
import { PreviewPane } from '../ui/PreviewPane'
import { ProposalReviewPane } from '../ui/ProposalReviewPane'
import { MetadataPanel } from '../ui/MetadataPanel'
import { SearchPanel } from '../ui/SearchPanel'
import { SettingsDialog, type SettingsTab } from '../ui/SettingsDialog'
import { TocPanel } from '../ui/TocPanel'
import type { NavigateTarget, RevealTarget } from '../ui/CodePane'
import { StatusBar } from '../ui/StatusBar'
import { TabBar, type EditorViewMode } from '../ui/TabBar'
import { UnusedResourcesDialog } from '../ui/UnusedResourcesDialog'
import { VersionHistory } from '../ui/VersionHistory'
import { WysiwygPane, type WysiwygShortcut } from '../ui/WysiwygPane'

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' }
type NavIslandTab = 'files' | 'toc'

interface ActiveProposalReview {
  messageId: string
  proposal: AgentProposal
  selectedPath: string
  readOnly: boolean
  autoDowngradeReason?: string | null
}

const SIDEBAR_MIN = 400
const SIDEBAR_MAX = 560

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'not_found') return '这本书不存在或已被删除'
    if (error.code === 'unauthenticated') return '登录已过期，请重新登录'
    if (error.code === 'invalid_epub') return '保存的内容不是有效 EPUB，检查刚才的修改'
    return `打开失败（${error.code}）`
  }
  return error instanceof Error ? error.message : '打开失败'
}

function clockLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function isPreviewable(path: string | null): boolean {
  if (!path) return false
  const extension = extensionOf(path)
  return extension === 'xhtml' || extension === 'html' || extension === 'htm'
}

function codeFileKindOf(path: string | null): CodeFileKind {
  if (!path) return 'other'
  const ext = extensionOf(path)
  if (ext === 'xhtml' || ext === 'html' || ext === 'htm') return 'xhtml'
  if (ext === 'css') return 'css'
  if (ext === 'xml' || ext === 'opf' || ext === 'ncx' || ext === 'svg') return 'xml'
  return 'other'
}

const encoder = new TextEncoder()

function lineOf(text: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === '\n') line += 1
  }
  return line
}

/** Finds the element that an in-book fragment names, so a followed link lands on its target. */
function fragmentIndex(text: string, fragment: string): number {
  const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`\\b(?:id|name)\\s*=\\s*["']${escaped}["']`).exec(text)
  return match ? match.index : -1
}

function archiveOrder(previous: string[], entries: Map<string, Uint8Array>): string[] {
  const order = previous.filter((path) => entries.has(path))
  for (const path of entries.keys()) if (!order.includes(path)) order.push(path)
  return order
}

/** Re-reads the package document after a structural edit and regroups the tree. */
function refreshPackage(
  book: LoadedBook,
  texts: Map<string, string>,
  entries: Map<string, Uint8Array>,
): LoadedBook {
  const pkg = parsePackage(texts.get(book.pkg.opfPath) ?? '', book.pkg.opfPath, browserXmlParser)
  const archive: EpubArchive = { order: archiveOrder(book.archive.order, entries), entries }
  return { ...book, archive, pkg, texts, groups: groupFiles(pkg, archive) }
}

/** Reconciles `LoadedBook` entry metadata & caches after a `@booksmith/core` structural operation. */
function reconcileBookAfterStructure(
  current: LoadedBook,
  nextFiles: Map<string, string>,
  nextArchive: EpubArchive,
  nextPkg: EpubPackage,
): LoadedBook {
  const entryMeta = new Map(current.entryMeta)
  const entryOrigins = new Map(current.entryOrigins)
  const localBinaries = new Map(current.localBinaries)

  for (const existing of Array.from(entryMeta.keys())) {
    if (!nextArchive.entries.has(existing)) {
      entryMeta.delete(existing)
      entryOrigins.delete(existing)
      localBinaries.delete(existing)
    }
  }
  for (const [path, text] of nextFiles) {
    if (!nextArchive.entries.has(path)) continue
    const encoded = encoder.encode(text)
    nextArchive.entries.set(path, encoded)
    const prev = entryMeta.get(path)
    entryMeta.set(path, {
      path,
      isText: isTextEntry(path),
      mediaType:
        nextPkg.manifest.find((item) => item.path === path)?.mediaType ??
        prev?.mediaType ??
        mediaTypeFromExtension(path),
      byteSize: encoded.byteLength,
      sha256: null,
    })
  }

  return {
    ...current,
    archive: nextArchive,
    pkg: nextPkg,
    texts: nextFiles,
    groups: groupFiles(nextPkg, nextArchive),
    entryMeta,
    entryOrigins,
    localBinaries,
  }
}

function chapterDirectory(book: LoadedBook): string {
  const first = spinePaths(book.pkg)[0]
  return first ? dirname(first) : dirname(book.pkg.opfPath)
}

function nextChapterName(book: LoadedBook, dir: string): string {
  const pattern = new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/ch(\\d+)\\.xhtml$`)
  let max = 0
  for (const path of book.archive.entries.keys()) {
    const match = pattern.exec(path)
    if (match?.[1]) max = Math.max(max, Number(match[1]))
  }
  return `ch${String(max + 1).padStart(3, '0')}.xhtml`
}

function chapterSkeleton(name: string, language: string): string {
  const title = name.replace(/\.xhtml$/, '')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}">
<head><meta charset="utf-8"/><title>${title}</title></head>
<body>
<section epub:type="chapter">
<h1>${title}</h1>
<p></p>
</section>
</body>
</html>
`
}

/** Drops TOC entries pointing at a removed file; a dangling entry can never resolve again. */
function pruneToc(entries: TocEntry[], tocPath: string, removed: string): { entries: TocEntry[]; changed: boolean } {
  let changed = false
  const kept: TocEntry[] = []
  for (const entry of entries) {
    const href = entry.href.split('#')[0] ?? ''
    if (href && resolvePath(dirname(tocPath), href) === removed) {
      changed = true
      continue
    }
    const children = pruneToc(entry.children, tocPath, removed)
    if (children.changed) changed = true
    kept.push(children.changed ? { ...entry, children: children.entries } : entry)
  }
  return { entries: kept, changed }
}

export function Editor({ bookId }: { bookId: string }) {
  const { settings } = useSettings()
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [book, setBook] = useState<LoadedBook | null>(null)
  const [tabs, setTabs] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [dirty, setDirty] = useState<Set<string>>(new Set())
  const [treeOpen, setTreeOpen] = useState(false)
  const [navTab, setNavTab] = useState<NavIslandTab>('files')
  const [previewOpen, setPreviewOpen] = useState(() => getSettings().defaultPreviewOpen)
  const [searchOpen, setSearchOpen] = useState(false)
  const [metadataOpen, setMetadataOpen] = useState(false)
  const [checkOpen, setCheckOpen] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(440)
  const [reveal, setReveal] = useState<RevealTarget | null>(null)
  const [revealFragment, setRevealFragment] = useState<{ path: string; fragment: string; key: number } | null>(null)
  const [activeTocHref, setActiveTocHref] = useState<string | null>(null)
  const tocUndoStack = useRef<
    Array<{
      beforeTexts: Map<string, string | undefined>
      afterTexts: Map<string, string | undefined>
    }>
  >([])
  const tocRedoStack = useRef<
    Array<{
      beforeTexts: Map<string, string | undefined>
      afterTexts: Map<string, string | undefined>
    }>
  >([])
  const [tocHistoryState, setTocHistoryState] = useState({ canUndo: false, canRedo: false })
  const assetInput = useRef<HTMLInputElement>(null)
  const [saving, setSaving] = useState(false)
  const [showSaving, setShowSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [historyPath, setHistoryPath] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [draftPrompt, setDraftPrompt] = useState<ReturnType<typeof planDraftRestore> | null>(null)
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null)
  const [serverIssues, setServerIssues] = useState<EpubIssue[]>([])
  /** Bumped when a form writes into an already-dirty file: the dirty set cannot signal that. */
  const [, setRevision] = useState(0)
  const [renaming, setRenaming] = useState<{ path: string; value: string; error: string | null } | null>(null)
  const [deleting, setDeleting] = useState<{
    path: string
    references: Array<{ from: string; line: number }>
  } | null>(null)
  const tabsRef = useRef<string[]>([])
  const texts = useRef<Map<string, string>>(new Map())
  const baselineRef = useRef<SavedBaseline>(createSavedBaseline(new Map(), new Map()))
  const autosave = useRef<Autosave | null>(null)
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef<Set<string>>(new Set())
  const savingRef = useRef(false)
  const conflictRef = useRef(false)
  const bookRef = useRef<LoadedBook | null>(null)
  const saveRef = useRef<(options?: { checkpoint?: boolean }) => Promise<void>>(async () => {})
  /** Texts from before a book-wide replace, so one click can revert the batch. */
  const replaceUndo = useRef<{ texts: Map<string, string> } | null>(null)
  const [editorMode, setEditorMode] = useState<EditorViewMode>(() => getSettings().defaultEditorMode)
  const [externalResetVersion, setExternalResetVersion] = useState(0)
  const wysiwygFlushRef = useRef<(() => void) | null>(null)
  const codePaneHandleRef = useRef<CodePaneHandle | null>(null)
  const structureHistoryRef = useRef<StructureHistoryEntry[]>([])
  const structureOpSeqRef = useRef(0)
  const [structureToast, setStructureToast] = useState<{ id: number; message: string; canUndo: boolean } | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [stylesheetTargets, setStylesheetTargets] = useState<string[] | null>(null)
  const [unusedDialogOpen, setUnusedDialogOpen] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [searchSeedQuery, setSearchSeedQuery] = useState('')
  const [agentProfiles, setAgentProfiles] = useState<AgentProfileDto[]>([])
  const [agentProfilesLoading, setAgentProfilesLoading] = useState(true)
  const [agentUserSettings, setAgentUserSettings] = useState<AgentUserSettingsDto | null>(null)
  const [selectionText, setSelectionText] = useState('')
  const agentUndoRef = useRef<{ messageId: string; snapshot: WorkspaceSnapshot } | null>(null)
  const [agentUndoMessageId, setAgentUndoMessageId] = useState<string | null>(null)
  // In-canvas Agent proposal review state & per-message skipped-hunk memory draft.
  // See ADR 2026-11-21-in-canvas-agent-proposal-review.
  const [activeReview, setActiveReview] = useState<ActiveProposalReview | null>(null)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [skippedHunksByMessage, setSkippedHunksByMessage] = useState<
    Record<string, Record<string, Set<string>>>
  >({})
  const skippedHunksRef = useRef(skippedHunksByMessage)
  skippedHunksRef.current = skippedHunksByMessage
  const [proposalStatusSync, setProposalStatusSync] = useState<ProposalStatusSyncEvent | null>(null)
  const [staleApplyConfirm, setStaleApplyConfirm] = useState<{
    messageId: string
    proposal: AgentProposal
    driftedPaths: string[]
  } | null>(null)
  const activeRef = useRef<string | null>(null)
  activeRef.current = active
  const textListeners = useRef(new Set<(path: string, value: string) => void>())

  const subscribeTextChange = useCallback((listener: (path: string, value: string) => void) => {
    textListeners.current.add(listener)
    return () => {
      textListeners.current.delete(listener)
    }
  }, [])

  useEffect(() => {
    if (!saving) {
      setShowSaving(false)
      return
    }
    const timer = window.setTimeout(() => setShowSaving(true), 150)
    return () => window.clearTimeout(timer)
  }, [saving])

  const applyBook = useCallback((loaded: LoadedBook) => {
    texts.current = new Map(loaded.texts)
    baselineRef.current = createSavedBaseline(loaded.texts, loaded.archive.entries)
    bookRef.current = loaded
    setBook(loaded)
    dirtyRef.current = new Set()
    setDirty(new Set())
    const first = loaded.groups.find((group) => group.group === 'Text')?.paths[0]
    const initial = first ?? loaded.groups[0]?.paths[0] ?? null
    setTabs(initial ? [initial] : [])
    setActive(initial)
    setActiveReview(null)
    setSkippedHunksByMessage({})
    setStaleApplyConfirm(null)
  }, [])

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    loadBook(bookId)
      .then(async (loaded) => {
        if (cancelled) return
        applyBook(loaded)
        setState({ status: 'ready' })

        const draft = await readDraft(bookId)
        if (cancelled || !draft) return
        const plan = planDraftRestore(draft, loaded.version, new Set(loaded.texts.keys()))
        if (plan.files.length === 0) {
          void clearDraft(bookId)
          return
        }
        setDraftPrompt(plan)
        setDraftSavedAt(draft.savedAt)
      })
      .catch((error) => {
        if (!cancelled) setState({ status: 'error', message: messageFor(error) })
      })
    return () => {
      cancelled = true
    }
  }, [bookId, applyBook])

  useEffect(() => {
    let cancelled = false
    setAgentProfilesLoading(true)
    Promise.all([
      api.agentProfiles().catch(() => ({ secretConfigured: true, profiles: [] as AgentProfileDto[] })),
      api.agentSettings().catch(() => null),
    ])
      .then(([profileRes, settingsRes]) => {
        if (cancelled) return
        setAgentProfiles(profileRes.profiles)
        if (settingsRes) setAgentUserSettings(settingsRes.settings)
      })
      .finally(() => {
        if (!cancelled) setAgentProfilesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [bookId])

  const open = useCallback((path: string) => {
    wysiwygFlushRef.current?.()
    setTabs((current) => (current.includes(path) ? current : [...current, path]))
    setActive(path)
  }, [])

  const selectTab = useCallback((path: string) => {
    wysiwygFlushRef.current?.()
    setActive(path)
  }, [])

  const switchMode = useCallback((nextMode: EditorViewMode) => {
    if (nextMode === 'code') wysiwygFlushRef.current?.()
    setEditorMode(nextMode)
  }, [])

  const close = useCallback((path: string) => {
    wysiwygFlushRef.current?.()
    setTabs((current) => {
      const next = current.filter((entry) => entry !== path)
      setActive((currentActive) => {
        if (currentActive !== path) return currentActive
        const index = current.indexOf(path)
        return next[Math.min(index, next.length - 1)] ?? null
      })
      return next
    })
  }, [])

  /** Local crash buffer: 1s after the last keystroke, the edited text files go to IndexedDB. */
  const scheduleDraft = useCallback(() => {
    if (draftTimer.current) clearTimeout(draftTimer.current)
    draftTimer.current = setTimeout(() => {
      draftTimer.current = null
      const current = bookRef.current
      if (!current) return
      const summary = computeDirtySummary(baselineRef.current, texts.current, current.archive.entries)
      const files: Record<string, string> = {}
      for (const path of summary.texts) {
        const text = texts.current.get(path)
        if (typeof text === 'string') files[path] = text
      }
      if (Object.keys(files).length === 0) {
        void clearDraft(current.id)
        return
      }
      void writeDraft(current.id, { baseVersion: current.version, savedAt: Date.now(), files })
    }, DRAFT_DEBOUNCE_MS)
  }, [])

  const syncDirtyFromBaseline = useCallback((targetBook?: LoadedBook | null): DirtySummary => {
    const current = targetBook ?? bookRef.current
    const summary = current
      ? computeDirtySummary(baselineRef.current, texts.current, current.archive.entries)
      : {
          all: new Set<string>(),
          texts: new Set<string>(),
          binaries: new Set<string>(),
          deleted: new Set<string>(),
        }
    dirtyRef.current = summary.all
    setDirty((prev) => (setsEqual(prev, summary.all) ? prev : summary.all))
    return summary
  }, [])

  const syncDurability = useCallback(
    (summary: DirtySummary) => {
      // Clear local draft and cancel autosave when edits are undone back to the saved baseline so
      // reverted files never leave ghost drafts or trigger no-op uploads.
      // See ADR 2026-11-20-baseline-derived-dirty-state.
      if (summary.texts.size === 0) {
        if (draftTimer.current) {
          clearTimeout(draftTimer.current)
          draftTimer.current = null
        }
        const current = bookRef.current
        if (current) void clearDraft(current.id)
      } else {
        scheduleDraft()
      }
      if (summary.all.size === 0) autosave.current?.cancel()
      else autosave.current?.touch()
    },
    [scheduleDraft],
  )

  const handleChange = useCallback(
    (path: string, value: string, options: { rerender?: boolean } = {}) => {
      texts.current.set(path, value)
      for (const listener of textListeners.current) listener(path, value)
      const summary = syncDirtyFromBaseline()
      // Typing needs no rerender (the editor owns its document), but a form write into a file that
      // is already dirty does: without this the toc/meta panels keep showing the previous parse.
      if (options.rerender) setRevision((rev) => rev + 1)
      if (agentUndoRef.current) {
        agentUndoRef.current = null
        setAgentUndoMessageId(null)
      }
      syncDurability(summary)
    },
    [syncDirtyFromBaseline, syncDurability],
  )

  const openProposalReview = useCallback(
    (args: {
      messageId: string
      proposal: AgentProposal
      path?: string
      readOnly?: boolean
      autoDowngradeReason?: string | null
    }) => {
      const targetPath =
        (args.path && args.proposal.files.some((f) => f.path === args.path) ? args.path : null) ??
        args.proposal.files[0]?.path
      if (!targetPath) return
      setActiveReview({
        messageId: args.messageId,
        proposal: args.proposal,
        selectedPath: targetPath,
        readOnly: Boolean(args.readOnly),
        autoDowngradeReason: args.autoDowngradeReason ?? null,
      })
    },
    [],
  )

  const closeProposalReview = useCallback((messageId?: string) => {
    setActiveReview((current) => {
      if (!current) return null
      if (messageId && current.messageId !== messageId) return current
      return null
    })
  }, [])

  const toggleReviewHunk = useCallback((messageId: string, path: string, hunkId: string) => {
    setSkippedHunksByMessage((prev) => {
      const msgMap = prev[messageId] ?? {}
      const existing = msgMap[path] ?? new Set<string>()
      const nextSet = new Set(existing)
      if (nextSet.has(hunkId)) nextSet.delete(hunkId)
      else nextSet.add(hunkId)
      const nextMsgMap = { ...msgMap }
      if (nextSet.size === 0) delete nextMsgMap[path]
      else nextMsgMap[path] = nextSet
      return { ...prev, [messageId]: nextMsgMap }
    })
  }, [])

  const resetReviewFileHunks = useCallback((messageId: string, path: string) => {
    setSkippedHunksByMessage((prev) => {
      const msgMap = prev[messageId]
      if (!msgMap || !(path in msgMap)) return prev
      const nextMsgMap = { ...msgMap }
      delete nextMsgMap[path]
      return { ...prev, [messageId]: nextMsgMap }
    })
  }, [])

  const clearReviewDraftForMessage = useCallback((messageId: string) => {
    setSkippedHunksByMessage((prev) => {
      if (!(messageId in prev)) return prev
      const next = { ...prev }
      delete next[messageId]
      return next
    })
  }, [])

  const handleApplyAgentProposal = useCallback(
    async (
      messageId: string,
      proposal: AgentProposal,
      options?: { forceApplyStale?: boolean; rawAutoApply?: boolean },
    ): Promise<boolean> => {
      wysiwygFlushRef.current?.()
      const current = bookRef.current
      if (!current) return false

      let selectedPaths: Set<string> | undefined
      let composedTexts: Map<string, string> | undefined

      if (!options?.rawAutoApply && !proposal.isStructural) {
        const msgSkipped = skippedHunksRef.current[messageId] ?? {}
        const models = new Map<string, FileDiffModel>()
        for (const file of proposal.files) models.set(file.path, buildFileHunks(file))
        const plan = buildComposedProposalPlan(proposal, models, msgSkipped)
        const xmlFailures = validateComposedProposal(proposal, plan)
        if (xmlFailures.length > 0) {
          setSaveError(xmlFailures[0]!.message)
          openProposalReview({ messageId, proposal, path: xmlFailures[0]!.path, readOnly: false })
          return false
        }
        selectedPaths = plan.selectedPaths
        composedTexts = plan.composedTexts
        if (selectedPaths.size === 0) return false
      }

      if (!options?.rawAutoApply && !options?.forceApplyStale) {
        const drifted = detectProposalStaleness(proposal, texts.current)
        if (drifted.length > 0) {
          setStaleApplyConfirm({ messageId, proposal, driftedPaths: drifted })
          return false
        }
      }

      setReviewBusy(true)
      try {
        const snapshot = createUndoSnapshot({
          book: current,
          texts: texts.current,
          dirty: dirtyRef.current,
          tabs: tabsRef.current,
          active: activeRef.current,
        })
        const applied = applyProposalToBook({
          book: current,
          texts: texts.current,
          dirty: dirtyRef.current,
          tabs: tabsRef.current,
          active: activeRef.current,
          proposal,
          selectedPaths,
          composedTexts,
        })
        if (applied.appliedCount === 0) return false

        agentUndoRef.current = { messageId, snapshot }
        setAgentUndoMessageId(messageId)

        texts.current = applied.texts
        bookRef.current = applied.book
        setBook(applied.book)
        setTabs(applied.tabs)
        setActive(applied.active)
        setExternalResetVersion((v) => v + 1)
        setRevision((v) => v + 1)
        const summary = syncDirtyFromBaseline(applied.book)
        syncDurability(summary)

        clearReviewDraftForMessage(messageId)
        closeProposalReview(messageId)
        setProposalStatusSync({ messageId, status: 'applied', seq: Date.now() })

        await api.updateProposalStatus(current.id, messageId, 'applied').catch(() => {})
        return true
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : '应用变更提案失败')
        return false
      } finally {
        setReviewBusy(false)
      }
    },
    [
      clearReviewDraftForMessage,
      closeProposalReview,
      openProposalReview,
      syncDirtyFromBaseline,
      syncDurability,
    ],
  )

  const handleDismissAgentProposal = useCallback(
    async (messageId: string): Promise<boolean> => {
      const current = bookRef.current
      if (!current) return false
      setReviewBusy(true)
      try {
        await api.updateProposalStatus(current.id, messageId, 'dismissed')
        clearReviewDraftForMessage(messageId)
        closeProposalReview(messageId)
        setProposalStatusSync({ messageId, status: 'dismissed', seq: Date.now() })
        return true
      } catch {
        setSaveError('更新提案状态失败，请重试。')
        return false
      } finally {
        setReviewBusy(false)
      }
    },
    [clearReviewDraftForMessage, closeProposalReview],
  )

  const reviewMarks = useMemo(() => {
    if (!activeReview || activeReview.readOnly) return undefined
    const marks = new Map<string, AgentProposalFile['kind']>()
    for (const file of activeReview.proposal.files) {
      marks.set(file.path, file.kind)
      if (file.kind === 'rename' && file.previousPath) {
        marks.set(file.previousPath, 'rename')
      }
    }
    return marks
  }, [activeReview])

  const handleUndoAgentProposal = useCallback(
    (messageId: string) => {
      const saved = agentUndoRef.current
      if (!saved || saved.messageId !== messageId) return
      const { snapshot } = saved
      texts.current = new Map(snapshot.texts)
      bookRef.current = snapshot.book
      setBook(snapshot.book)
      setTabs([...snapshot.tabs])
      setActive(snapshot.active)
      setExternalResetVersion((v) => v + 1)
      setRevision((v) => v + 1)
      agentUndoRef.current = null
      setAgentUndoMessageId(null)
      const summary = syncDirtyFromBaseline(snapshot.book)
      syncDurability(summary)
    },
    [syncDirtyFromBaseline, syncDurability],
  )

  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

  const applyReplace = useCallback(
    (plan: ReplacePlan) => {
      if (!bookRef.current) return
      replaceUndo.current = {
        texts: new Map(plan.files.map((file) => [file.path, texts.current.get(file.path) ?? ''])),
      }
      const nextTexts = new Map(texts.current)
      for (const file of plan.files) nextTexts.set(file.path, file.text)
      texts.current = nextTexts
      setExternalResetVersion((v) => v + 1)
      const summary = syncDirtyFromBaseline()
      syncDurability(summary)
    },
    [syncDirtyFromBaseline, syncDurability],
  )

  const undoReplace = useCallback(() => {
    const snapshot = replaceUndo.current
    if (!snapshot || !bookRef.current) return
    const nextTexts = new Map(texts.current)
    for (const [path, text] of snapshot.texts) nextTexts.set(path, text)
    texts.current = nextTexts
    replaceUndo.current = null
    setExternalResetVersion((v) => v + 1)
    const summary = syncDirtyFromBaseline()
    syncDurability(summary)
  }, [syncDirtyFromBaseline, syncDurability])

  const showToast = useCallback((message: string, canUndo: boolean) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    const id = Date.now() + Math.random()
    setStructureToast({ id, message, canUndo })
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null
      setStructureToast((cur) => (cur?.id === id ? null : cur))
    }, 8000)
  }, [])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    }
  }, [])

  const pushStructureUndo = useCallback((label: string, current: LoadedBook) => {
    const snapshot = createUndoSnapshot({
      book: current,
      texts: texts.current,
      dirty: dirtyRef.current,
      tabs: tabsRef.current,
      active: activeRef.current,
    })
    structureOpSeqRef.current += 1
    structureHistoryRef.current = pushStructureHistory(structureHistoryRef.current, {
      id: structureOpSeqRef.current,
      label,
      snapshot,
    })
  }, [])

  const applyStructureMutation = useCallback(
    (
      label: string,
      nextBook: LoadedBook,
      nextFiles: Map<string, string>,
      options: { nextTabs?: string[]; nextActive?: string | null } = {},
    ) => {
      texts.current = nextFiles
      bookRef.current = nextBook
      setBook(nextBook)
      if (options.nextTabs) setTabs(options.nextTabs)
      if (options.nextActive !== undefined) setActive(options.nextActive)
      setExternalResetVersion((v) => v + 1)
      setRevision((v) => v + 1)
      setSaveError(null)
      const summary = syncDirtyFromBaseline(nextBook)
      syncDurability(summary)
      showToast(label, true)
    },
    [showToast, syncDirtyFromBaseline, syncDurability],
  )

  const undoStructure = useCallback(() => {
    const { entry, rest } = popStructureHistory(structureHistoryRef.current)
    if (!entry) return
    structureHistoryRef.current = rest
    const { snapshot } = entry
    texts.current = new Map(snapshot.texts)
    bookRef.current = snapshot.book
    setBook(snapshot.book)
    setTabs([...snapshot.tabs])
    setActive(snapshot.active)
    setExternalResetVersion((v) => v + 1)
    setRevision((v) => v + 1)
    setSaveError(null)
    const summary = syncDirtyFromBaseline(snapshot.book)
    syncDurability(summary)
    showToast(`已撤销：${entry.label}`, rest.length > 0)
  }, [showToast, syncDirtyFromBaseline, syncDurability])

  const handleSplitAtCursor = useCallback(
    (offset: number, preSyncedXhtml?: string) => {
      const current = bookRef.current
      const path = activeRef.current
      if (!current || !path) return
      const workingFiles = new Map(texts.current)
      if (preSyncedXhtml !== undefined) {
        workingFiles.set(path, preSyncedXhtml)
      }
      try {
        const result = splitChapterInBook({
          files: workingFiles,
          pkg: current.pkg,
          archive: current.archive,
          path,
          offset,
          codec: browserXmlCodec,
        })
        const created = result.createdPaths[0]
        const label = created ? `已拆分为 ${basename(created)}` : '已拆分章节'
        pushStructureUndo(label, current)
        const nextBook = reconcileBookAfterStructure(current, result.files, result.archive, result.pkg)
        const curTabs = tabsRef.current
        const idx = curTabs.indexOf(path)
        const nextTabs = created
          ? idx >= 0
            ? [...curTabs.slice(0, idx + 1), created, ...curTabs.slice(idx + 1).filter((t) => t !== created)]
            : [...curTabs, created]
          : curTabs
        applyStructureMutation(label, nextBook, result.files, {
          nextTabs,
          nextActive: created ?? path,
        })
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : '在光标处拆分章节失败')
      }
    },
    [applyStructureMutation, pushStructureUndo],
  )

  const handleInsertSplitMarker = useCallback(() => {
    const path = activeRef.current
    if (!path || !isPreviewable(path)) return
    codePaneHandleRef.current?.insertAtCursor(`\n${SPLIT_MARKER_HTML}\n`)
  }, [])

  const handleFormatDocument = useCallback(() => {
    const path = activeRef.current
    if (!path) return
    const kind = codeFileKindOf(path)
    if (kind === 'other') return
    const currentText = texts.current.get(path)
    if (currentText === undefined) return
    try {
      const formatted = kind === 'css' ? formatCss(currentText) : formatXhtml(currentText, browserXmlCodec)
      if (formatted === currentText) {
        showToast('当前文件已是规范格式', false)
        return
      }
      setSaveError(null)
      codePaneHandleRef.current?.replaceDocAsTransaction(formatted)
      showToast(`已格式化 ${basename(path)}（${formatShortcut('Mod+Z')} 可撤回）`, false)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '格式化失败')
    }
  }, [showToast])

  const handleSplitAtMarkers = useCallback(
    (path: string) => {
      wysiwygFlushRef.current?.()
      const current = bookRef.current
      if (!current) return
      try {
        const result = splitChapterAtMarkersInBook({
          files: texts.current,
          pkg: current.pkg,
          archive: current.archive,
          path,
          codec: browserXmlCodec,
        })
        const label = `已按标记拆出 ${result.createdPaths.length} 个章节`
        pushStructureUndo(label, current)
        const nextBook = reconcileBookAfterStructure(current, result.files, result.archive, result.pkg)
        const curTabs = tabsRef.current
        const idx = curTabs.indexOf(path)
        const additions = result.createdPaths.filter((p) => !curTabs.includes(p))
        const nextTabs =
          idx >= 0 ? [...curTabs.slice(0, idx + 1), ...additions, ...curTabs.slice(idx + 1)] : [...curTabs, ...additions]
        applyStructureMutation(label, nextBook, result.files, {
          nextTabs,
          nextActive: result.createdPaths[0] ?? path,
        })
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : '按拆分标记拆章失败')
      }
    },
    [applyStructureMutation, pushStructureUndo],
  )

  const handleMergeChapters = useCallback(
    (paths: string[]) => {
      wysiwygFlushRef.current?.()
      const current = bookRef.current
      if (!current || paths.length < 2) return
      const spine = spinePaths(current.pkg)
      const ordered = [...paths].sort((a, b) => {
        const ai = spine.indexOf(a)
        const bi = spine.indexOf(b)
        if (ai < 0 && bi < 0) return a.localeCompare(b, 'en')
        if (ai < 0) return 1
        if (bi < 0) return -1
        return ai - bi
      })
      try {
        const result = mergeChaptersInBook({
          files: texts.current,
          pkg: current.pkg,
          archive: current.archive,
          paths: ordered,
          codec: browserXmlCodec,
        })
        const label = `已合并 ${result.removedPaths.length + 1} 章至 ${basename(result.primaryPath)}`
        pushStructureUndo(label, current)
        const nextBook = reconcileBookAfterStructure(current, result.files, result.archive, result.pkg)
        const removedSet = new Set(result.removedPaths)
        const filteredTabs = tabsRef.current.filter((t) => !removedSet.has(t))
        const nextTabs = filteredTabs.includes(result.primaryPath)
          ? filteredTabs
          : [...filteredTabs, result.primaryPath]
        applyStructureMutation(label, nextBook, result.files, {
          nextTabs,
          nextActive: result.primaryPath,
        })
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : '合并章节失败')
      }
    },
    [applyStructureMutation, pushStructureUndo],
  )

  const handleMergeWithPrevious = useCallback(
    (path: string) => {
      const current = bookRef.current
      if (!current) return
      const spine = spinePaths(current.pkg)
      const idx = spine.indexOf(path)
      if (idx <= 0) return
      const previous = spine[idx - 1]
      if (!previous) return
      handleMergeChapters([previous, path])
    },
    [handleMergeChapters],
  )

  const handleDuplicateChapter = useCallback(
    (path: string) => {
      wysiwygFlushRef.current?.()
      const current = bookRef.current
      if (!current) return
      try {
        const result = duplicateChapterInBook({
          files: texts.current,
          pkg: current.pkg,
          archive: current.archive,
          path,
          codec: browserXmlCodec,
        })
        const label = `已复制章节 ${basename(result.createdPath)}`
        pushStructureUndo(label, current)
        const nextBook = reconcileBookAfterStructure(current, result.files, result.archive, result.pkg)
        const curTabs = tabsRef.current
        const nextTabs = curTabs.includes(result.createdPath) ? curTabs : [...curTabs, result.createdPath]
        applyStructureMutation(label, nextBook, result.files, {
          nextTabs,
          nextActive: result.createdPath,
        })
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : '复制章节失败')
      }
    },
    [applyStructureMutation, pushStructureUndo],
  )

  const handleCreateStylesheet = useCallback(
    (filename?: string, openTab = true): { path: string } | { error: string } => {
      const current = bookRef.current
      if (!current) return { error: '书籍尚未就绪' }
      try {
        const result = createBlankStylesheet({
          files: texts.current,
          pkg: current.pkg,
          archive: current.archive,
          filename,
          codec: browserXmlCodec,
        })
        const label = `已新建样式表 ${basename(result.createdPath)}`
        pushStructureUndo(label, current)
        const nextBook = reconcileBookAfterStructure(current, result.files, result.archive, result.pkg)
        const curTabs = tabsRef.current
        const nextTabs = openTab
          ? curTabs.includes(result.createdPath)
            ? curTabs
            : [...curTabs, result.createdPath]
          : curTabs
        applyStructureMutation(label, nextBook, result.files, {
          nextTabs,
          ...(openTab ? { nextActive: result.createdPath } : {}),
        })
        return { path: result.createdPath }
      } catch (error) {
        return { error: error instanceof Error ? error.message : '新建样式表失败' }
      }
    },
    [applyStructureMutation, pushStructureUndo],
  )

  const handleApplyStylesheets = useCallback(
    (chapterPaths: string[], delta: { add: string[]; remove: string[] }) => {
      wysiwygFlushRef.current?.()
      const current = bookRef.current
      if (!current) return
      const result = updateChaptersStylesheets(texts.current, chapterPaths, {
        add: delta.add,
        remove: delta.remove,
      })
      if (result.changedPaths.length === 0) return
      const label = `已更新 ${result.changedPaths.length} 个章节的样式表`
      pushStructureUndo(label, current)
      const nextEntries = new Map(current.archive.entries)
      for (const changed of result.changedPaths) {
        const text = result.files.get(changed)
        if (text !== undefined) nextEntries.set(changed, encoder.encode(text))
      }
      const nextArchive: EpubArchive = { order: [...current.archive.order], entries: nextEntries }
      const nextBook = reconcileBookAfterStructure(current, result.files, nextArchive, current.pkg)
      applyStructureMutation(label, nextBook, result.files)
    },
    [applyStructureMutation, pushStructureUndo],
  )

  const handleCleanupUnusedResources = useCallback(
    (paths: string[]) => {
      const current = bookRef.current
      if (!current || paths.length === 0) return
      const result = deleteUnusedResourcesInBook({
        files: texts.current,
        pkg: current.pkg,
        archive: current.archive,
        paths,
        codec: browserXmlCodec,
      })
      if (result.removedPaths.length === 0) return
      const label = `已清理 ${result.removedPaths.length} 个未引用资源`
      pushStructureUndo(label, current)
      const nextBook = reconcileBookAfterStructure(current, result.files, result.archive, result.pkg)
      const removedSet = new Set(result.removedPaths)
      const nextTabs = tabsRef.current.filter((t) => !removedSet.has(t))
      const fallback = spinePaths(nextBook.pkg)[0] ?? nextBook.groups[0]?.paths[0] ?? null
      const nextActive = activeRef.current && removedSet.has(activeRef.current) ? fallback : activeRef.current
      applyStructureMutation(label, nextBook, result.files, { nextTabs, nextActive })
    },
    [applyStructureMutation, pushStructureUndo],
  )

  const createDocument = useCallback(() => {
    const current = bookRef.current
    if (!current) return
    const dir = chapterDirectory(current)
    const name = nextChapterName(current, dir)
    const path = `${dir}/${name}`
    const opfPath = current.pkg.opfPath
    const skeleton = chapterSkeleton(name, current.pkg.metadata.language || 'zh-CN')

    let nextOpf: string
    try {
      nextOpf = addSpineDocument(
        texts.current.get(opfPath) ?? '',
        {
          id: name.replace(/\.xhtml$/, ''),
          href: relativePath(dirname(opfPath), path),
          mediaType: 'application/xhtml+xml',
        },
        browserXmlCodec,
      )
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '无法新增章节')
      return
    }

    const nextTexts = new Map(texts.current)
    nextTexts.set(opfPath, nextOpf)
    nextTexts.set(path, skeleton)
    const encoded = encoder.encode(skeleton)
    const entries = new Map(current.archive.entries)
    entries.set(path, encoded)
    const entryMeta = new Map(current.entryMeta)
    entryMeta.set(path, {
      path,
      isText: true,
      mediaType: 'application/xhtml+xml',
      byteSize: encoded.byteLength,
      sha256: null,
    })

    const next = { ...refreshPackage(current, nextTexts, entries), entryMeta }
    texts.current = nextTexts
    bookRef.current = next
    setBook(next)
    open(path)
    const summary = syncDirtyFromBaseline(next)
    syncDurability(summary)
  }, [open, syncDirtyFromBaseline, syncDurability])

  const startRename = useCallback((path: string) => {
    setRenaming({ path, value: basename(path), error: null })
  }, [])

  const confirmRename = useCallback(() => {
    const current = bookRef.current
    if (!current || !renaming) return
    const name = renaming.value.trim()
    if (!name || name.includes('/') || name.includes('\\')) {
      setRenaming({ ...renaming, error: '文件名不能为空，也不能包含斜杠' })
      return
    }

    const path = renaming.path
    const target = `${dirname(path)}/${name}`
    if (target === path) {
      setRenaming(null)
      return
    }
    if (current.archive.entries.has(target)) {
      setRenaming({ ...renaming, error: '这个路径已经有文件了' })
      return
    }

    const opfPath = current.pkg.opfPath
    const baseDir = dirname(opfPath)
    const files = new Map(texts.current)
    let nextOpf: string
    try {
      nextOpf = renameManifestEntry(
        files.get(opfPath) ?? '',
        path,
        relativePath(baseDir, target),
        baseDir,
        browserXmlCodec,
      )
    } catch {
      setRenaming({ ...renaming, error: '这个条目不在 manifest 里，无法重命名' })
      return
    }
    files.set(opfPath, nextOpf)
    // Renaming without rewriting href/src leaves every chapter pointing at a file that is gone.
    // See ADR 2026-11-19-file-structure-editing.
    const rewritten = rewriteReferences(files, new Map([[path, target]]))

    const entries = new Map(current.archive.entries)
    const bytes = entries.get(path)
    if (bytes) {
      entries.delete(path)
      entries.set(target, bytes)
    }

    const entryMeta = new Map(current.entryMeta)
    const prevMeta = entryMeta.get(path)
    if (prevMeta) {
      entryMeta.delete(path)
      entryMeta.set(target, { ...prevMeta, path: target })
    }

    const entryOrigins = new Map(current.entryOrigins)
    const prevOrigin = entryOrigins.get(path)
    entryOrigins.delete(path)
    if (prevOrigin) entryOrigins.set(target, prevOrigin)

    const localBinaries = new Map(current.localBinaries)
    const prevLocalBin = localBinaries.get(path)
    if (prevLocalBin) {
      localBinaries.delete(path)
      localBinaries.set(target, prevLocalBin)
    }

    const nextTexts = new Map(rewritten.files)
    const moved = nextTexts.get(path)
    nextTexts.delete(path)
    if (moved !== undefined) nextTexts.set(target, moved)

    const refreshed = refreshPackage(current, nextTexts, entries)
    const next = { ...refreshed, entryMeta, entryOrigins, localBinaries }
    texts.current = nextTexts
    bookRef.current = next
    setBook(next)
    setTabs((list) => list.map((entry) => (entry === path ? target : entry)))
    setActive((activePath) => (activePath === path ? target : activePath))
    setExternalResetVersion((v) => v + 1)
    setRenaming(null)
    const summary = syncDirtyFromBaseline(next)
    syncDurability(summary)
  }, [renaming, syncDirtyFromBaseline, syncDurability])

  const requestDelete = useCallback((path: string) => {
    const files = texts.current
    const references = collectReferences(files)
      .filter((reference) => reference.targetPath === path)
      .map((reference) => ({
        from: reference.from,
        line: lineOf(files.get(reference.from) ?? '', reference.offset),
      }))
    setDeleting({ path, references })
  }, [])

  const confirmDelete = useCallback(() => {
    const current = bookRef.current
    if (!current || !deleting) return
    const path = deleting.path
    const opfPath = current.pkg.opfPath
    const nextTexts = new Map(texts.current)

    try {
      nextTexts.set(
        opfPath,
        removeManifestEntry(nextTexts.get(opfPath) ?? '', path, dirname(opfPath), browserXmlCodec),
      )
    } catch {
      setDeleting(null)
      return
    }

    const { navPath, ncxPath } = current.pkg
    if (navPath) {
      const navXml = nextTexts.get(navPath)
      if (navXml) {
        try {
          const pruned = pruneToc(readNavToc(navXml, browserXmlCodec), navPath, path)
          if (pruned.changed) nextTexts.set(navPath, writeNavToc(navXml, pruned.entries, browserXmlCodec))
        } catch {
          // An unreadable nav is left as it is; the check panel reports it.
        }
      }
    }
    if (ncxPath) {
      const ncxXml = nextTexts.get(ncxPath)
      if (ncxXml) {
        try {
          const pruned = pruneToc(readNcxToc(ncxXml, browserXmlCodec), ncxPath, path)
          if (pruned.changed) nextTexts.set(ncxPath, writeNcxToc(ncxXml, pruned.entries, browserXmlCodec))
        } catch {
          // Same as above.
        }
      }
    }

    const entries = new Map(current.archive.entries)
    entries.delete(path)
    nextTexts.delete(path)

    const entryMeta = new Map(current.entryMeta)
    entryMeta.delete(path)
    const entryOrigins = new Map(current.entryOrigins)
    entryOrigins.delete(path)
    const localBinaries = new Map(current.localBinaries)
    localBinaries.delete(path)

    const next = { ...refreshPackage(current, nextTexts, entries), entryMeta, entryOrigins, localBinaries }
    texts.current = nextTexts
    bookRef.current = next
    setBook(next)
    const fallback = spinePaths(next.pkg)[0] ?? next.groups[0]?.paths[0] ?? null
    setTabs((list) => list.filter((entry) => entry !== path))
    setActive((activePath) => (activePath === path ? fallback : activePath))
    setExternalResetVersion((v) => v + 1)
    setDeleting(null)
    const summary = syncDirtyFromBaseline(next)
    syncDurability(summary)
  }, [deleting, syncDirtyFromBaseline, syncDurability])

  const moveSpine = useCallback(
    (path: string, delta: -1 | 1) => {
      const current = bookRef.current
      if (!current) return
      const order = spinePaths(current.pkg)
      const index = order.indexOf(path)
      const to = index + delta
      const moved = order[index]
      const swapped = order[to]
      if (index < 0 || !moved || !swapped) return

      const nextOrder = [...order]
      nextOrder[index] = swapped
      nextOrder[to] = moved
      const opfPath = current.pkg.opfPath
      let nextOpf: string
      try {
        nextOpf = reorderSpine(texts.current.get(opfPath) ?? '', nextOrder, dirname(opfPath), browserXmlCodec)
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : '无法调整阅读顺序')
        return
      }

      const nextTexts = new Map(texts.current)
      nextTexts.set(opfPath, nextOpf)
      const next = refreshPackage(current, nextTexts, current.archive.entries)
      texts.current = nextTexts
      bookRef.current = next
      setBook(next)
      const summary = syncDirtyFromBaseline(next)
      syncDurability(summary)
    },
    [syncDirtyFromBaseline, syncDurability],
  )

  const navigateTo = useCallback(
    (target: NavigateTarget) => {
      const text = texts.current.get(target.path)
      if (text === undefined) return
      open(target.path)
      const key = Date.now()
      setRevealFragment({ path: target.path, fragment: target.fragment, key })
      if (!target.fragment) {
        setReveal({ line: 1, column: 1, key })
        return
      }
      const index = fragmentIndex(text, target.fragment)
      if (index < 0) return
      setReveal({
        line: lineOf(text, index),
        column: index - text.lastIndexOf('\n', index - 1),
        key,
      })
    },
    [open],
  )

  const syncTocHistoryFlags = useCallback(() => {
    setTocHistoryState({
      canUndo: tocUndoStack.current.length > 0,
      canRedo: tocRedoStack.current.length > 0,
    })
  }, [])

  const applyTocMutation = useCallback(
    (nextEntries: TocEntry[], extraChapters?: Map<string, string>) => {
      const current = bookRef.current
      if (!current) return
      const { navPath, ncxPath } = current.pkg
      const primaryTocPath = navPath ?? ncxPath
      if (!primaryTocPath) return

      const updates = new Map<string, string>()
      if (extraChapters) {
        for (const [chapterPath, chapterXml] of extraChapters) {
          updates.set(chapterPath, chapterXml)
        }
      }
      if (navPath) {
        const navXml = texts.current.get(navPath)
        if (navXml) updates.set(navPath, writeNavToc(navXml, nextEntries, browserXmlCodec))
      }
      if (ncxPath) {
        const ncxXml = texts.current.get(ncxPath)
        if (ncxXml) {
          const rebased = rebaseTocHrefs(nextEntries, primaryTocPath, ncxPath)
          updates.set(ncxPath, writeNcxToc(ncxXml, rebased, browserXmlCodec))
        }
      }
      if (updates.size === 0) return

      // Record per-path before/after snapshots (up to 50 steps) so TOC edits and auto-injected
      // heading ids undo atomically; dirty flags derive from the saved baseline.
      // See ADR 2026-11-20-toc-workbench-enhancements.
      const beforeTexts = new Map<string, string | undefined>()
      const afterTexts = new Map<string, string | undefined>()
      let activeModified = false

      for (const [filePath, nextXml] of updates) {
        beforeTexts.set(filePath, texts.current.get(filePath))
        afterTexts.set(filePath, nextXml)
        texts.current.set(filePath, nextXml)
        if (filePath === activeRef.current) activeModified = true
        for (const listener of textListeners.current) listener(filePath, nextXml)
      }

      tocUndoStack.current.push({ beforeTexts, afterTexts })
      if (tocUndoStack.current.length > 50) tocUndoStack.current.shift()
      tocRedoStack.current = []
      syncTocHistoryFlags()

      setRevision((rev) => rev + 1)
      if (activeModified || (extraChapters && extraChapters.size > 0)) {
        setExternalResetVersion((v) => v + 1)
      }
      const summary = syncDirtyFromBaseline()
      syncDurability(summary)
    },
    [syncDirtyFromBaseline, syncDurability, syncTocHistoryFlags],
  )

  const restoreTocSnapshot = useCallback(
    (snapshotTexts: Map<string, string | undefined>) => {
      let touchedOpen = false
      for (const [filePath, value] of snapshotTexts) {
        if (value === undefined) texts.current.delete(filePath)
        else texts.current.set(filePath, value)
        if (filePath === activeRef.current || tabsRef.current.includes(filePath)) touchedOpen = true
        if (value !== undefined) {
          for (const listener of textListeners.current) listener(filePath, value)
        }
      }
      setRevision((rev) => rev + 1)
      if (touchedOpen) setExternalResetVersion((v) => v + 1)
      const summary = syncDirtyFromBaseline()
      syncDurability(summary)
    },
    [syncDirtyFromBaseline, syncDurability],
  )

  const undoToc = useCallback(() => {
    const entry = tocUndoStack.current.pop()
    if (!entry) return
    tocRedoStack.current.push(entry)
    restoreTocSnapshot(entry.beforeTexts)
    syncTocHistoryFlags()
  }, [restoreTocSnapshot, syncTocHistoryFlags])

  const redoToc = useCallback(() => {
    const entry = tocRedoStack.current.pop()
    if (!entry) return
    tocUndoStack.current.push(entry)
    restoreTocSnapshot(entry.afterTexts)
    syncTocHistoryFlags()
  }, [restoreTocSnapshot, syncTocHistoryFlags])

  const initializeToc = useCallback(() => {
    const current = bookRef.current
    if (!current) return
    try {
      const init = initializeBookToc(current.pkg, texts.current, browserXmlCodec)
      if (!init.created) return
      const nextTexts = new Map(texts.current)
      nextTexts.set(current.pkg.opfPath, init.opfXml)
      nextTexts.set(init.tocPath, init.tocContent)
      const entries = new Map(current.archive.entries)
      const tocEncoded = encoder.encode(init.tocContent)
      entries.set(init.tocPath, tocEncoded)
      entries.set(current.pkg.opfPath, encoder.encode(init.opfXml))
      const entryMeta = new Map(current.entryMeta)
      entryMeta.set(init.tocPath, {
        path: init.tocPath,
        isText: true,
        mediaType: init.tocPath.endsWith('.ncx') ? 'application/x-dtbncx+xml' : 'application/xhtml+xml',
        byteSize: tocEncoded.byteLength,
        sha256: null,
      })
      const next = { ...refreshPackage(current, nextTexts, entries), entryMeta }
      texts.current = nextTexts
      bookRef.current = next
      setBook(next)
      tocUndoStack.current = []
      tocRedoStack.current = []
      syncTocHistoryFlags()
      const summary = syncDirtyFromBaseline(next)
      syncDurability(summary)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '无法初始化目录文件')
    }
  }, [syncDirtyFromBaseline, syncDurability, syncTocHistoryFlags])

  const navigateTocHref = useCallback(
    (href: string) => {
      const current = bookRef.current
      const currentTocPath = current?.pkg.navPath ?? current?.pkg.ncxPath ?? null
      if (!currentTocPath || !href) return
      const { path, fragment } = splitFragment(href)
      if (!path) return
      const resolved = resolvePath(dirname(currentTocPath), path)
      setActiveTocHref(href)
      navigateTo({ path: resolved, fragment })
    },
    [navigateTo],
  )

  const reload = useCallback(async () => {
    try {
      const loaded = await loadBook(bookId)
      const previousTabs = tabs
      const previousActive = active
      texts.current = new Map(loaded.texts)
      baselineRef.current = createSavedBaseline(loaded.texts, loaded.archive.entries)
      bookRef.current = loaded
      setBook(loaded)
      setDirty(new Set())
      dirtyRef.current = new Set()
      tocUndoStack.current = []
      tocRedoStack.current = []
      setTocHistoryState({ canUndo: false, canRedo: false })
      setActiveTocHref(null)
      setExternalResetVersion((v) => v + 1)
      conflictRef.current = false
      setConflict(false)
      setSaveError(null)
      setSaveState('idle')
      setSavedAt(null)
      setDraftPrompt(null)
      void clearDraft(bookId)
      const kept = previousTabs.filter((path) => loaded.archive.entries.has(path))
      setTabs(kept)
      setActive(kept.includes(previousActive ?? '') ? previousActive : (kept[0] ?? null))
    } catch (error) {
      setSaveError(messageFor(error))
    }
  }, [bookId, tabs, active])

  const save = useCallback(
    async (options: { checkpoint?: boolean } = {}) => {
      wysiwygFlushRef.current?.()
      const currentBook = bookRef.current
      // Conflict is terminal until the user reloads: retrying would only produce the same 409.
      if (!currentBook || savingRef.current || conflictRef.current) return
      const summary = syncDirtyFromBaseline(currentBook)
      if (summary.all.size === 0) return
      savingRef.current = true
      setSaving(true)
      setSaveState('saving')
      setSaveError(null)
      try {
        // `dcterms:modified` tracks the package document itself, not every keystroke or binary-only
        // swap: refresh it only when the OPF text actually differs from the saved baseline.
        // See ADR 2026-11-19-opf-meta-editing and ADR 2026-11-20-baseline-derived-dirty-state.
        const opfPath = currentBook.pkg.opfPath
        const uploadedTexts = new Map(texts.current)
        if (summary.texts.has(opfPath)) {
          const opfText = uploadedTexts.get(opfPath)
          if (opfText !== undefined) {
            const touched = touchOpfModified(
              opfText,
              new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
              browserXmlCodec,
            )
            if (touched !== opfText) {
              uploadedTexts.set(opfPath, touched)
              texts.current.set(opfPath, touched)
              for (const listener of textListeners.current) listener(opfPath, touched)
            }
          }
        }

        const delta = buildEntryDelta({ book: currentBook, texts: uploadedTexts, dirty: summary.texts })
        if (!delta.hasChanges) {
          syncDirtyFromBaseline(currentBook)
          setSaveState('idle')
          return
        }

        const result = await api.saveEntries(currentBook.id, currentBook.version, delta, options)
        const uploadedSavedBook = applySavedEntriesToBook(currentBook, result.version, result.entries, uploadedTexts)

        // Advance the saved baseline only to the exact snapshot uploaded above, then recompute
        // dirty against the live workspace so edits typed while the save was in flight survive.
        // See ADR 2026-11-20-baseline-derived-dirty-state and ADR 2026-11-20-entry-level-book-storage.
        baselineRef.current = createSavedBaseline(uploadedTexts, uploadedSavedBook.archive.entries)

        const latestBook = bookRef.current ?? currentBook
        const next: LoadedBook =
          latestBook === currentBook
            ? uploadedSavedBook
            : {
                ...latestBook,
                version: result.version,
                serverPaths: uploadedSavedBook.serverPaths,
                serverEntries: uploadedSavedBook.serverEntries,
              }
        bookRef.current = next
        setBook(next)
        agentUndoRef.current = null
        setAgentUndoMessageId(null)

        const remaining = syncDirtyFromBaseline(next)
        setSaveState('saved')
        setSavedAt(Date.now())
        setServerIssues([])
        if (remaining.texts.size === 0) {
          if (draftTimer.current) {
            clearTimeout(draftTimer.current)
            draftTimer.current = null
          }
          void clearDraft(currentBook.id)
        } else {
          scheduleDraft()
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          conflictRef.current = true
          setConflict(true)
          setSaveState('idle')
        } else {
          setSaveError(messageFor(error))
          setSaveState('error')
          const reported = error instanceof ApiError ? (error.payload as { issues?: EpubIssue[] }).issues : null
          if (reported && reported.length > 0) {
            // The server's rejection is the most authoritative issue list there is; open the health
            // popover directly so the user sees every failing path instead of a generic error line.
            setServerIssues(reported)
            setCheckOpen(true)
          }
        }
      } finally {
        savingRef.current = false
        setSaving(false)
      }
    },
    [scheduleDraft, syncDirtyFromBaseline],
  )

  const replaceAsset = useCallback(
    (path: string, file: File) => {
      void file.arrayBuffer().then((buffer) => {
        const current = bookRef.current
        if (!current) return

        const bytes = new Uint8Array(buffer)
        const mediaType = file.type || mediaTypeFromExtension(path)
        const entries = new Map(current.archive.entries)
        entries.set(path, bytes)

        const opfPath = current.pkg.opfPath
        const opf = texts.current.get(opfPath) ?? ''
        let nextOpf = opf
        try {
          nextOpf = setManifestMediaType(
            opf,
            path,
            mediaTypeFromExtension(path),
            dirname(opfPath),
            browserXmlCodec,
          )
        } catch {
          // The entry is not in the manifest; the bytes still get replaced.
        }
        if (nextOpf !== opf) texts.current.set(opfPath, nextOpf)

        const entryMeta = new Map(current.entryMeta)
        entryMeta.set(path, {
          path,
          isText: false,
          mediaType,
          byteSize: bytes.byteLength,
          sha256: null,
        })
        const localBinaries = new Map(current.localBinaries)
        localBinaries.set(path, { bytes, mediaType })

        const archive: EpubArchive = { order: archiveOrder(current.archive.order, entries), entries }
        const next = { ...current, archive, groups: groupFiles(current.pkg, archive), entryMeta, localBinaries }
        bookRef.current = next
        setBook(next)
        const summary = syncDirtyFromBaseline(next)
        syncDurability(summary)
      })
    },
    [syncDirtyFromBaseline, syncDurability],
  )

  const importAsset = useCallback(
    async (file: File) => {
      const current = bookRef.current
      if (!current) return
      const bytes = new Uint8Array(await file.arrayBuffer())
      const latest = bookRef.current
      if (!latest) return
      const baseDir = dirname(latest.pkg.opfPath)
      const safeName = file.name.replace(/[^\w.\-]+/g, '_')
      let target = `${baseDir}/media/${safeName}`
      let counter = 1
      while (latest.archive.entries.has(target)) {
        target = `${baseDir}/media/${counter}_${safeName}`
        counter += 1
      }
      const href = target.slice(baseDir.length + 1)
      const id = href.replace(/[/.\-]+/g, '_')

      const mediaType = file.type || mediaTypeFromExtension(target)
      const opf = texts.current.get(latest.pkg.opfPath) ?? ''
      const nextOpf = addManifestItem(opf, { id, href, mediaType }, browserXmlCodec)
      texts.current.set(latest.pkg.opfPath, nextOpf)

      const entries = new Map(latest.archive.entries)
      entries.set(target, bytes)
      const order = latest.archive.order.includes(target) ? latest.archive.order : [...latest.archive.order, target]
      const archive = { order, entries }
      const entryMeta = new Map(latest.entryMeta)
      entryMeta.set(target, {
        path: target,
        isText: false,
        mediaType,
        byteSize: bytes.byteLength,
        sha256: null,
      })
      const localBinaries = new Map(latest.localBinaries)
      localBinaries.set(target, { bytes, mediaType })
      const next = { ...latest, archive, groups: groupFiles(latest.pkg, archive), entryMeta, localBinaries }
      bookRef.current = next
      setBook(next)
      const summary = syncDirtyFromBaseline(next)
      syncDurability(summary)
      // Binary entries are not editable, so they stay out of the tab strip.
    },
    [syncDirtyFromBaseline, syncDurability],
  )

  useEffect(() => {
    saveRef.current = save
  }, [save])

  useEffect(() => {
    const instance = createAutosave({ save: () => saveRef.current(), isDirty: () => dirtyRef.current.size > 0 })
    autosave.current = instance
    return () => {
      instance.cancel()
      autosave.current = null
      // Leaving the editor is a save point: the alternative is losing the last few minutes.
      void instance.flush()
    }
  }, [bookId])

  useEffect(() => {
    if (dirty.size === 0) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty.size])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault()
        const list = tabsRef.current
        if (list.length === 0) return
        const index = active ? list.indexOf(active) : -1
        const next = list[(index + (event.shiftKey ? -1 : 1) + list.length) % list.length]
        if (next) setActive(next)
        return
      }
      const modifier = event.metaKey || event.ctrlKey
      if (!modifier) return
      if (event.key.toLowerCase() === 'w' && !event.shiftKey) {
        event.preventDefault()
        if (active) close(active)
        return
      }
      if (event.key.toLowerCase() === 's' && !event.shiftKey) {
        event.preventDefault()
        void save({ checkpoint: true })
      }
      if (event.key.toLowerCase() === 'f' && event.shiftKey) {
        event.preventDefault()
        setSearchSeedQuery('')
        setSearchOpen(true)
      }
      if (event.key.toLowerCase() === 'k' && !event.shiftKey) {
        event.preventDefault()
        setCommandPaletteOpen((openPalette) => !openPalette)
      }
      if (event.key.toLowerCase() === 'l' && event.shiftKey) {
        event.preventDefault()
        setAgentOpen((openAgent) => {
          const next = !openAgent
          if (next) setTreeOpen(false)
          return next
        })
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [save, active, close])

  const resolveAsset = useCallback(
    (targetPath: string) => (book ? resolveBookAsset(book, targetPath) : null),
    [book],
  )

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sidebarWidth
    const move = (moveEvent: PointerEvent) => {
      const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth - (moveEvent.clientX - startX)))
      setSidebarWidth(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  if (state.status === 'loading') {
    return (
      <div className="shell">
        <header className="appbar">
          <Button variant="ghost" aria-label="← 书库" onClick={() => navigate('/')}>
            <ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>书库</span>
          </Button>
        </header>
        <main className="stage" aria-busy="true">
          <span className="boot-text">正在载入书籍…</span>
        </main>
      </div>
    )
  }

  if (state.status === 'error' || !book) {
    return (
      <div className="shell">
        <header className="appbar">
          <Button variant="ghost" aria-label="← 书库" onClick={() => navigate('/')}>
            <ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>书库</span>
          </Button>
        </header>
        <main className="stage">
          <EmptyState
            title="打不开这本书"
            description={state.status === 'error' ? state.message : '未知错误'}
            action={
              <Button variant="secondary" onClick={() => navigate('/')}>
                返回书库
              </Button>
            }
          />
        </main>
      </div>
    )
  }

  const activeAsset = active ? resolveAsset(active) : null
  const content = active ? (texts.current.get(active) ?? '') : ''
  // Binary entries (images, fonts) never live in `texts`, so they get a read-only view instead of the editor.
  const editable = active !== null && texts.current.has(active)
  const mediaPane = active ? (
    <MediaPane
      path={active}
      bytes={activeAsset?.kind === 'bytes' ? activeAsset.bytes : undefined}
      srcUrl={activeAsset?.kind === 'url' ? activeAsset.url : null}
      byteSize={book.entryMeta.get(active)?.byteSize}
      mime={mediaTypeOf(active, book.pkg)}
      onReplace={replaceAsset}
      onDelete={requestDelete}
    />
  ) : null
  const previewable = isPreviewable(active)
  const canWysiwyg = editable && previewable
  const showWysiwyg = canWysiwyg && editorMode === 'wysiwyg'

  const handleWysiwygShortcut = (action: WysiwygShortcut) => {
    if (action === 'save') {
      void saveRef.current({ checkpoint: true })
      return
    }
    if (action === 'close-tab') {
      if (active) close(active)
      return
    }
    if (action === 'search') {
      setSearchSeedQuery('')
      setSearchOpen(true)
      return
    }
    if (action === 'command-palette') {
      setCommandPaletteOpen((openPalette) => !openPalette)
      return
    }
    const list = tabsRef.current
    if (list.length === 0) return
    const index = active ? list.indexOf(active) : -1
    const delta = action === 'prev-tab' ? -1 : 1
    const next = list[(index + delta + list.length) % list.length]
    if (next) selectTab(next)
  }

  const searchFiles: SearchFile[] = [...texts.current].map(([path, text]) => ({ path, text }))
  const tocPath = book.pkg.navPath ?? book.pkg.ncxPath ?? null
  const tocEntries: TocEntry[] = (() => {
    if (!tocPath) return []
    const xml = texts.current.get(tocPath)
    if (!xml) return []
    try {
      return book.pkg.navPath ? readNavToc(xml, browserXmlCodec) : readNcxToc(xml, browserXmlCodec)
    } catch {
      return []
    }
  })()
  const brokenAnchors = tocPath ? findBrokenAnchors(tocEntries, tocPath, texts.current) : []
  // Live book health status powers the topbar diagnostic pill and its Radix Popover card.
  // See ADR 2026-11-20-soft-craft-studio-ui.
  const issues = [...serverIssues, ...lintBook(texts.current, book.pkg, book.archive, browserXmlCodec)]
  const entrySizes = new Map<string, number>()
  for (const [entryPath, meta] of book.entryMeta) entrySizes.set(entryPath, meta.byteSize)
  const unusedResources = findUnusedResources(texts.current, book.pkg, book.archive, entrySizes)
  const bookStylesheets = listBookStylesheets(book.pkg, book.archive)
  const linkedByChapter = new Map<string, string[]>()
  if (stylesheetTargets) {
    for (const chPath of stylesheetTargets) {
      linkedByChapter.set(chPath, getLinkedStylesheets(texts.current.get(chPath) ?? '', chPath))
    }
  }
  const markerCounts = new Map<string, number>()
  for (const chPath of book.groups.find((g) => g.group === 'Text')?.paths ?? []) {
    const count = countSplitMarkers(texts.current.get(chPath) ?? '')
    if (count > 0) markerCounts.set(chPath, count)
  }
  const showSplitPreview = Boolean(active && editable && previewable && !showWysiwyg && previewOpen)
  const activeFileKind = codeFileKindOf(active)
  const activeMarkerCount = active ? (markerCounts.get(active) ?? 0) : 0
  const spineOrder = spinePaths(book.pkg)
  const activeSpineIndex = active ? spineOrder.indexOf(active) : -1
  const canFormatActive = editable && !showWysiwyg && activeFileKind !== 'other'

  const triggerSplitFromCodeCursor = () => {
    const offset = codePaneHandleRef.current?.getCursorOffset()
    if (offset !== null && offset !== undefined) handleSplitAtCursor(offset)
  }

  const codeContextItems: ContextMenuEntry[] =
    active && editable
      ? [
          ...(previewable
            ? [
                {
                  id: 'ctx-split-cursor',
                  label: `在光标处拆分章节 (${formatShortcut('Mod+Enter')})`,
                  icon: <Scissors size={14} strokeWidth={1.65} />,
                  onSelect: triggerSplitFromCodeCursor,
                },
                {
                  id: 'ctx-insert-marker',
                  label: `插入拆分标记 (${formatShortcut('Mod+Shift+Enter')})`,
                  icon: <SeparatorHorizontal size={14} strokeWidth={1.65} />,
                  onSelect: handleInsertSplitMarker,
                },
                {
                  id: 'ctx-split-markers',
                  label: activeMarkerCount > 0 ? `按标记拆分（${activeMarkerCount} 处）` : '按标记拆分',
                  icon: <Split size={14} strokeWidth={1.65} />,
                  disabled: activeMarkerCount === 0,
                  onSelect: () => handleSplitAtMarkers(active),
                },
                {
                  id: 'ctx-wrap-p',
                  label: '包裹为正文 <p>',
                  icon: <Code2 size={14} strokeWidth={1.65} />,
                  separatorBefore: true,
                  onSelect: () =>
                    codePaneHandleRef.current?.applyTransform((doc, from, to) => wrapBlockTag(doc, from, to, 'p')),
                },
                {
                  id: 'ctx-wrap-h2',
                  label: '包裹为二级标题 <h2>',
                  icon: <Code2 size={14} strokeWidth={1.65} />,
                  onSelect: () =>
                    codePaneHandleRef.current?.applyTransform((doc, from, to) => wrapBlockTag(doc, from, to, 'h2')),
                },
                {
                  id: 'ctx-wrap-strong',
                  label: '加粗 <strong>',
                  icon: <Bold size={14} strokeWidth={1.65} />,
                  onSelect: () =>
                    codePaneHandleRef.current?.applyTransform((doc, from, to) => wrapInlineTag(doc, from, to, 'strong')),
                },
                {
                  id: 'ctx-wrap-em',
                  label: '斜体 <em>',
                  icon: <Italic size={14} strokeWidth={1.65} />,
                  onSelect: () =>
                    codePaneHandleRef.current?.applyTransform((doc, from, to) => wrapInlineTag(doc, from, to, 'em')),
                },
                {
                  id: 'ctx-link-css',
                  label: '关联样式表…',
                  icon: <FileCode2 size={14} strokeWidth={1.65} />,
                  separatorBefore: true,
                  opensDialog: true,
                  onSelect: () => setStylesheetTargets([active]),
                },
              ]
            : []),
          ...(activeFileKind !== 'other'
            ? [
                {
                  id: 'ctx-format',
                  label: `美化格式化代码 (${formatShortcut('Alt+Shift+F')})`,
                  icon: <AlignLeft size={14} strokeWidth={1.65} />,
                  separatorBefore: !previewable,
                  onSelect: handleFormatDocument,
                },
              ]
            : []),
          ...(selectionText.trim().length > 0
            ? [
                {
                  id: 'ctx-search-selection',
                  label: `全书查找「${selectionText.trim().slice(0, 18)}${selectionText.trim().length > 18 ? '…' : ''}」`,
                  icon: <Search size={14} strokeWidth={1.65} />,
                  separatorBefore: true,
                  opensDialog: true,
                  onSelect: () => {
                    setSearchSeedQuery(selectionText.trim())
                    setSearchOpen(true)
                  },
                },
              ]
            : []),
        ]
      : []

  const paletteCommands: CommandItem[] = [
    // 章节与结构
    {
      id: 'cmd-split-cursor',
      group: '章节与结构',
      label: '在光标处拆分章节',
      keywords: 'split cursor 拆分 光标',
      shortcut: formatShortcut('Mod+Enter'),
      icon: <Scissors size={14} strokeWidth={1.7} />,
      disabled: !active || !previewable || showWysiwyg,
      disabledReason: showWysiwyg
        ? `可视化模式请直接按 ${formatShortcut('Mod+Enter')} 或点工具栏拆分按钮`
        : '仅 XHTML 章节支持拆分',
      onSelect: triggerSplitFromCodeCursor,
    },
    {
      id: 'cmd-insert-marker',
      group: '章节与结构',
      label: '插入拆分标记',
      keywords: 'split marker sigil 拆分标记',
      shortcut: formatShortcut('Mod+Shift+Enter'),
      icon: <SeparatorHorizontal size={14} strokeWidth={1.7} />,
      disabled: !active || !previewable || showWysiwyg,
      disabledReason: showWysiwyg
        ? `可视化模式请按 ${formatShortcut('Mod+Shift+Enter')} 或点工具栏插入标记`
        : '仅 XHTML 章节支持',
      onSelect: handleInsertSplitMarker,
    },
    {
      id: 'cmd-split-markers',
      group: '章节与结构',
      label: activeMarkerCount > 0 ? `按标记批量拆分当前章（${activeMarkerCount} 处）` : '按标记批量拆分当前章',
      keywords: 'split markers batch 批量拆分',
      icon: <Split size={14} strokeWidth={1.7} />,
      disabled: !active || !previewable || activeMarkerCount === 0,
      disabledReason: '当前章节没有拆分标记',
      onSelect: () => active && handleSplitAtMarkers(active),
    },
    {
      id: 'cmd-merge-prev',
      group: '章节与结构',
      label: '将当前章与上一章合并',
      keywords: 'merge previous 合并 上一章',
      icon: <Merge size={14} strokeWidth={1.7} />,
      disabled: !active || activeSpineIndex <= 0,
      disabledReason: '仅阅读顺序中第 2 章及以后的章节可合并',
      onSelect: () => active && handleMergeWithPrevious(active),
    },
    {
      id: 'cmd-duplicate-chapter',
      group: '章节与结构',
      label: '复制当前章节',
      keywords: 'duplicate clone 复制 克隆 章节',
      icon: <Copy size={14} strokeWidth={1.7} />,
      disabled: !active || !previewable,
      disabledReason: '仅 XHTML 章节可复制',
      onSelect: () => active && handleDuplicateChapter(active),
    },
    {
      id: 'cmd-new-chapter',
      group: '章节与结构',
      label: '新建空白章节',
      keywords: 'new create chapter 新建 章节',
      icon: <FilePlus2 size={14} strokeWidth={1.7} />,
      onSelect: createDocument,
    },
    {
      id: 'cmd-new-css',
      group: '章节与结构',
      label: '新建空白 CSS 样式表',
      keywords: 'new create css stylesheet 新建 样式表',
      icon: <FileCode2 size={14} strokeWidth={1.7} />,
      onSelect: () => {
        const res = handleCreateStylesheet(undefined, true)
        if ('error' in res) setSaveError(res.error)
      },
    },
    {
      id: 'cmd-link-css',
      group: '章节与结构',
      label: '为当前章关联样式表…',
      keywords: 'link stylesheet css 关联 样式表',
      icon: <FileCode2 size={14} strokeWidth={1.7} />,
      disabled: !active || !previewable,
      disabledReason: '仅 XHTML 章节可关联样式表',
      onSelect: () => active && setStylesheetTargets([active]),
    },
    {
      id: 'cmd-undo-structure',
      group: '章节与结构',
      label: '撤销上次结构操作',
      keywords: 'undo structure 撤销 结构',
      icon: <Undo2 size={14} strokeWidth={1.7} />,
      disabled: structureHistoryRef.current.length === 0,
      disabledReason: '暂无可撤销的结构操作',
      onSelect: undoStructure,
    },
    // 代码编辑
    {
      id: 'cmd-format',
      group: '代码编辑',
      label: '美化格式化当前文件',
      keywords: 'format prettify beautify 格式化 美化 缩进',
      shortcut: formatShortcut('Alt+Shift+F'),
      icon: <AlignLeft size={14} strokeWidth={1.7} />,
      disabled: !canFormatActive,
      disabledReason: showWysiwyg ? '请先切回代码模式再格式化' : '当前文件类型不支持格式化',
      onSelect: handleFormatDocument,
    },
    {
      id: 'cmd-wrap-strong',
      group: '代码编辑',
      label: '包裹加粗标签 <strong>',
      keywords: 'bold strong 加粗',
      icon: <Bold size={14} strokeWidth={1.7} />,
      disabled: !active || !previewable || showWysiwyg,
      disabledReason: '仅代码模式 XHTML 章节可用',
      onSelect: () =>
        codePaneHandleRef.current?.applyTransform((doc, from, to) => wrapInlineTag(doc, from, to, 'strong')),
    },
    {
      id: 'cmd-wrap-em',
      group: '代码编辑',
      label: '包裹斜体标签 <em>',
      keywords: 'italic em 斜体',
      icon: <Italic size={14} strokeWidth={1.7} />,
      disabled: !active || !previewable || showWysiwyg,
      disabledReason: '仅代码模式 XHTML 章节可用',
      onSelect: () =>
        codePaneHandleRef.current?.applyTransform((doc, from, to) => wrapInlineTag(doc, from, to, 'em')),
    },
    // 视图与面板
    {
      id: 'cmd-toggle-mode',
      group: '视图与面板',
      label: showWysiwyg ? '切换到代码编辑模式' : '切换到可视化校对模式',
      keywords: 'mode code wysiwyg 代码 可视化 切换',
      icon: showWysiwyg ? <Code2 size={14} strokeWidth={1.7} /> : <FilePenLine size={14} strokeWidth={1.7} />,
      disabled: !canWysiwyg,
      disabledReason: '仅 XHTML 章节支持切换模式',
      onSelect: () => switchMode(showWysiwyg ? 'code' : 'wysiwyg'),
    },
    {
      id: 'cmd-toggle-preview',
      group: '视图与面板',
      label: previewOpen ? '收起右侧对照预览' : '展开右侧对照预览',
      keywords: 'preview split 对照预览 预览',
      icon: <Columns2 size={14} strokeWidth={1.7} />,
      disabled: !previewable || showWysiwyg,
      disabledReason: '仅代码模式 XHTML 章节支持对照预览',
      onSelect: () => setPreviewOpen((v) => !v),
    },
    {
      id: 'cmd-nav-files',
      group: '视图与面板',
      label: '切换到文件树视图',
      keywords: 'files tree 文件树',
      icon: <FolderTree size={14} strokeWidth={1.7} />,
      onSelect: () => setNavTab('files'),
    },
    {
      id: 'cmd-nav-toc',
      group: '视图与面板',
      label: '切换到目录大纲视图',
      keywords: 'toc outline 目录 大纲',
      icon: <ListTree size={14} strokeWidth={1.7} />,
      onSelect: () => setNavTab('toc'),
    },
    {
      id: 'cmd-toggle-agent',
      group: '视图与面板',
      label: agentOpen ? '收起 AI 编辑助手' : '打开 AI 编辑助手',
      keywords: 'agent ai 助手',
      shortcut: formatShortcut('Mod+Shift+L'),
      icon: <Sparkles size={14} strokeWidth={1.7} />,
      onSelect: () => toggleAgentSidebar(),
    },
    // 书籍工具
    {
      id: 'cmd-search-book',
      group: '书籍工具',
      label: '全书查找与替换',
      keywords: 'search find replace 查找 替换 正则',
      shortcut: formatShortcut('Mod+Shift+F'),
      icon: <Search size={14} strokeWidth={1.7} />,
      onSelect: () => {
        setSearchSeedQuery('')
        setSearchOpen(true)
      },
    },
    {
      id: 'cmd-cleanup-unused',
      group: '书籍工具',
      label: unusedResources.length > 0 ? `清理未引用资源（${unusedResources.length} 项）…` : '清理未引用资源…',
      keywords: 'clean unused resources media 清理 未使用 未引用 资源',
      icon: <Trash2 size={14} strokeWidth={1.7} />,
      onSelect: () => setUnusedDialogOpen(true),
    },
    {
      id: 'cmd-metadata',
      group: '书籍工具',
      label: '编辑书籍出版信息与元数据',
      keywords: 'metadata opf 元数据 书名 作者',
      icon: <Tags size={14} strokeWidth={1.7} />,
      onSelect: () => setMetadataOpen(true),
    },
    {
      id: 'cmd-check',
      group: '书籍工具',
      label: '打开全书结构检查',
      keywords: 'check lint validate 检查 结构',
      icon: <ShieldCheck size={14} strokeWidth={1.7} />,
      onSelect: () => setCheckOpen(true),
    },
    {
      id: 'cmd-settings',
      group: '书籍工具',
      label: '打开应用设置',
      keywords: 'settings preferences theme 设置 主题 工具条',
      icon: <Settings size={14} strokeWidth={1.7} />,
      onSelect: () => setSettingsTab('general'),
    },
    {
      id: 'cmd-save',
      group: '书籍工具',
      label: '保存当前修改',
      keywords: 'save checkpoint 保存',
      shortcut: formatShortcut('Mod+S'),
      icon: <Save size={14} strokeWidth={1.7} />,
      disabled: dirty.size === 0 || saving || conflict,
      disabledReason: dirty.size === 0 ? '当前没有未保存修改' : '保存中或存在版本冲突',
      onSelect: () => void save({ checkpoint: true }),
    },
  ]

  const applyDraft = () => {
    if (!draftPrompt) return
    for (const [path, text] of draftPrompt.files) texts.current.set(path, text)
    setExternalResetVersion((v) => v + 1)
    setDraftPrompt(null)
    setDraftSavedAt(null)
    const summary = syncDirtyFromBaseline()
    syncDurability(summary)
  }

  const discardDraft = () => {
    setDraftPrompt(null)
    setDraftSavedAt(null)
    void clearDraft(bookId)
  }

  const toggleAgentSidebar = () => {
    setAgentOpen((openAgent) => {
      const next = !openAgent
      if (next) setTreeOpen(false)
      return next
    })
  }

  return (
    <div className={`shell editor-shell${treeOpen ? ' tree-open' : ''}${agentOpen ? ' agent-open' : ''}`}>
      <header className="appbar">
        <Button variant="ghost" aria-label="← 书库" onClick={() => navigate('/')}>
          <ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="appbar-back-label">书库</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="tree-toggle"
          aria-label="文件"
          aria-expanded={treeOpen}
          onClick={() => setTreeOpen((openTree) => !openTree)}
        >
          <FolderTree size={14} strokeWidth={1.65} aria-hidden="true" />
          <span className="appbar-tree-label">文件</span>
        </Button>
        <span className="appbar-sep" aria-hidden="true" />
        <span className="appbar-title" title={book.pkg.metadata.title}>
          {book.pkg.metadata.title}
        </span>
        <button
          type="button"
          className="appbar-pill"
          aria-label="元数据"
          title="编辑书籍出版信息与 OPF 元数据"
          onClick={() => setMetadataOpen(true)}
        >
          <Tags size={13} strokeWidth={1.7} aria-hidden="true" />
          <span className="appbar-tool-label">元数据</span>
        </button>
        <button
          type="button"
          className="appbar-meta appbar-history"
          title={active ? `${basename(active)} 的版本历史` : '版本历史'}
          disabled={!active || !hasPageHistory(active)}
          onClick={() => active && setHistoryPath(active)}
        >
          <History size={12} strokeWidth={1.75} aria-hidden="true" />
          <span>v{book.version}</span>
        </button>
        <span className="appbar-spacer" />
        {saveState === 'error' ? (
          <button type="button" className="appbar-save is-error" onClick={() => void save({ checkpoint: true })}>
            <AlertCircle size={12} strokeWidth={1.8} aria-hidden="true" />
            <span>保存失败 · 重试</span>
          </button>
        ) : showSaving ? (
          <span className="appbar-save is-saving">
            <Loader2 size={12} strokeWidth={1.8} className="spin" aria-hidden="true" />
            <span>保存中…</span>
          </span>
        ) : dirty.size > 0 ? (
          <span className="appbar-flag">{dirty.size} 处未保存</span>
        ) : savedAt ? (
          <span className="appbar-save is-saved">
            <Check size={12} strokeWidth={2} aria-hidden="true" />
            <span>已保存 {clockLabel(savedAt)}</span>
          </span>
        ) : null}
        <button
          type="button"
          className="appbar-search-trigger"
          aria-label="查找"
          title={`全书查找与替换（${formatShortcut('Mod+Shift+F')}）`}
          onClick={() => setSearchOpen(true)}
        >
          <Search size={13} strokeWidth={1.75} aria-hidden="true" />
          <span className="appbar-tool-label">查找</span>
          <kbd className="appbar-kbd" aria-hidden="true">
            {formatShortcut('Mod+Shift+F')}
          </kbd>
        </button>
        <Popover.Root open={checkOpen} onOpenChange={setCheckOpen}>
          <Popover.Trigger asChild>
            <button
              type="button"
              className={`appbar-pill appbar-check-pill${issues.length > 0 ? ' has-issues' : ' is-clean'}`}
              aria-label="检查"
              title={issues.length > 0 ? `发现 ${issues.length} 处结构问题` : '全书结构检查通过'}
            >
              {issues.length > 0 ? (
                <AlertTriangle size={13} strokeWidth={1.8} aria-hidden="true" />
              ) : (
                <ShieldCheck size={13} strokeWidth={1.75} aria-hidden="true" />
              )}
              <span className="appbar-tool-label">检查</span>
              {issues.length > 0 ? <span className="appbar-check-count">{issues.length}</span> : null}
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content className="check-popover" sideOffset={8} collisionPadding={12} align="end">
              <div className="check-popover-head">
                <span className="check-popover-title">全书结构检查</span>
                <span className="check-popover-sub">
                  {issues.length === 0 ? '0 项异常' : `${issues.length} 项待处理`}
                </span>
              </div>
              <div className="check-popover-body">
                <CheckPanel
                  issues={issues}
                  unusedResourceCount={unusedResources.length}
                  onOpen={(path, line) => {
                    setCheckOpen(false)
                    open(path)
                    if (line) {
                      setEditorMode('code')
                      setReveal({ line, column: 1, key: Date.now() })
                    }
                  }}
                  onOpenUnusedCleanup={() => {
                    setCheckOpen(false)
                    setUnusedDialogOpen(true)
                  }}
                />
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        <Button
          variant="ghost"
          size="sm"
          className={`appbar-agent-toggle${agentOpen ? ' is-active' : ''}`}
          aria-label="助手"
          aria-pressed={agentOpen}
          title={`切换 AI 助手（${formatShortcut('Mod+Shift+L')}）`}
          onClick={toggleAgentSidebar}
        >
          <Sparkles size={14} strokeWidth={1.7} aria-hidden="true" />
          <span className="appbar-agent-label">助手</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="appbar-settings-btn"
          aria-label="设置"
          title="应用设置（主题、编辑器与 AI 助手）"
          onClick={() => setSettingsTab('general')}
        >
          <Settings size={14} strokeWidth={1.7} aria-hidden="true" />
        </Button>
        <span className="appbar-sep appbar-download" aria-hidden="true" />
        <a
          className="btn btn-ghost appbar-download"
          href={downloadUrl(book.id)}
          download
          title={dirty.size > 0 ? `下载已保存的版本（${dirty.size} 个文件未保存）` : '下载这本书的 EPUB'}
        >
          <Download size={14} strokeWidth={1.65} aria-hidden="true" />
          <span>下载</span>
        </a>
        <Button variant="secondary" aria-label="加资源" onClick={() => assetInput.current?.click()}>
          <ImagePlus size={14} strokeWidth={1.65} aria-hidden="true" />
          <span className="appbar-asset-label">加资源</span>
        </Button>
        <input
          ref={assetInput}
          type="file"
          accept="image/*,.ttf,.otf,.woff,.woff2"
          hidden
          data-testid="asset-input"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void importAsset(file)
            event.target.value = ''
          }}
        />
        <Button
          variant="primary"
          onClick={() => void save({ checkpoint: true })}
          disabled={dirty.size === 0 || saving || conflict}
        >
          <Save size={14} strokeWidth={1.65} aria-hidden="true" />
          <span>保存</span>
        </Button>
      </header>

      {draftPrompt ? (
        <p className="banner banner-info save-banner" role="status">
          发现 {draftSavedAt ? clockLabel(draftSavedAt) : '刚才'} 的本地草稿（{draftPrompt.files.length} 个文件）
          {draftPrompt.stale ? '，服务端的版本已更新，恢复会覆盖同名文件' : ''}
          {draftPrompt.dropped.length > 0 ? `，${draftPrompt.dropped.length} 个文件已不在书里` : ''}
          <span className="banner-actions">
            <button type="button" className="banner-action" onClick={applyDraft}>
              恢复草稿
            </button>
            <button type="button" className="banner-action" onClick={discardDraft}>
              丢弃
            </button>
          </span>
        </p>
      ) : null}

      {conflict ? (
        <p className="banner banner-error save-banner" role="alert">
          这本书在别处已更新，你的修改还没有保存。
          <button type="button" className="banner-action" onClick={() => void reload()}>
            重新加载（丢弃本地修改）
          </button>
        </p>
      ) : null}

      {saveError ? (
        <p className="banner banner-error save-banner" role="alert">
          {saveError}
        </p>
      ) : null}

      <div className="workspace">
        {/* Left floating structure island merges file tree and TOC authoring into one navigation card. See ADR 2026-11-20-soft-craft-studio-ui. */}
        <aside className="nav-island" aria-label="书籍结构与目录">
          <div className="nav-island-tabs" role="tablist" aria-label="结构视图切换">
            <button
              type="button"
              role="tab"
              aria-selected={navTab === 'files'}
              className={`nav-island-tab${navTab === 'files' ? ' on' : ''}`}
              onClick={() => setNavTab('files')}
            >
              <FolderTree size={13} strokeWidth={1.7} aria-hidden="true" />
              <span>文件</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={navTab === 'toc'}
              className={`nav-island-tab${navTab === 'toc' ? ' on' : ''}`}
              onClick={() => setNavTab('toc')}
            >
              <ListTree size={13} strokeWidth={1.7} aria-hidden="true" />
              <span>目录</span>
              {brokenAnchors.length > 0 ? <span className="nav-island-badge">{brokenAnchors.length}</span> : null}
            </button>
          </div>
          <div className="nav-island-body">
            {navTab === 'files' ? (
              <FileTree
                groups={book.groups}
                active={activeReview ? activeReview.selectedPath : active}
                dirty={dirty}
                spinePaths={spinePaths(book.pkg)}
                markerCounts={markerCounts}
                reviewMarks={reviewMarks}
                onOpen={(path) => {
                  if (activeReview) {
                    const matched = activeReview.proposal.files.find(
                      (file) => file.path === path || file.previousPath === path,
                    )
                    if (matched) {
                      setActiveReview((cur) => (cur ? { ...cur, selectedPath: matched.path } : null))
                      setTreeOpen(false)
                      return
                    }
                    setActiveReview(null)
                  }
                  open(path)
                  setTreeOpen(false)
                }}
                onHistory={(path) => {
                  setHistoryPath(path)
                  setTreeOpen(false)
                }}
                onCreate={() => {
                  createDocument()
                  setTreeOpen(false)
                }}
                onCreateStylesheet={() => {
                  const res = handleCreateStylesheet(undefined, true)
                  if ('error' in res) setSaveError(res.error)
                  setTreeOpen(false)
                }}
                onDuplicate={(path) => {
                  handleDuplicateChapter(path)
                  setTreeOpen(false)
                }}
                onSplitAtMarkers={(path) => {
                  handleSplitAtMarkers(path)
                  setTreeOpen(false)
                }}
                onMergeWithPrevious={(path) => {
                  handleMergeWithPrevious(path)
                  setTreeOpen(false)
                }}
                onMergeSelected={(paths) => {
                  handleMergeChapters(paths)
                  setTreeOpen(false)
                }}
                onLinkStylesheets={(paths) => {
                  setStylesheetTargets(paths)
                  setTreeOpen(false)
                }}
                onRename={(path) => {
                  startRename(path)
                  setTreeOpen(false)
                }}
                onDelete={(path) => {
                  requestDelete(path)
                  setTreeOpen(false)
                }}
                onMove={moveSpine}
              />
            ) : (
              <TocPanel
                pkg={book.pkg}
                entries={tocEntries}
                broken={brokenAnchors}
                tocPath={tocPath}
                files={spinePaths(book.pkg)}
                texts={texts.current}
                activePath={active}
                activeTocHref={activeTocHref}
                canUndo={tocHistoryState.canUndo}
                canRedo={tocHistoryState.canRedo}
                suggestTitle={(hrefOrPath) => {
                  const resolved = tocPath ? resolvePath(dirname(tocPath), hrefOrPath) : hrefOrPath
                  const text = texts.current.get(resolved) ?? texts.current.get(hrefOrPath) ?? ''
                  const match = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(text)
                  return match?.[1]
                    ? match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
                    : basename(resolved).replace(/\.[^.]+$/, '')
                }}
                onNavigate={(href) => {
                  navigateTocHref(href)
                  setTreeOpen(false)
                }}
                onChange={(next, extraChapters) => applyTocMutation(next, extraChapters)}
                onUndo={undoToc}
                onRedo={redoToc}
                onInitializeToc={initializeToc}
              />
            )}
          </div>
        </aside>

        <div className={`canvas-stage${showSplitPreview && !activeReview ? ' is-split' : ''}`}>
          {activeReview ? (
            <ProposalReviewPane
              book={book}
              texts={texts.current}
              proposal={activeReview.proposal}
              selectedPath={activeReview.selectedPath}
              readOnly={activeReview.readOnly}
              busy={reviewBusy}
              autoDowngradeReason={activeReview.autoDowngradeReason}
              skippedByPath={skippedHunksByMessage[activeReview.messageId] ?? {}}
              resolveAsset={resolveAsset}
              onSelectPath={(nextPath) =>
                setActiveReview((cur) => (cur ? { ...cur, selectedPath: nextPath } : null))
              }
              onToggleHunk={(filePath, hunkId) => toggleReviewHunk(activeReview.messageId, filePath, hunkId)}
              onResetFileHunks={(filePath) => resetReviewFileHunks(activeReview.messageId, filePath)}
              onApply={() => void handleApplyAgentProposal(activeReview.messageId, activeReview.proposal)}
              onDismiss={() => void handleDismissAgentProposal(activeReview.messageId)}
              onExit={() => setActiveReview(null)}
            />
          ) : null}

          <div className="document-card editor-column" hidden={Boolean(activeReview)}>
            <TabBar
              tabs={tabs}
              active={active}
              dirty={dirty}
              mode={editorMode}
              canWysiwyg={canWysiwyg}
              previewOpen={previewOpen}
              onPreviewToggle={() => setPreviewOpen((v) => !v)}
              onModeChange={switchMode}
              onSelect={selectTab}
              onClose={close}
            />
            {active ? (
              editable ? (
                <>
                  {!showWysiwyg && settings.showCodeToolbar ? (
                    <CodeToolbar
                      path={active}
                      fileKind={activeFileKind}
                      archive={book.archive}
                      pkg={book.pkg}
                      resolveAsset={resolveAsset}
                      markerCount={activeMarkerCount}
                      onSplitAtCursor={triggerSplitFromCodeCursor}
                      onInsertSplitMarker={handleInsertSplitMarker}
                      onSplitAtMarkers={() => handleSplitAtMarkers(active)}
                      onWrapBlock={(tag) =>
                        codePaneHandleRef.current?.applyTransform((doc, from, to) => wrapBlockTag(doc, from, to, tag))
                      }
                      onWrapInline={(tag) =>
                        codePaneHandleRef.current?.applyTransform((doc, from, to) => wrapInlineTag(doc, from, to, tag))
                      }
                      onWrapList={(tag) =>
                        codePaneHandleRef.current?.applyTransform((doc, from, to) => wrapList(doc, from, to, tag))
                      }
                      onInsertAnchorId={(id) =>
                        Boolean(
                          codePaneHandleRef.current?.applyTransform((doc, from, to) =>
                            insertAnchorId(doc, from, to, id),
                          ),
                        )
                      }
                      onInsertLink={(href, label) =>
                        Boolean(
                          codePaneHandleRef.current?.applyTransform((doc, from, to) =>
                            insertLinkTag(doc, from, to, href, label),
                          ),
                        )
                      }
                      onInsertImage={(src, alt) =>
                        Boolean(
                          codePaneHandleRef.current?.applyTransform((doc, from, to) =>
                            insertImageTag(doc, from, to, src, alt),
                          ),
                        )
                      }
                      onInsertHr={() =>
                        codePaneHandleRef.current?.applyTransform((doc, from, to) => insertHorizontalRule(doc, from, to))
                      }
                      onInsertChar={(char) =>
                        codePaneHandleRef.current?.applyTransform((doc, from, to) => insertRawText(doc, from, to, char))
                      }
                      onFormat={handleFormatDocument}
                      onOpenCommandPalette={() => setCommandPaletteOpen(true)}
                    />
                  ) : null}
                  <CodePane
                    path={active}
                    content={content}
                    reveal={reveal}
                    handleRef={codePaneHandleRef}
                    visible={!showWysiwyg}
                    wordWrap={settings.codeWordWrap}
                    syncMode={canWysiwyg ? 'transaction' : 'reset'}
                    resetVersion={externalResetVersion}
                    contextMenuItems={codeContextItems}
                    onNavigate={navigateTo}
                    onSelectionChange={setSelectionText}
                    onSplitAtCursor={previewable ? (offset) => handleSplitAtCursor(offset) : undefined}
                    onInsertSplitMarker={previewable ? handleInsertSplitMarker : undefined}
                    onFormatDocument={activeFileKind !== 'other' ? handleFormatDocument : undefined}
                    onChange={(value) => handleChange(active, value)}
                  />
                  {showWysiwyg ? (
                    <WysiwygPane
                      path={active}
                      content={content}
                      archive={book.archive}
                      pkg={book.pkg}
                      resolveAsset={resolveAsset}
                      externalVersion={externalResetVersion}
                      revealFragment={revealFragment}
                      flushRef={wysiwygFlushRef}
                      onChange={(value) => handleChange(active, value, { rerender: true })}
                      onSwitchToCode={() => switchMode('code')}
                      onNavigateLink={navigateTo}
                      onSplitAtCursor={(xhtml, offset) => handleSplitAtCursor(offset, xhtml)}
                      onShortcut={handleWysiwygShortcut}
                    />
                  ) : null}
                </>
              ) : (
                mediaPane
              )
            ) : (
              <div className="code-empty">
                <EmptyState title="没有可编辑的文件" description="这本 EPUB 里没有识别到文本文件。" />
              </div>
            )}
            <StatusBar
              path={active}
              characters={editable ? proseLength(active, content) : null}
              dirtyCount={dirty.size}
            />
          </div>

          {active && editable && previewable ? (
            <section
              className="preview-card"
              aria-label="实时书页预览"
              hidden={!showSplitPreview || Boolean(activeReview)}
            >
              <PreviewPane
                path={active}
                content={content}
                archive={book.archive}
                pkg={book.pkg}
                resolveAsset={resolveAsset}
                revealFragment={revealFragment}
                subscribeTextChange={subscribeTextChange}
              />
            </section>
          ) : null}
        </div>

        {agentOpen ? (
          <>
            <div
              className="splitter"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整助手栏宽度"
              onPointerDown={startResize}
            />
            <aside className="sidebar is-agent" style={{ width: sidebarWidth }} aria-label="EPUB 编辑助手">
              <AgentPanel
                bookId={book.id}
                bookTitle={book.pkg.metadata.title || '未命名'}
                bookVersion={book.version}
                activePath={active}
                selectionText={selectionText}
                profiles={agentProfiles}
                profilesLoading={agentProfilesLoading}
                defaultApprovalMode={agentUserSettings?.defaultApprovalMode ?? 'review'}
                undoMessageId={agentUndoMessageId}
                activeReview={
                  activeReview
                    ? {
                        messageId: activeReview.messageId,
                        selectedPath: activeReview.selectedPath,
                        readOnly: activeReview.readOnly,
                      }
                    : null
                }
                skippedHunksByMessage={skippedHunksByMessage}
                proposalStatusSync={proposalStatusSync}
                getOverlay={() => {
                  wysiwygFlushRef.current?.()
                  const current = bookRef.current ?? book
                  return {
                    dirtyTexts: collectDirtyTexts(texts.current, dirtyRef.current, current),
                    deletedPaths: computeDeletedPaths(current),
                  }
                }}
                onOpenSettings={() => setSettingsTab('agent')}
                onClose={() => setAgentOpen(false)}
                onReloadBook={() => void reload()}
                onOpenProposalReview={openProposalReview}
                onCloseProposalReview={closeProposalReview}
                onApplyProposal={handleApplyAgentProposal}
                onDismissProposal={handleDismissAgentProposal}
                onUndoProposal={handleUndoAgentProposal}
              />
            </aside>
          </>
        ) : null}
      </div>

      <Dialog
        open={metadataOpen}
        onOpenChange={setMetadataOpen}
        ariaLabel="书籍信息"
        title="书籍出版信息与元数据"
        description={`修改直接写入 OPF 并标脏，${formatShortcut('Mod+S')} 保存后生效。`}
        className="metadata-dialog"
      >
        <MetadataPanel
          metadata={book.pkg.metadata}
          opfXml={texts.current.get(book.pkg.opfPath) ?? ''}
          version={book.version}
          onApply={(draft) => {
            handleChange(
              book.pkg.opfPath,
              writeOpfMetadata(texts.current.get(book.pkg.opfPath) ?? '', draft, browserXmlCodec),
            )
          }}
          onApplyMeta={(rows: OpfMetaRow[]) => {
            handleChange(
              book.pkg.opfPath,
              writeOpfMeta(texts.current.get(book.pkg.opfPath) ?? '', rows, browserXmlCodec),
              { rerender: true },
            )
          }}
        />
      </Dialog>

      <Dialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        ariaLabel="查找与替换"
        title="全书查找与替换"
        className="search-dialog"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <SearchPanel
          files={searchFiles}
          initialQuery={searchSeedQuery}
          onOpen={(path, line, column) => {
            setSearchOpen(false)
            open(path)
            setEditorMode('code')
            setReveal({ line, column, key: Date.now() })
          }}
          onReplace={applyReplace}
          onReplaceUndo={undoReplace}
        />
      </Dialog>

      <Dialog
        open={Boolean(renaming)}
        onOpenChange={(openState) => {
          if (!openState) setRenaming(null)
        }}
        ariaLabel="重命名文件"
        title={renaming ? `重命名 ${basename(renaming.path)}` : ''}
        description={
          renaming
            ? `正文、目录与 manifest 里指向它的引用会一起改，位置在 ${dirname(renaming.path)}/。`
            : undefined
        }
        onSubmit={(event) => {
          event.preventDefault()
          confirmRename()
        }}
        footer={
          <>
            <Button variant="ghost" type="button" onClick={() => setRenaming(null)}>
              取消
            </Button>
            <Button variant="primary" type="submit">
              重命名
            </Button>
          </>
        }
      >
        {renaming ? (
          <>
            <label className="panel-field">
              <span>文件名</span>
              <input
                autoFocus
                type="text"
                aria-invalid={renaming.error ? 'true' : undefined}
                value={renaming.value}
                onChange={(event) => setRenaming({ ...renaming, value: event.target.value, error: null })}
              />
            </label>
            {renaming.error ? <p className="banner banner-error">{renaming.error}</p> : null}
          </>
        ) : null}
      </Dialog>

      <Dialog
        open={Boolean(deleting)}
        onOpenChange={(openState) => {
          if (!openState) setDeleting(null)
        }}
        ariaLabel="删除文件"
        title={deleting ? `删除 ${basename(deleting.path)}` : ''}
        description={
          deleting
            ? deleting.references.length === 0
              ? '没有别的地方引用它。删除后这个文件从书里消失，目录里指向它的条目也会一并移除。'
              : `还有 ${deleting.references.length} 处引用它。删除后这些引用会断开，需要你自己去改：`
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" type="button" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button variant="danger" type="button" onClick={confirmDelete}>
              删除
            </Button>
          </>
        }
      >
        {deleting && deleting.references.length > 0 ? (
          <ul className="reference-list">
            {deleting.references.map((reference, index) => (
              <li key={`${reference.from}:${reference.line}:${index}`}>
                <button
                  type="button"
                  className="reference-item"
                  onClick={() => {
                    setDeleting(null)
                    open(reference.from)
                    setEditorMode('code')
                    setReveal({ line: reference.line, column: 1, key: Date.now() })
                  }}
                >
                  {basename(reference.from)} 第 {reference.line} 行
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </Dialog>

      {historyPath ? (
        <VersionHistory
          bookId={book.id}
          path={historyPath}
          dirtyCount={dirty.size}
          pkg={book.pkg}
          texts={texts.current}
          onClose={() => setHistoryPath(null)}
          onRestored={() => {
            setHistoryPath(null)
            void reload()
          }}
        />
      ) : null}

      <LinkStylesheetsDialog
        open={stylesheetTargets !== null}
        onOpenChange={(openState) => {
          if (!openState) setStylesheetTargets(null)
        }}
        chapterPaths={stylesheetTargets ?? []}
        stylesheets={bookStylesheets}
        linkedByChapter={linkedByChapter}
        onApply={(delta) => {
          if (stylesheetTargets) handleApplyStylesheets(stylesheetTargets, delta)
        }}
        onCreateStylesheet={(filename) => handleCreateStylesheet(filename, false)}
      />

      <UnusedResourcesDialog
        open={unusedDialogOpen}
        onOpenChange={setUnusedDialogOpen}
        resources={unusedResources}
        resolveAsset={resolveAsset}
        onConfirmDelete={handleCleanupUnusedResources}
      />

      {structureToast ? (
        <div
          className="structure-toast"
          role="status"
          aria-live="polite"
          onMouseEnter={() => {
            if (toastTimerRef.current) {
              clearTimeout(toastTimerRef.current)
              toastTimerRef.current = null
            }
          }}
          onMouseLeave={() => {
            const currentId = structureToast.id
            toastTimerRef.current = setTimeout(() => {
              toastTimerRef.current = null
              setStructureToast((cur) => (cur?.id === currentId ? null : cur))
            }, 4000)
          }}
        >
          <span className="structure-toast-msg">{structureToast.message}</span>
          {structureToast.canUndo ? (
            <button type="button" className="structure-toast-undo" onClick={undoStructure}>
              <Undo2 size={13} strokeWidth={1.8} aria-hidden="true" />
              <span>撤销</span>
            </button>
          ) : null}
          <button
            type="button"
            className="structure-toast-close"
            aria-label="关闭提示"
            onClick={() => setStructureToast(null)}
          >
            <X size={13} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        commands={paletteCommands}
      />

      <Dialog
        open={Boolean(staleApplyConfirm)}
        onOpenChange={(openState) => {
          if (!openState) setStaleApplyConfirm(null)
        }}
        ariaLabel="确认应用过时提案"
        title="工作区内容自该提案生成后已更新"
        description="以下文件在提案生成后已有其他修改，继续应用将覆盖它们的当前内容（应用后仍可一键撤销）："
        footer={
          <>
            <Button variant="ghost" type="button" onClick={() => setStaleApplyConfirm(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              type="button"
              onClick={() => {
                const pending = staleApplyConfirm
                setStaleApplyConfirm(null)
                if (pending) {
                  void handleApplyAgentProposal(pending.messageId, pending.proposal, {
                    forceApplyStale: true,
                  })
                }
              }}
            >
              仍然应用
            </Button>
          </>
        }
      >
        {staleApplyConfirm ? (
          <ul className="reference-list">
            {staleApplyConfirm.driftedPaths.map((driftedPath) => (
              <li key={driftedPath}>
                <code>{driftedPath}</code>
              </li>
            ))}
          </ul>
        ) : null}
      </Dialog>

      <SettingsDialog
        open={settingsTab !== null}
        onOpenChange={(open) => {
          if (!open) setSettingsTab(null)
        }}
        initialTab={settingsTab ?? 'general'}
        onAgentProfilesChanged={setAgentProfiles}
        onAgentSettingsChanged={setAgentUserSettings}
      />
    </div>
  )
}
