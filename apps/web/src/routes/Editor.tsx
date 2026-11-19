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
  type EpubArchive,
  type EpubIssue,
  type OpfMetaRow,
  type SearchFile,
  type TocEntry,
} from '@booksmith/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api, downloadUrl } from '../api/client'
import { mediaTypeFromExtension, mediaTypeOf } from '../preview/render'
import { spinePaths } from '../diff/document'
import { navigate } from '../router'
import { basename, extensionOf, groupFiles, loadBook, proseLength, type LoadedBook } from '../state/bookStore'
import { createAutosave, type Autosave } from '../state/autosave'
import type { ReplacePlan } from '../state/replacePlan'
import { DRAFT_DEBOUNCE_MS, clearDraft, planDraftRestore, readDraft, writeDraft } from '../state/draftStore'
import { Button } from '../ui/Button'
import { CheckPanel } from '../ui/CheckPanel'
import { CodePane } from '../ui/CodePane'
import { EmptyState } from '../ui/EmptyState'
import { FileTree } from '../ui/FileTree'
import { MediaPane } from '../ui/MediaPane'
import { PreviewPane } from '../ui/PreviewPane'
import { MetadataPanel } from '../ui/MetadataPanel'
import { SearchPanel } from '../ui/SearchPanel'
import { TocPanel } from '../ui/TocPanel'
import type { NavigateTarget, RevealTarget } from '../ui/CodePane'
import { StatusBar } from '../ui/StatusBar'
import { TabBar } from '../ui/TabBar'
import { VersionHistory } from '../ui/VersionHistory'

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' }
type SidebarTab = 'preview' | 'search' | 'metadata' | 'toc' | 'check'

