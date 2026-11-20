import {
  addManifestItem,
  addSpineDocument,
  hasPageHistory,
  browserXmlCodec,
  browserXmlParser,
  collectReferences,
  dirname,
  findBrokenAnchors,
  lintBook,
  parsePackage,
  readNavToc,
  readNcxToc,
  relativePath,
  removeManifestEntry,
  renameManifestEntry,
  reorderSpine,
  setManifestMediaType,
  resolvePath,
  rewriteReferences,
  touchOpfModified,
  writeNavToc,
  writeNcxToc,
  writeOpfMeta,
  writeOpfMetadata,
  zipArchive,
  type AgentProposal,
  type EpubArchive,
  type EpubIssue,
  type OpfMetaRow,
  type SearchFile,
  type TocEntry,
} from '@booksmith/core'
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Check,
  Download,
  FolderTree,
  History,
  ImagePlus,
  ListTree,
  Loader2,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Tags,
} from 'lucide-react'
import { Popover } from 'radix-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api, downloadUrl, type AgentProfileDto } from '../api/client'
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
import { basename, extensionOf, groupFiles, loadBook, proseLength, type LoadedBook } from '../state/bookStore'
import { createAutosave, type Autosave } from '../state/autosave'
import type { ReplacePlan } from '../state/replacePlan'
import { DRAFT_DEBOUNCE_MS, clearDraft, planDraftRestore, readDraft, writeDraft } from '../state/draftStore'
import { getSettings, useSettings } from '../state/settingsStore'
import { AgentPanel } from '../ui/AgentPanel'
import { Button } from '../ui/Button'
import { CheckPanel } from '../ui/CheckPanel'
import { CodePane } from '../ui/CodePane'
import { Dialog } from '../ui/Dialog'
import { EmptyState } from '../ui/EmptyState'
import { FileTree } from '../ui/FileTree'
import { MediaPane } from '../ui/MediaPane'
import { PreviewPane } from '../ui/PreviewPane'
import { MetadataPanel } from '../ui/MetadataPanel'
import { SearchPanel } from '../ui/SearchPanel'
import { SettingsDialog, type SettingsTab } from '../ui/SettingsDialog'
import { TocPanel } from '../ui/TocPanel'
import type { NavigateTarget, RevealTarget } from '../ui/CodePane'
import { StatusBar } from '../ui/StatusBar'
import { TabBar, type EditorViewMode } from '../ui/TabBar'
import { VersionHistory } from '../ui/VersionHistory'
import { WysiwygPane, type WysiwygShortcut } from '../ui/WysiwygPane'

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' }
type NavIslandTab = 'files' | 'toc'

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
  const autosave = useRef<Autosave | null>(null)
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef<Set<string>>(new Set())
  const bookRef = useRef<LoadedBook | null>(null)
  const saveRef = useRef<(options?: { checkpoint?: boolean }) => Promise<void>>(async () => {})
  /** Text and dirty flags from before a book-wide replace, so one click can revert the batch. */
  const replaceUndo = useRef<{ texts: Map<string, string>; dirty: Set<string> } | null>(null)
  const [editorMode, setEditorMode] = useState<EditorViewMode>(() => getSettings().defaultEditorMode)
  const [externalResetVersion, setExternalResetVersion] = useState(0)
  const wysiwygFlushRef = useRef<(() => void) | null>(null)
  const [agentProfiles, setAgentProfiles] = useState<AgentProfileDto[]>([])
  const [agentProfilesLoading, setAgentProfilesLoading] = useState(true)
  const [selectionText, setSelectionText] = useState('')
  const agentUndoRef = useRef<{ messageId: string; snapshot: WorkspaceSnapshot } | null>(null)
  const [agentUndoMessageId, setAgentUndoMessageId] = useState<string | null>(null)
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
    bookRef.current = loaded
    setBook(loaded)
    const first = loaded.groups.find((group) => group.group === 'Text')?.paths[0]
    const initial = first ?? loaded.groups[0]?.paths[0] ?? null
    setTabs(initial ? [initial] : [])
    setActive(initial)
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
    api
      .agentProfiles()
      .then((res) => {
        if (!cancelled) setAgentProfiles(res.profiles)
      })
      .catch(() => {
        if (!cancelled) setAgentProfiles([])
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

  /** Local crash buffer: 1s after the last keystroke, the edited files go to IndexedDB. */
  const scheduleDraft = useCallback(() => {
    if (draftTimer.current) clearTimeout(draftTimer.current)
    draftTimer.current = setTimeout(() => {
      draftTimer.current = null
      const current = bookRef.current
      if (!current) return
      const files: Record<string, string> = {}
      for (const path of dirtyRef.current) {
        const text = texts.current.get(path)
        if (typeof text === 'string') files[path] = text
      }
      if (Object.keys(files).length === 0) return
      void writeDraft(current.id, { baseVersion: current.version, savedAt: Date.now(), files })
    }, DRAFT_DEBOUNCE_MS)
  }, [])

  const handleChange = useCallback(
    (path: string, value: string, options: { rerender?: boolean } = {}) => {
      texts.current.set(path, value)
      for (const listener of textListeners.current) listener(path, value)
      if (!dirtyRef.current.has(path)) {
        const next = new Set(dirtyRef.current)
        next.add(path)
        dirtyRef.current = next
      }
      setDirty((current) => {
        if (current.has(path)) return current
        const next = new Set(current)
        next.add(path)
        return next
      })
      // Typing needs no rerender (the editor owns its document), but a form write into a file that
      // is already dirty does: without this the toc/meta panels keep showing the previous parse.
      if (options.rerender) setRevision((value) => value + 1)
      if (agentUndoRef.current) {
        agentUndoRef.current = null
        setAgentUndoMessageId(null)
      }
      scheduleDraft()
      autosave.current?.touch()
    },
    [scheduleDraft],
  )

  const handleApplyAgentProposal = useCallback(
    async (messageId: string, proposal: AgentProposal, selectedPaths?: Set<string>): Promise<boolean> => {
      wysiwygFlushRef.current?.()
      const current = bookRef.current
      if (!current) return false
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
        })
        if (applied.appliedCount === 0) return false

        agentUndoRef.current = { messageId, snapshot }
        setAgentUndoMessageId(messageId)

        texts.current = applied.texts
        bookRef.current = applied.book
        dirtyRef.current = applied.dirty
        setBook(applied.book)
        setDirty(applied.dirty)
        setTabs(applied.tabs)
        setActive(applied.active)
        setExternalResetVersion((v) => v + 1)
        setRevision((v) => v + 1)
        scheduleDraft()
        autosave.current?.touch()

        await api.updateProposalStatus(current.id, messageId, 'applied').catch(() => {})
        return true
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : '应用变更提案失败')
        return false
      }
    },
    [scheduleDraft],
  )

  const handleUndoAgentProposal = useCallback(
    (messageId: string) => {
      const saved = agentUndoRef.current
      if (!saved || saved.messageId !== messageId) return
      const { snapshot } = saved
      texts.current = new Map(snapshot.texts)
      bookRef.current = snapshot.book
      dirtyRef.current = new Set(snapshot.dirty)
      setBook(snapshot.book)
      setDirty(new Set(snapshot.dirty))
      setTabs([...snapshot.tabs])
      setActive(snapshot.active)
      setExternalResetVersion((v) => v + 1)
      setRevision((v) => v + 1)
      agentUndoRef.current = null
      setAgentUndoMessageId(null)
      scheduleDraft()
      autosave.current?.touch()
    },
    [scheduleDraft],
  )

  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

  const applyReplace = useCallback(
    (plan: ReplacePlan) => {
      if (!bookRef.current) return
      replaceUndo.current = {
        texts: new Map(plan.files.map((file) => [file.path, texts.current.get(file.path) ?? ''])),
        dirty: new Set(dirtyRef.current),
      }
      const nextTexts = new Map(texts.current)
      for (const file of plan.files) nextTexts.set(file.path, file.text)
      texts.current = nextTexts
      setDirty((dirty) => {
        const next = new Set(dirty)
        for (const file of plan.files) next.add(file.path)
        return next
      })
      setExternalResetVersion((v) => v + 1)
      scheduleDraft()
      autosave.current?.touch()
    },
    [scheduleDraft],
  )

  const undoReplace = useCallback(() => {
    const snapshot = replaceUndo.current
    if (!snapshot || !bookRef.current) return
    const nextTexts = new Map(texts.current)
    for (const [path, text] of snapshot.texts) nextTexts.set(path, text)
    texts.current = nextTexts
    // A file that was clean before the batch must be clean again after undoing it.
    setDirty((dirty) => {
      const next = new Set(dirty)
      for (const path of snapshot.texts.keys()) {
        if (snapshot.dirty.has(path)) next.add(path)
        else next.delete(path)
      }
      return next
    })
    replaceUndo.current = null
    setExternalResetVersion((v) => v + 1)
    scheduleDraft()
    autosave.current?.touch()
  }, [scheduleDraft])

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
    const entries = new Map(current.archive.entries)
    entries.set(path, encoder.encode(skeleton))

    const next = refreshPackage(current, nextTexts, entries)
    texts.current = nextTexts
    bookRef.current = next
    setBook(next)
    setDirty((dirty) => new Set(dirty).add(opfPath).add(path))
    open(path)
    scheduleDraft()
    autosave.current?.touch()
  }, [open, scheduleDraft])

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

    const nextTexts = new Map(rewritten.files)
    const moved = nextTexts.get(path)
    nextTexts.delete(path)
    if (moved !== undefined) nextTexts.set(target, moved)
    const changed = [...nextTexts.keys()].filter((entry) => nextTexts.get(entry) !== texts.current.get(entry))

    const next = refreshPackage(current, nextTexts, entries)
    texts.current = nextTexts
    bookRef.current = next
    setBook(next)
    setTabs((list) => list.map((entry) => (entry === path ? target : entry)))
    setActive((activePath) => (activePath === path ? target : activePath))
    setDirty((dirty) => {
      const set = new Set<string>()
      for (const entry of dirty) set.add(entry === path ? target : entry)
      for (const entry of changed) set.add(entry)
      return set
    })
    setExternalResetVersion((v) => v + 1)
    setRenaming(null)
    scheduleDraft()
    autosave.current?.touch()
  }, [renaming, scheduleDraft])

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

    const next = refreshPackage(current, nextTexts, entries)
    texts.current = nextTexts
    bookRef.current = next
    setBook(next)
    const fallback = spinePaths(next.pkg)[0] ?? next.groups[0]?.paths[0] ?? null
    setTabs((list) => list.filter((entry) => entry !== path))
    setActive((activePath) => (activePath === path ? fallback : activePath))
    setDirty((dirty) => {
      const set = new Set(dirty)
      set.delete(path)
      return set
    })
    setDeleting(null)
    scheduleDraft()
    autosave.current?.touch()
  }, [deleting, scheduleDraft])

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
      setDirty((dirty) => new Set(dirty).add(opfPath))
      scheduleDraft()
      autosave.current?.touch()
    },
    [scheduleDraft],
  )

  const navigateTo = useCallback(
    (target: NavigateTarget) => {
      const text = texts.current.get(target.path)
      if (text === undefined) return
      open(target.path)
      if (!target.fragment) {
        setReveal({ line: 1, column: 1, key: Date.now() })
        return
      }
      const index = fragmentIndex(text, target.fragment)
      if (index < 0) return
      setReveal({
        line: lineOf(text, index),
        column: index - text.lastIndexOf('\n', index - 1),
        key: Date.now(),
      })
    },
    [open],
  )

  const reload = useCallback(async () => {
    try {
      const loaded = await loadBook(bookId)
      const previousTabs = tabs
      const previousActive = active
      texts.current = new Map(loaded.texts)
      bookRef.current = loaded
      setBook(loaded)
      setDirty(new Set())
      dirtyRef.current = new Set()
      setExternalResetVersion((v) => v + 1)
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
      const activeDirty = dirtyRef.current
      // Conflict is terminal until the user reloads: retrying would only produce the same 409.
      if (!book || activeDirty.size === 0 || saving || conflict) return
      setSaving(true)
      setSaveState('saving')
      setSaveError(null)
      try {
        // `dcterms:modified` tracks the package document, not every keystroke: refreshing it on each
        // save would make an unchanged book a new revision and fill the snapshot cap with noise.
        // See ADR 2026-11-19-opf-meta-editing.
        if (activeDirty.has(book.pkg.opfPath)) {
          const opfText = texts.current.get(book.pkg.opfPath)
          if (opfText !== undefined) {
            const touched = touchOpfModified(
              opfText,
              new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
              browserXmlCodec,
            )
            if (touched !== opfText) texts.current.set(book.pkg.opfPath, touched)
          }
        }

        const entries = new Map(book.archive.entries)
        const encoder = new TextEncoder()
        for (const path of activeDirty) {
          const text = texts.current.get(path)
          if (typeof text === 'string') entries.set(path, encoder.encode(text))
        }
        const order = [
          ...book.archive.order,
          ...[...entries.keys()].filter((path) => !book.archive.order.includes(path)),
        ]
        const bytes = zipArchive({ order, entries })
        const result = await api.save(book.id, book.version, bytes, options)
        const next = {
          ...book,
          version: result.version,
          archive: { order, entries },
          serverPaths: new Set(entries.keys()),
        }
        bookRef.current = next
        setBook(next)
        dirtyRef.current = new Set()
        setDirty(new Set())
        agentUndoRef.current = null
        setAgentUndoMessageId(null)
        setSaveState('saved')
        setSavedAt(Date.now())
        setServerIssues([])
        if (draftTimer.current) clearTimeout(draftTimer.current)
        void clearDraft(book.id)
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
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
        setSaving(false)
      }
    },
    [book, dirty, saving, conflict],
  )

  const replaceAsset = useCallback(
    (path: string, file: File) => {
      void file.arrayBuffer().then((buffer) => {
        const current = bookRef.current
        if (!current) return

        const entries = new Map(current.archive.entries)
        entries.set(path, new Uint8Array(buffer))

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

        const archive: EpubArchive = { order: archiveOrder(current.archive.order, entries), entries }
        const next = { ...current, archive, groups: groupFiles(current.pkg, archive) }
        bookRef.current = next
        setBook(next)
        // A replaced binary has no text to dirty, so the package document carries the "unsaved" flag.
        setDirty((dirty) => new Set(dirty).add(opfPath))
        scheduleDraft()
        autosave.current?.touch()
      })
    },
    [scheduleDraft],
  )

  const importAsset = useCallback(
    async (file: File) => {
      if (!book) return
      const bytes = new Uint8Array(await file.arrayBuffer())
      const baseDir = dirname(book.pkg.opfPath)
      const safeName = file.name.replace(/[^\w.\-]+/g, '_')
      let target = `${baseDir}/media/${safeName}`
      let counter = 1
      while (book.archive.entries.has(target)) {
        target = `${baseDir}/media/${counter}_${safeName}`
        counter += 1
      }
      const href = target.slice(baseDir.length + 1)
      const id = href.replace(/[/.\-]+/g, '_')

      const opf = texts.current.get(book.pkg.opfPath) ?? ''
      const nextOpf = addManifestItem(opf, { id, href, mediaType: file.type || 'application/octet-stream' }, browserXmlCodec)
      texts.current.set(book.pkg.opfPath, nextOpf)
      setDirty((current) => new Set(current).add(book.pkg.opfPath))

      const entries = new Map(book.archive.entries)
      entries.set(target, bytes)
      const order = book.archive.order.includes(target) ? book.archive.order : [...book.archive.order, target]
      const archive = { order, entries }
      const next = { ...book, archive, groups: groupFiles(book.pkg, archive) }
      bookRef.current = next
      setBook(next)
      scheduleDraft()
      autosave.current?.touch()
      // Binary entries are not editable, so they stay out of the tab strip.
    },
    [book],
  )

  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

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
        setSearchOpen(true)
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
          <span className="boot-text">正在解包 EPUB…</span>
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

  const content = active ? (texts.current.get(active) ?? '') : ''
  // Binary entries (images, fonts) never live in `texts`, so they get a read-only view instead of the editor.
  const editable = active !== null && texts.current.has(active)
  const mediaPane = active ? (
    <MediaPane
      path={active}
      bytes={book.archive.entries.get(active)}
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
      setSearchOpen(true)
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
      return readNavToc(xml, browserXmlCodec)
    } catch {
      return []
    }
  })()
  const brokenAnchors = tocPath ? findBrokenAnchors(tocEntries, tocPath, texts.current) : []
  // Live book health status powers the topbar diagnostic pill and its Radix Popover card.
  // See ADR 2026-11-20-soft-craft-studio-ui.
  const issues = [...serverIssues, ...lintBook(texts.current, book.pkg, book.archive, browserXmlCodec)]
  const showSplitPreview = Boolean(active && editable && previewable && !showWysiwyg && previewOpen)

  const applyDraft = () => {
    if (!draftPrompt) return
    for (const [path, text] of draftPrompt.files) texts.current.set(path, text)
    const nextDirty = new Set(draftPrompt.files.map(([path]) => path))
    dirtyRef.current = nextDirty
    setDirty(nextDirty)
    setExternalResetVersion((v) => v + 1)
    setDraftPrompt(null)
    setDraftSavedAt(null)
    autosave.current?.touch()
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
          title="全书查找与替换（Ctrl/Cmd+Shift+F）"
          onClick={() => setSearchOpen(true)}
        >
          <Search size={13} strokeWidth={1.75} aria-hidden="true" />
          <span className="appbar-tool-label">查找</span>
          <kbd className="appbar-kbd" aria-hidden="true">
            ⌘⇧F
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
                  onOpen={(path, line) => {
                    setCheckOpen(false)
                    open(path)
                    if (line) {
                      setEditorMode('code')
                      setReveal({ line, column: 1, key: Date.now() })
                    }
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
          title="切换 AI 助手（Ctrl/Cmd+Shift+L）"
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
                active={active}
                dirty={dirty}
                spinePaths={spinePaths(book.pkg)}
                onOpen={(path) => {
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
            ) : !tocPath ? (
              <p className="sidebar-note">这本书没有 nav.xhtml 或 toc.ncx，暂时无法编辑目录。</p>
            ) : (
              <TocPanel
                entries={tocEntries}
                broken={brokenAnchors}
                tocPath={tocPath}
                files={spinePaths(book.pkg)}
                suggestTitle={(path) => {
                  const text = texts.current.get(path) ?? ''
                  const match = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(text)
                  return match?.[1]
                    ? match[1].replace(/<[^>]+>/g, '').trim()
                    : basename(path).replace(/\.[^.]+$/, '')
                }}
                onChange={(next) => {
                  if (book.pkg.navPath) {
                    const navXml = texts.current.get(book.pkg.navPath)
                    if (navXml)
                      handleChange(book.pkg.navPath, writeNavToc(navXml, next, browserXmlCodec), { rerender: true })
                  }
                  if (book.pkg.ncxPath) {
                    const ncxXml = texts.current.get(book.pkg.ncxPath)
                    if (ncxXml)
                      handleChange(book.pkg.ncxPath, writeNcxToc(ncxXml, next, browserXmlCodec), { rerender: true })
                  }
                }}
              />
            )}
          </div>
        </aside>

        <div className={`canvas-stage${showSplitPreview ? ' is-split' : ''}`}>
          <div className="document-card editor-column">
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
                  <CodePane
                    path={active}
                    content={content}
                    reveal={reveal}
                    visible={!showWysiwyg}
                    wordWrap={settings.codeWordWrap}
                    syncMode={canWysiwyg ? 'transaction' : 'reset'}
                    resetVersion={externalResetVersion}
                    onNavigate={navigateTo}
                    onSelectionChange={setSelectionText}
                    onChange={(value) => handleChange(active, value)}
                  />
                  {showWysiwyg ? (
                    <WysiwygPane
                      path={active}
                      content={content}
                      archive={book.archive}
                      pkg={book.pkg}
                      externalVersion={externalResetVersion}
                      flushRef={wysiwygFlushRef}
                      onChange={(value) => handleChange(active, value, { rerender: true })}
                      onSwitchToCode={() => switchMode('code')}
                      onNavigateLink={navigateTo}
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
            <section className="preview-card" aria-label="实时书页预览" hidden={!showSplitPreview}>
              <PreviewPane
                path={active}
                content={content}
                archive={book.archive}
                pkg={book.pkg}
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
                undoMessageId={agentUndoMessageId}
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
                onApplyProposal={handleApplyAgentProposal}
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
        description="修改直接写入 OPF 并标脏，⌘S 保存后生效。"
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

      <SettingsDialog
        open={settingsTab !== null}
        onOpenChange={(open) => {
          if (!open) setSettingsTab(null)
        }}
        initialTab={settingsTab ?? 'general'}
        onAgentProfilesChanged={setAgentProfiles}
      />
    </div>
  )
}