const SIDEBAR_MIN = 400
const SIDEBAR_MAX = 560
const SIDEBAR_TABS: Array<[SidebarTab, string]> = [
  ['preview', '预览'],
  ['search', '查找'],
  ['metadata', '元数据'],
  ['toc', '目录'],
  ['check', '检查'],
]

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
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [book, setBook] = useState<LoadedBook | null>(null)
  const [tabs, setTabs] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [dirty, setDirty] = useState<Set<string>>(new Set())
  const [treeOpen, setTreeOpen] = useState(false)
  const [sideOpen, setSideOpen] = useState(false)
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('preview')
  const [sidebarWidth, setSidebarWidth] = useState(440)
  const [reveal, setReveal] = useState<RevealTarget | null>(null)
  const assetInput = useRef<HTMLInputElement>(null)
  const [saving, setSaving] = useState(false)
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

  const open = useCallback((path: string) => {
    setTabs((current) => (current.includes(path) ? current : [...current, path]))
    setActive(path)
  }, [])

  const close = useCallback((path: string) => {
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
      setDirty((current) => {
        if (current.has(path)) return current
        const next = new Set(current)
        next.add(path)
        return next
      })
      // Typing needs no rerender (the editor owns its document), but a form write into a file that
      // is already dirty does: without this the toc/meta panels keep showing the previous parse.
      if (options.rerender) setRevision((value) => value + 1)
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
      // Conflict is terminal until the user reloads: retrying would only produce the same 409.
      if (!book || dirty.size === 0 || saving || conflict) return
      setSaving(true)
      setSaveState('saving')
      setSaveError(null)
      try {
        // `dcterms:modified` tracks the package document, not every keystroke: refreshing it on each
        // save would make an unchanged book a new revision and fill the snapshot cap with noise.
        // See ADR 2026-11-19-opf-meta-editing.
        if (dirty.has(book.pkg.opfPath)) {
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
        for (const path of dirty) {
          const text = texts.current.get(path)
          if (typeof text === 'string') entries.set(path, encoder.encode(text))
        }
        const order = [
          ...book.archive.order,
          ...[...entries.keys()].filter((path) => !book.archive.order.includes(path)),
        ]
        const bytes = zipArchive({ order, entries })
        const result = await api.save(book.id, book.version, bytes, options)
        const next = { ...book, version: result.version, archive: { order, entries } }
        bookRef.current = next
        setBook(next)
        setDirty(new Set())
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
            // The server's rejection is the most authoritative issue list there is; show it where
            // the rest of the issues live instead of leaving it in one status-bar sentence.
            setServerIssues(reported)
            setSidebarTab('check')
            setSideOpen(true)
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
        setSidebarTab('search')
        setSideOpen(true)
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
          <Button variant="ghost" onClick={() => navigate('/')}>
            ← 书库
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
          <Button variant="ghost" onClick={() => navigate('/')}>
            ← 书库
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
  // Not a hook: this sits below the early returns. Linting only runs while the panel is visible.
  const issues =
    sidebarTab === 'check'
      ? [...serverIssues, ...lintBook(texts.current, book.pkg, book.archive, browserXmlCodec)]
      : []

  const sidebarBody = () => {
    if (sidebarTab === 'preview') {
      if (!active) return <p className="sidebar-note">先打开一个文件。</p>
      if (!editable) return mediaPane
      if (!previewable) {
        return <p className="sidebar-note">当前文件不是页面，切换到 .xhtml 文件查看预览。</p>
      }
      return <PreviewPane path={active} content={content} archive={book.archive} pkg={book.pkg} />
    }
    if (sidebarTab === 'search') {
      return (
        <SearchPanel
          files={searchFiles}
          onOpen={(path, line, column) => {
            open(path)
            setReveal({ line, column, key: Date.now() })
          }}
          onReplace={applyReplace}
          onReplaceUndo={undoReplace}
        />
      )
    }
    if (sidebarTab === 'metadata') {
      return (
        <MetadataPanel
          metadata={book.pkg.metadata}
          opfXml={texts.current.get(book.pkg.opfPath) ?? ''}
          version={book.version}
          onApply={(draft) => {
            handleChange(book.pkg.opfPath, writeOpfMetadata(texts.current.get(book.pkg.opfPath) ?? '', draft, browserXmlCodec))
          }}
          onApplyMeta={(rows: OpfMetaRow[]) => {
            handleChange(
              book.pkg.opfPath,
              writeOpfMeta(texts.current.get(book.pkg.opfPath) ?? '', rows, browserXmlCodec),
              { rerender: true },
            )
          }}
        />
      )
    }
    if (sidebarTab === 'check') {
      return (
        <CheckPanel
          issues={issues}
          onOpen={(path, line) => {
            open(path)
            if (line) setReveal({ line, column: 1, key: Date.now() })
          }}
        />
      )
    }
    if (!tocPath) {
      return <p className="sidebar-note">这本书没有 nav.xhtml 或 toc.ncx，暂时无法编辑目录。</p>
    }
    return (
      <TocPanel
        entries={tocEntries}
        broken={brokenAnchors}
        tocPath={tocPath}
        files={spinePaths(book.pkg)}
        suggestTitle={(path) => {
          const text = texts.current.get(path) ?? ''
          const match = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(text)
          return match?.[1] ? match[1].replace(/<[^>]+>/g, '').trim() : basename(path).replace(/\.[^.]+$/, '')
        }}
        onChange={(next) => {
          if (book.pkg.navPath) {
            const navXml = texts.current.get(book.pkg.navPath)
            if (navXml) handleChange(book.pkg.navPath, writeNavToc(navXml, next, browserXmlCodec), { rerender: true })
          }
          if (book.pkg.ncxPath) {
            const ncxXml = texts.current.get(book.pkg.ncxPath)
            if (ncxXml) handleChange(book.pkg.ncxPath, writeNcxToc(ncxXml, next, browserXmlCodec), { rerender: true })
          }
        }}
      />
    )
  }

  const applyDraft = () => {
    if (!draftPrompt) return
    for (const [path, text] of draftPrompt.files) texts.current.set(path, text)
    setDirty(new Set(draftPrompt.files.map(([path]) => path)))
    setDraftPrompt(null)
    setDraftSavedAt(null)
    autosave.current?.touch()
  }

  const discardDraft = () => {
    setDraftPrompt(null)
    setDraftSavedAt(null)
    void clearDraft(bookId)
  }

  return (
    <div className={`shell${treeOpen ? ' tree-open' : ''}${sideOpen ? ' side-open' : ''}`}>
      <header className="appbar">
        <Button variant="ghost" onClick={() => navigate('/')}>
          ← 书库
        </Button>
        <Button
          variant="ghost"
          className="tree-toggle"
          aria-expanded={treeOpen}
          onClick={() => setTreeOpen((openTree) => !openTree)}
        >
          文件
        </Button>
        <span className="appbar-title" title={book.pkg.metadata.title}>
          {book.pkg.metadata.title}
        </span>
        <button
          type="button"
          className="appbar-meta appbar-history"
          title={active ? `${basename(active)} 的版本历史` : '版本历史'}
          disabled={!active || !hasPageHistory(active)}
          onClick={() => active && setHistoryPath(active)}
        >
          v{book.version}
        </button>
        <span className="appbar-spacer" />
        {saveState === 'error' ? (
          <button type="button" className="appbar-save is-error" onClick={() => void save({ checkpoint: true })}>
            保存失败 · 重试
          </button>
        ) : saving ? (
          <span className="appbar-save is-saving">保存中…</span>
        ) : dirty.size > 0 ? (
          <span className="appbar-flag">{dirty.size} 处未保存</span>
        ) : savedAt ? (
          <span className="appbar-save is-saved">已保存 {clockLabel(savedAt)}</span>
        ) : null}
        <Button
          variant="ghost"
          className="sidebar-toggle"
          aria-expanded={sideOpen}
          onClick={() => setSideOpen((openSide) => !openSide)}
        >
          预览
        </Button>
        <a
          className="btn btn-ghost appbar-download"
          href={downloadUrl(book.id)}
          download
          title={dirty.size > 0 ? `下载已保存的版本（${dirty.size} 个文件未保存）` : '下载这本书的 EPUB'}
        >
          下载
        </a>
        <Button variant="secondary" onClick={() => assetInput.current?.click()}>
          加资源
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
          {saving ? '保存中…' : '保存'}
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
        <div className="editor-column">
          <TabBar tabs={tabs} active={active} dirty={dirty} onSelect={setActive} onClose={close} />
          {active ? (
            editable ? (
              <CodePane
                path={active}
                content={content}
                reveal={reveal}
                onNavigate={navigateTo}
                onChange={(value) => handleChange(active, value)}
              />
            ) : (
              mediaPane
            )
          ) : (
            <div className="code-empty">
              <EmptyState title="没有可编辑的文件" description="这本 EPUB 里没有识别到文本文件。" />
            </div>
          )}
        </div>

        <div
          className="splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整预览宽度"
          onPointerDown={startResize}
        />

        <aside className="sidebar" style={{ width: sidebarWidth }} aria-label="预览与结构">
          <div className="sidebar-tabs" role="tablist">
            {SIDEBAR_TABS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={sidebarTab === key}
                className={`sidebar-tab${sidebarTab === key ? ' on' : ''}`}
                onClick={() => setSidebarTab(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="sidebar-body">{sidebarBody()}</div>
        </aside>
      </div>

      {renaming ? (
        <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="重命名文件">
          <form
            className="dialog"
            onSubmit={(event) => {
              event.preventDefault()
              confirmRename()
            }}
          >
            <h2>重命名 {basename(renaming.path)}</h2>
            <p className="panel-note">
              正文、目录与 manifest 里指向它的引用会一起改，位置在 {dirname(renaming.path)}/。
            </p>
            <label className="panel-field">
              <span>文件名</span>
              <input
                autoFocus
                type="text"
                value={renaming.value}
                onChange={(event) => setRenaming({ ...renaming, value: event.target.value, error: null })}
              />
            </label>
            {renaming.error ? <p className="banner banner-error">{renaming.error}</p> : null}
            <div className="dialog-actions">
              <Button variant="primary" type="submit">
                重命名
              </Button>
              <Button variant="ghost" type="button" onClick={() => setRenaming(null)}>
                取消
              </Button>
            </div>
          </form>
        </div>
      ) : null}

      {deleting ? (
        <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="删除文件">
          <div className="dialog">
            <h2>删除 {basename(deleting.path)}</h2>
            {deleting.references.length === 0 ? (
              <p className="panel-note">没有别的地方引用它。删除后这个文件从书里消失，目录里指向它的条目也会一并移除。</p>
            ) : (
              <>
                <p className="panel-note">
                  还有 {deleting.references.length} 处引用它。删除后这些引用会断开，需要你自己去改：
                </p>
                <ul className="reference-list">
                  {deleting.references.map((reference, index) => (
                    <li key={`${reference.from}:${reference.line}:${index}`}>
                      <button
                        type="button"
                        className="reference-item"
                        onClick={() => {
                          setDeleting(null)
                          open(reference.from)
                          setReveal({ line: reference.line, column: 1, key: Date.now() })
                        }}
                      >
                        {basename(reference.from)} 第 {reference.line} 行
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="dialog-actions">
              <Button variant="primary" onClick={confirmDelete}>
                删除
              </Button>
              <Button variant="ghost" onClick={() => setDeleting(null)}>
                取消
              </Button>
            </div>
          </div>
        </div>
      ) : null}

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

      <StatusBar
        path={active}
        characters={editable ? proseLength(active, content) : null}
        dirtyCount={dirty.size}
      />
    </div>
  )
}
