import {
  browserXmlParser,
  dirname,
  relativePath,
  resolvePath,
  SPLIT_MARKER_CLASS,
  splitFragment,
  type EpubArchive,
  type EpubPackage,
} from '@booksmith/core'
import {
  AlertCircle,
  Bold,
  Code,
  Code2,
  ExternalLink,
  ImagePlus,
  Italic,
  Link2,
  Redo2,
  RemoveFormatting,
  Scissors,
  SeparatorHorizontal,
  Subscript,
  Superscript,
  Trash2,
  Undo2,
  Unlink,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  applyLink,
  clearInlineFormatting,
  currentBlockTag,
  findAncestor,
  findIslandAncestor,
  insertImageAtRange,
  isInlineActive,
  removeAnchor,
  setBlockTag,
  splitHeadingOnEnter,
  toggleInlineFormat,
  type BlockTag,
  type InlineTag,
} from '../editor/wysiwygDom'
import { checkXmlWellFormed, replaceBodyInXhtml, serializeEditableBody } from '../editor/wysiwygXhtml'
import { formatShortcut } from '../editor/shortcuts'
import { patchDocument, patchHead } from '../preview/patchDocument'
import {
  adaptDocumentBodyInlineStyles,
  buildPreviewDocument,
  EMPTY_IFRAME_DOC,
  mediaTypeOf,
  PreviewBlobCache,
  previewResourcesChanged,
  type PreviewAssetResolver,
  type PreviewResourceSnapshot,
} from '../preview/render'
import { basename } from '../state/bookStore'
import { useResolvedTheme } from '../state/settingsStore'
import { Button } from './Button'

export type WysiwygShortcut = 'save' | 'close-tab' | 'next-tab' | 'prev-tab' | 'search' | 'command-palette'

export interface WysiwygPaneProps {
  path: string
  content: string
  archive: EpubArchive
  pkg: EpubPackage
  resolveAsset?: PreviewAssetResolver
  externalVersion?: number
  revealFragment?: { path: string; fragment: string; key: number } | null
  flushRef?: React.MutableRefObject<(() => void) | null>
  onChange: (value: string) => void
  onSwitchToCode: () => void
  onShortcut?: (action: WysiwygShortcut) => void
  onNavigateLink?: (target: { path: string; fragment: string }) => void
  onSplitAtCursor?: (xhtml: string, offset: number) => void
}

type SelectionContext =
  | { kind: 'link'; href: string; el: Element }
  | { kind: 'image'; src: string; alt: string; el: HTMLImageElement }
  | { kind: 'island'; tag: string; el: Element }

interface ActiveToolbarState {
  block: BlockTag | 'other'
  strong: boolean
  em: boolean
  code: boolean
  sup: boolean
  sub: boolean
}

const SYNC_DEBOUNCE_MS = 300
const UNDO_DEBOUNCE_MS = 350
const MAX_UNDO_HISTORY = 50
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|svg)$/i

const DEFAULT_TOOLBAR: ActiveToolbarState = {
  block: 'p',
  strong: false,
  em: false,
  code: false,
  sup: false,
  sub: false,
}

function resolveInBookLink(fromPath: string, rawHref: string): { path: string; fragment: string } | null {
  const { path, fragment } = splitFragment(rawHref.trim())
  if (!path) return { path: fromPath, fragment }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) || path.startsWith('//')) return null
  try {
    return { path: resolvePath(dirname(fromPath), path), fragment }
  } catch {
    return null
  }
}

function clearSelectionMarkers(doc: Document) {
  for (const el of Array.from(doc.querySelectorAll('[data-booksmith-selected]'))) {
    el.removeAttribute('data-booksmith-selected')
  }
}

function scrollWysiwygToFragment(doc: Document, win: Window, fragment: string): void {
  if (!fragment) {
    win.scrollTo(0, 0)
    return
  }
  let decoded = fragment
  try {
    decoded = decodeURIComponent(fragment)
  } catch {
    decoded = fragment
  }
  const target = doc.getElementById(decoded) ?? doc.getElementsByName(decoded)[0] ?? null
  if (target && 'scrollIntoView' in target) {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ;(target as Element).scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
  }
}

export function WysiwygPane({
  path,
  content,
  archive,
  pkg,
  resolveAsset,
  externalVersion = 0,
  revealFragment,
  flushRef,
  onChange,
  onSwitchToCode,
  onShortcut,
  onNavigateLink,
  onSplitAtCursor,
}: WysiwygPaneProps) {
  const [xmlError, setXmlError] = useState<string | null>(() => {
    const check = checkXmlWellFormed(content, browserXmlParser)
    return check.ok ? null : check.message
  })
  const paperTheme = useResolvedTheme()
  const [toolbar, setToolbar] = useState<ActiveToolbarState>(DEFAULT_TOOLBAR)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [context, setContext] = useState<SelectionContext | null>(null)
  const [imageAltDraft, setImageAltDraft] = useState('')
  const [popover, setPopover] = useState<'link' | 'image' | null>(null)
  const [linkDraft, setLinkDraft] = useState('')
  const [linkError, setLinkError] = useState<string | null>(null)
  const [insertAltDraft, setInsertAltDraft] = useState('')

  const frame = useRef<HTMLIFrameElement>(null)
  const blobCache = useRef<PreviewBlobCache>(new PreviewBlobCache())
  const readyDocs = useRef<WeakSet<Document>>(new WeakSet())
  const attachedDoc = useRef<Document | null>(null)
  const savedRange = useRef<Range | null>(null)
  const revealRef = useRef(revealFragment ?? null)
  revealRef.current = revealFragment ?? null
  const appliedRevealKey = useRef<number | null>(null)

  const syncTimer = useRef<number | null>(null)
  const undoTimer = useRef<number | null>(null)
  const undoStack = useRef<string[]>([])
  const undoIndex = useRef(0)
  const hasPendingEdit = useRef(false)

  const lastSyncedXhtml = useRef<string | null>(null)
  const loadedPath = useRef<string | null>(null)
  const loadedExternalVersion = useRef<number | null>(null)
  const loadedDeps = useRef<Map<string, PreviewResourceSnapshot>>(new Map())
  const paperThemeRef = useRef<'light' | 'dark'>(paperTheme)
  paperThemeRef.current = paperTheme
  const latest = useRef({ path, content, archive, pkg, externalVersion, resolveAsset })
  const liveSession = useRef<{ path: string; xhtml: string; islands: string[] }>({
    path,
    xhtml: content,
    islands: [],
  })

  const onChangeRef = useRef(onChange)
  const onShortcutRef = useRef(onShortcut)
  const onSplitAtCursorRef = useRef(onSplitAtCursor)
  onChangeRef.current = onChange
  onShortcutRef.current = onShortcut
  onSplitAtCursorRef.current = onSplitAtCursor

  const clearTimers = useCallback(() => {
    if (syncTimer.current !== null) {
      window.clearTimeout(syncTimer.current)
      syncTimer.current = null
    }
    if (undoTimer.current !== null) {
      window.clearTimeout(undoTimer.current)
      undoTimer.current = null
    }
  }, [])

  const updateUndoFlags = useCallback(() => {
    setCanUndo(undoIndex.current > 0)
    setCanRedo(undoIndex.current < undoStack.current.length - 1)
  }, [])

  const pushUndoSnapshot = useCallback(
    (html: string) => {
      if (undoTimer.current !== null) {
        window.clearTimeout(undoTimer.current)
        undoTimer.current = null
      }
      const stack = undoStack.current
      if (stack[undoIndex.current] === html) return
      const sliced = stack.slice(0, undoIndex.current + 1)
      sliced.push(html)
      if (sliced.length > MAX_UNDO_HISTORY) {
        sliced.shift()
      }
      undoStack.current = sliced
      undoIndex.current = sliced.length - 1
      updateUndoFlags()
    },
    [updateUndoFlags],
  )

  const scheduleUndoSnapshot = useCallback(() => {
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current)
    undoTimer.current = window.setTimeout(() => {
      undoTimer.current = null
      const body = frame.current?.contentDocument?.body
      if (body) pushUndoSnapshot(body.innerHTML)
    }, UNDO_DEBOUNCE_MS)
  }, [pushUndoSnapshot])

  const emitNow = useCallback(() => {
    if (syncTimer.current !== null) {
      window.clearTimeout(syncTimer.current)
      syncTimer.current = null
    }
    if (!hasPendingEdit.current) return
    hasPendingEdit.current = false
    const body = frame.current?.contentDocument?.body
    if (!body) return
    const session = liveSession.current
    const serializedBody = serializeEditableBody(body, session.xhtml, session.islands)
    const nextXhtml = replaceBodyInXhtml(session.xhtml, serializedBody)
    if (nextXhtml === session.xhtml) return
    session.xhtml = nextXhtml
    lastSyncedXhtml.current = nextXhtml
    onChangeRef.current(nextXhtml)
  }, [])

  const scheduleSync = useCallback(() => {
    if (syncTimer.current !== null) window.clearTimeout(syncTimer.current)
    syncTimer.current = window.setTimeout(() => {
      syncTimer.current = null
      emitNow()
    }, SYNC_DEBOUNCE_MS)
  }, [emitNow])

  useEffect(() => {
    if (!flushRef) return
    flushRef.current = emitNow
    return () => {
      if (flushRef.current === emitNow) flushRef.current = null
    }
  }, [flushRef, emitNow])

  const refreshToolbar = useCallback(() => {
    const doc = frame.current?.contentDocument
    if (!doc?.body) return
    const sel = doc.defaultView?.getSelection() ?? null
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0)
      if (doc.body.contains(range.startContainer)) {
        savedRange.current = range.cloneRange()
      }
    }
    setToolbar({
      block: currentBlockTag(sel, doc.body),
      strong: isInlineActive(sel, doc.body, 'strong'),
      em: isInlineActive(sel, doc.body, 'em'),
      code: isInlineActive(sel, doc.body, 'code'),
      sup: isInlineActive(sel, doc.body, 'sup'),
      sub: isInlineActive(sel, doc.body, 'sub'),
    })
  }, [])

  const restoreRange = useCallback((doc: Document): Selection | null => {
    const win = doc.defaultView
    const sel = win?.getSelection() ?? null
    if (!sel) return null
    if (savedRange.current && doc.body.contains(savedRange.current.startContainer)) {
      sel.removeAllRanges()
      sel.addRange(savedRange.current)
    } else if (sel.rangeCount === 0) {
      const range = doc.createRange()
      range.selectNodeContents(doc.body)
      range.collapse(false)
      sel.addRange(range)
    }
    doc.body.focus()
    return sel
  }, [])

  const commitDomMutation = useCallback(
    (doc: Document) => {
      hasPendingEdit.current = true
      pushUndoSnapshot(doc.body.innerHTML)
      refreshToolbar()
      scheduleSync()
    },
    [pushUndoSnapshot, refreshToolbar, scheduleSync],
  )

  const undo = useCallback(() => {
    const doc = frame.current?.contentDocument
    if (!doc?.body) return
    if (undoTimer.current !== null) {
      window.clearTimeout(undoTimer.current)
      undoTimer.current = null
      pushUndoSnapshot(doc.body.innerHTML)
    }
    if (undoIndex.current <= 0) return
    undoIndex.current -= 1
    doc.body.innerHTML = undoStack.current[undoIndex.current] ?? ''
    adaptDocumentBodyInlineStyles(doc.body, paperThemeRef.current, true)
    hasPendingEdit.current = true
    setContext(null)
    updateUndoFlags()
    refreshToolbar()
    scheduleSync()
  }, [pushUndoSnapshot, refreshToolbar, scheduleSync, updateUndoFlags])

  const redo = useCallback(() => {
    const doc = frame.current?.contentDocument
    if (!doc?.body) return
    if (undoIndex.current >= undoStack.current.length - 1) return
    undoIndex.current += 1
    doc.body.innerHTML = undoStack.current[undoIndex.current] ?? ''
    adaptDocumentBodyInlineStyles(doc.body, paperThemeRef.current, true)
    hasPendingEdit.current = true
    setContext(null)
    updateUndoFlags()
    refreshToolbar()
    scheduleSync()
  }, [refreshToolbar, scheduleSync, updateUndoFlags])

  const applyInline = useCallback(
    (tag: InlineTag) => {
      const doc = frame.current?.contentDocument
      if (!doc?.body) return
      const sel = restoreRange(doc)
      if (!sel) return
      if (toggleInlineFormat(doc, sel, doc.body, tag)) {
        commitDomMutation(doc)
      }
    },
    [commitDomMutation, restoreRange],
  )

  const applyBlock = useCallback(
    (tag: BlockTag) => {
      const doc = frame.current?.contentDocument
      if (!doc?.body) return
      const sel = restoreRange(doc)
      if (!sel) return
      if (setBlockTag(doc, sel, doc.body, tag)) {
        commitDomMutation(doc)
      }
    },
    [commitDomMutation, restoreRange],
  )

  const handleClearFormatting = useCallback(() => {
    const doc = frame.current?.contentDocument
    if (!doc?.body) return
    const sel = restoreRange(doc)
    if (!sel) return
    if (clearInlineFormatting(sel, doc.body)) {
      commitDomMutation(doc)
    }
  }, [commitDomMutation, restoreRange])

  const handleInsertSplitMarker = useCallback(() => {
    const doc = frame.current?.contentDocument
    if (!doc?.body) return
    const sel = restoreRange(doc)
    if (!sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0).cloneRange()
    const island = findIslandAncestor(range.startContainer, doc.body)
    if (island) {
      range.setStartBefore(island)
      range.collapse(true)
    } else {
      range.collapse(true)
    }
    const marker = doc.createElement('hr')
    marker.setAttribute('class', SPLIT_MARKER_CLASS)
    range.insertNode(marker)
    const after = doc.createRange()
    after.setStartAfter(marker)
    after.collapse(true)
    sel.removeAllRanges()
    sel.addRange(after)
    commitDomMutation(doc)
  }, [commitDomMutation, restoreRange])

  const handleSplitAtCursor = useCallback(() => {
    if (!onSplitAtCursorRef.current) return
    const doc = frame.current?.contentDocument
    if (!doc?.body) return
    const sel = restoreRange(doc)
    if (!sel || sel.rangeCount === 0) return

    const range = sel.getRangeAt(0).cloneRange()
    const island = findIslandAncestor(range.startContainer, doc.body)
    if (island) {
      range.setStartBefore(island)
      range.collapse(true)
    } else {
      range.collapse(true)
    }

    // Insert a temporary sentinel so WYSIWYG shares the exact `@booksmith/core` XML split engine.
    // See ADR 2026-11-21-chapter-structure-and-resource-tools.
    const sentinelClass = 'booksmith-cursor-split-sentinel'
    const sentinel = doc.createElement('hr')
    sentinel.setAttribute('class', sentinelClass)
    range.insertNode(sentinel)

    const session = liveSession.current
    const serializedBody = serializeEditableBody(doc.body, session.xhtml, session.islands)
    const withSentinel = replaceBodyInXhtml(session.xhtml, serializedBody)
    sentinel.remove()

    const sentinelTag = `<hr class="${sentinelClass}" />`
    const offset = withSentinel.indexOf(sentinelTag)
    if (offset < 0) return
    const cleanXhtml = withSentinel.slice(0, offset) + withSentinel.slice(offset + sentinelTag.length)

    // Sync any pending visual edits before delegating the split to the workspace handler.
    if (hasPendingEdit.current && cleanXhtml !== session.xhtml) {
      hasPendingEdit.current = false
      session.xhtml = cleanXhtml
      lastSyncedXhtml.current = cleanXhtml
      onChangeRef.current(cleanXhtml)
    }
    onSplitAtCursorRef.current(cleanXhtml, offset)
  }, [restoreRange])

  const frameListenersCleanup = useRef<(() => void) | null>(null)

  const isDocReady = useCallback((): boolean => {
    const doc = frame.current?.contentDocument
    if (!doc?.documentElement || !doc.body) return false
    return doc.documentElement.hasAttribute('data-booksmith-shell') || readyDocs.current.has(doc)
  }, [])

  const attachFrameListeners = useCallback(
    (doc: Document) => {
      if (attachedDoc.current === doc || !doc.body) return
      frameListenersCleanup.current?.()

      const onInput = () => {
        hasPendingEdit.current = true
        scheduleUndoSnapshot()
        scheduleSync()
        refreshToolbar()
      }

      const onSelectionChange = () => {
        refreshToolbar()
      }

      const onClick = (event: MouseEvent) => {
        const target = event.target as Node | null
        if (!target || !doc.body) return
        clearSelectionMarkers(doc)

        const island = findIslandAncestor(target, doc.body)
        if (island) {
          event.preventDefault()
          island.setAttribute('data-booksmith-selected', 'true')
          setContext({ kind: 'island', tag: island.tagName.toLowerCase(), el: island })
          setPopover(null)
          return
        }

        const targetEl = target.nodeType === 1 ? (target as Element) : target.parentElement
        if (targetEl && targetEl.tagName.toLowerCase() === 'img') {
          const img = targetEl as HTMLImageElement
          img.setAttribute('data-booksmith-selected', 'true')
          const rawSrc = img.getAttribute('data-booksmith-src') ?? img.getAttribute('src') ?? ''
          const rawAlt = img.hasAttribute('data-booksmith-no-alt')
            ? ''
            : (img.getAttribute('data-booksmith-orig-alt') ?? img.getAttribute('alt') ?? '')
          setImageAltDraft(rawAlt)
          setContext({ kind: 'image', src: rawSrc, alt: rawAlt, el: img })
          setPopover(null)
          return
        }

        const anchor = findAncestor(target, doc.body, (el) => el.tagName.toLowerCase() === 'a')
        if (anchor) {
          event.preventDefault()
          anchor.setAttribute('data-booksmith-selected', 'true')
          setContext({ kind: 'link', href: anchor.getAttribute('href') ?? '', el: anchor })
          setPopover(null)
          return
        }

        setContext(null)
      }

      const onKeyDown = (event: KeyboardEvent) => {
        const modifier = event.metaKey || event.ctrlKey
        if (event.ctrlKey && event.key === 'Tab') {
          event.preventDefault()
          emitNow()
          onShortcutRef.current?.(event.shiftKey ? 'prev-tab' : 'next-tab')
          return
        }
        if (modifier) {
          const key = event.key.toLowerCase()
          if (key === 's' && !event.shiftKey) {
            event.preventDefault()
            emitNow()
            onShortcutRef.current?.('save')
            return
          }
          if (key === 'w' && !event.shiftKey) {
            event.preventDefault()
            emitNow()
            onShortcutRef.current?.('close-tab')
            return
          }
          if (key === 'f' && event.shiftKey) {
            event.preventDefault()
            onShortcutRef.current?.('search')
            return
          }
          if (key === 'k' && !event.shiftKey) {
            event.preventDefault()
            onShortcutRef.current?.('command-palette')
            return
          }
          if (key === 'b' && !event.shiftKey) {
            event.preventDefault()
            applyInline('strong')
            return
          }
          if (key === 'i' && !event.shiftKey) {
            event.preventDefault()
            applyInline('em')
            return
          }
          if (key === 'z') {
            event.preventDefault()
            if (event.shiftKey) redo()
            else undo()
            return
          }
          if (key === 'y' && event.ctrlKey && !event.metaKey) {
            event.preventDefault()
            redo()
            return
          }
          if (event.key === 'Enter') {
            event.preventDefault()
            if (event.shiftKey) handleInsertSplitMarker()
            else handleSplitAtCursor()
            return
          }
        }

        if (event.key === 'Enter' && !event.shiftKey) {
          const sel = doc.defaultView?.getSelection()
          if (sel && doc.body && splitHeadingOnEnter(doc, sel, doc.body)) {
            event.preventDefault()
            commitDomMutation(doc)
          }
        }
      }

      doc.body.addEventListener('input', onInput)
      doc.body.addEventListener('click', onClick)
      doc.body.addEventListener('keyup', onSelectionChange)
      doc.body.addEventListener('mouseup', onSelectionChange)
      doc.addEventListener('selectionchange', onSelectionChange)
      doc.addEventListener('keydown', onKeyDown)
      attachedDoc.current = doc

      frameListenersCleanup.current = () => {
        doc.body?.removeEventListener('input', onInput)
        doc.body?.removeEventListener('click', onClick)
        doc.body?.removeEventListener('keyup', onSelectionChange)
        doc.body?.removeEventListener('mouseup', onSelectionChange)
        doc.removeEventListener('selectionchange', onSelectionChange)
        doc.removeEventListener('keydown', onKeyDown)
        if (attachedDoc.current === doc) attachedDoc.current = null
      }
    },
    [
      applyInline,
      commitDomMutation,
      emitNow,
      handleInsertSplitMarker,
      handleSplitAtCursor,
      redo,
      refreshToolbar,
      scheduleSync,
      scheduleUndoSnapshot,
      undo,
    ],
  )

  const syncResourcesInPlace = useCallback(
    (
      doc: Document,
      nextPath: string,
      nextContent: string,
      nextArchive: EpubArchive,
      nextPkg: EpubPackage,
      nextResolveAsset?: PreviewAssetResolver,
    ) => {
      const built = buildPreviewDocument({
        xhtml: nextContent,
        path: nextPath,
        archive: nextArchive,
        pkg: nextPkg,
        editable: { paperTheme: paperThemeRef.current },
        blobCache: blobCache.current,
        resolveAsset: nextResolveAsset,
      })
      patchHead(doc, built.doc)

      if (doc.body) {
        const base = dirname(nextPath)
        for (const img of Array.from(doc.body.querySelectorAll('img[data-booksmith-src]'))) {
          const rawSrc = img.getAttribute('data-booksmith-src')
          if (!rawSrc) continue
          const targetPath = resolvePath(base, rawSrc)
          const resolved = nextResolveAsset?.(targetPath)
          let url: string | null = null
          if (resolved?.kind === 'url') {
            built.dependencies.set(targetPath, { bytes: undefined, assetKey: resolved.key, mime: resolved.mime })
            url = resolved.url
          } else {
            const bytes = resolved?.kind === 'bytes' ? resolved.bytes : nextArchive.entries.get(targetPath)
            const mime = resolved?.kind === 'bytes' ? resolved.mime : mediaTypeOf(targetPath, nextPkg)
            built.dependencies.set(targetPath, { bytes, mime })
            if (bytes) url = blobCache.current.urlFor(targetPath, bytes, mime)
          }

          if (url) {
            if (img.getAttribute('src') !== url) img.setAttribute('src', url)
            if (img.hasAttribute('data-missing')) {
              if (img.hasAttribute('data-booksmith-no-alt')) {
                img.removeAttribute('alt')
                img.removeAttribute('data-booksmith-no-alt')
              } else if (img.hasAttribute('data-booksmith-orig-alt')) {
                img.setAttribute('alt', img.getAttribute('data-booksmith-orig-alt') ?? '')
                img.removeAttribute('data-booksmith-orig-alt')
              }
              img.removeAttribute('data-missing')
            }
          } else if (!img.hasAttribute('data-missing')) {
            const existingAlt = img.getAttribute('alt')
            if (existingAlt === null) {
              img.setAttribute('data-booksmith-no-alt', 'true')
            } else {
              img.setAttribute('data-booksmith-orig-alt', existingAlt)
            }
            img.setAttribute('alt', `${existingAlt ?? ''}（缺失图片：${rawSrc}）`)
            img.removeAttribute('src')
            img.setAttribute('data-missing', 'true')
          }
        }
      }

      loadedDeps.current = built.dependencies
      blobCache.current.flushObsolete(nextArchive)
    },
    [],
  )

  const loadDocumentIntoFrame = useCallback(
    (
      nextPath: string,
      nextContent: string,
      nextArchive: EpubArchive,
      nextPkg: EpubPackage,
      nextExternalVersion: number,
      nextResolveAsset?: PreviewAssetResolver,
    ) => {
      const iframe = frame.current
      const doc = iframe?.contentDocument
      const win = iframe?.contentWindow
      if (!iframe || !doc?.body || !win || !isDocReady()) return

      const samePath = loadedPath.current === nextPath
      let preservedScrollRatio = 0
      if (samePath) {
        const scrollable = doc.documentElement.scrollHeight - win.innerHeight
        preservedScrollRatio = scrollable > 0 ? win.scrollY / scrollable : 0
      }

      const built = buildPreviewDocument({
        xhtml: nextContent,
        path: nextPath,
        archive: nextArchive,
        pkg: nextPkg,
        editable: { paperTheme: paperThemeRef.current },
        blobCache: blobCache.current,
        resolveAsset: nextResolveAsset,
      })

      readyDocs.current.add(doc)
      patchDocument(doc, built.doc)
      blobCache.current.flushObsolete(nextArchive)
      attachFrameListeners(doc)

      liveSession.current = { path: nextPath, xhtml: nextContent, islands: built.islands }
      lastSyncedXhtml.current = nextContent
      loadedPath.current = nextPath
      loadedExternalVersion.current = nextExternalVersion
      loadedDeps.current = built.dependencies
      savedRange.current = null
      hasPendingEdit.current = false

      const pending = revealRef.current
      if (pending && pending.path === nextPath && appliedRevealKey.current !== pending.key) {
        appliedRevealKey.current = pending.key
        if (!samePath) win.getSelection()?.removeAllRanges()
        scrollWysiwygToFragment(doc, win, pending.fragment)
      } else if (!samePath) {
        win.getSelection()?.removeAllRanges()
        win.scrollTo(0, 0)
      } else if (preservedScrollRatio > 0) {
        const nextScrollable = doc.documentElement.scrollHeight - win.innerHeight
        if (nextScrollable > 0) win.scrollTo(0, preservedScrollRatio * nextScrollable)
      }

      undoStack.current = [doc.body.innerHTML]
      undoIndex.current = 0
      updateUndoFlags()
      refreshToolbar()
      setContext(null)
      setPopover(null)
    },
    [attachFrameListeners, isDocReady, refreshToolbar, updateUndoFlags],
  )

  const handleFrameLoad = useCallback(() => {
    const doc = frame.current?.contentDocument
    if (doc) readyDocs.current.add(doc)
    const cur = latest.current
    const wellFormed = checkXmlWellFormed(cur.content, browserXmlParser)
    if (!wellFormed.ok) {
      setXmlError(wellFormed.message)
      return
    }
    loadDocumentIntoFrame(cur.path, cur.content, cur.archive, cur.pkg, cur.externalVersion, cur.resolveAsset)
  }, [loadDocumentIntoFrame])

  useEffect(() => {
    if (!revealFragment || revealFragment.path !== path) return
    if (appliedRevealKey.current === revealFragment.key) return
    const doc = frame.current?.contentDocument
    const win = frame.current?.contentWindow
    if (!doc || !win || !isDocReady() || loadedPath.current !== path) return
    appliedRevealKey.current = revealFragment.key
    scrollWysiwygToFragment(doc, win, revealFragment.fragment)
  }, [revealFragment?.key, revealFragment?.path, revealFragment?.fragment, path, isDocReady])

  useEffect(() => {
    paperThemeRef.current = paperTheme
    const doc = frame.current?.contentDocument
    if (!doc?.head || !doc.body || !isDocReady() || loadedPath.current !== path) return
    const cur = latest.current
    const built = buildPreviewDocument({
      xhtml: liveSession.current.xhtml,
      path: cur.path,
      archive: cur.archive,
      pkg: cur.pkg,
      editable: { paperTheme },
      blobCache: blobCache.current,
      resolveAsset: cur.resolveAsset,
    })
    patchHead(doc, built.doc)
    adaptDocumentBodyInlineStyles(doc.body, paperTheme, true)
    blobCache.current.flushObsolete(cur.archive)
  }, [paperTheme, path, isDocReady])

  useEffect(() => {
    latest.current = { path, content, archive, pkg, externalVersion, resolveAsset }

    const isSameSession =
      loadedPath.current === path &&
      liveSession.current.path === path &&
      content === lastSyncedXhtml.current &&
      loadedExternalVersion.current === externalVersion

    if (isSameSession) {
      if (!previewResourcesChanged(loadedDeps.current, archive, pkg, resolveAsset)) return
      const doc = frame.current?.contentDocument
      if (doc && isDocReady()) {
        syncResourcesInPlace(doc, path, content, archive, pkg, resolveAsset)
      }
      return
    }

    // Flush any pending edits before loading a new document or external reset.
    if (hasPendingEdit.current) {
      emitNow()
    }
    hasPendingEdit.current = false
    clearTimers()

    const wellFormed = checkXmlWellFormed(content, browserXmlParser)
    if (!wellFormed.ok) {
      frameListenersCleanup.current?.()
      loadedPath.current = null
      setXmlError(wellFormed.message)
      setContext(null)
      setPopover(null)
      return
    }

    if (xmlError !== null) {
      setXmlError(null)
      return
    }

    loadDocumentIntoFrame(path, content, archive, pkg, externalVersion, resolveAsset)
  }, [
    path,
    content,
    archive,
    pkg,
    resolveAsset,
    externalVersion,
    xmlError,
    clearTimers,
    emitNow,
    isDocReady,
    loadDocumentIntoFrame,
    syncResourcesInPlace,
  ])

  useEffect(() => {
    return () => {
      if (syncTimer.current !== null) emitNow()
      clearTimers()
      frameListenersCleanup.current?.()
      loadedPath.current = null
      blobCache.current.dispose()
    }
  }, [clearTimers, emitNow])

  const bookImages = useMemo(() => {
    const items: Array<{ path: string; relativeHref: string }> = []
    const base = dirname(path)
    for (const entryPath of archive.order) {
      if (!IMAGE_EXTENSION.test(entryPath)) continue
      items.push({
        path: entryPath,
        relativeHref: relativePath(base, entryPath),
      })
    }
    return items
  }, [archive, path])

  const imageThumbnails = useMemo(() => {
    if (popover !== 'image') return { urls: new Map<string, string>(), blobs: [] as string[] }
    const urls = new Map<string, string>()
    const blobs: string[] = []
    for (const item of bookImages) {
      const resolved = resolveAsset?.(item.path)
      if (resolved?.kind === 'url') {
        urls.set(item.path, resolved.url)
        continue
      }
      const bytes = resolved?.kind === 'bytes' ? resolved.bytes : archive.entries.get(item.path)
      if (!bytes) continue
      const mime = resolved?.kind === 'bytes' ? resolved.mime : mediaTypeOf(item.path, pkg)
      const copy = new Uint8Array(bytes.length)
      copy.set(bytes)
      const url = URL.createObjectURL(new Blob([copy.buffer], { type: mime }))
      urls.set(item.path, url)
      blobs.push(url)
    }
    return { urls, blobs }
  }, [popover, bookImages, archive, pkg, resolveAsset])

  useEffect(() => {
    return () => {
      for (const url of imageThumbnails.blobs) URL.revokeObjectURL(url)
    }
  }, [imageThumbnails])

  const openLinkPopover = () => {
    if (popover === 'link') {
      setPopover(null)
      return
    }
    const doc = frame.current?.contentDocument
    const sel = doc?.defaultView?.getSelection()
    const existingAnchor =
      context?.kind === 'link'
        ? context.el
        : doc?.body && sel?.anchorNode
          ? findAncestor(sel.anchorNode, doc.body, (el) => el.tagName.toLowerCase() === 'a')
          : null
    setLinkDraft(existingAnchor?.getAttribute('href') ?? '')
    setLinkError(null)
    setPopover('link')
  }

  const submitLink = (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = linkDraft.trim()
    if (!trimmed) {
      setLinkError('请输入链接地址（如 ch004.xhtml#sec1 或 https://...）')
      return
    }
    const doc = frame.current?.contentDocument
    if (!doc?.body) return
    if (context?.kind === 'link') {
      context.el.setAttribute('href', trimmed)
      setContext({ ...context, href: trimmed })
      setPopover(null)
      commitDomMutation(doc)
      return
    }
    const sel = restoreRange(doc)
    if (!sel) return
    if (applyLink(doc, sel, doc.body, trimmed)) {
      setPopover(null)
      commitDomMutation(doc)
    }
  }

  const handleUnlink = () => {
    const doc = frame.current?.contentDocument
    if (!doc?.body) return
    const anchor =
      context?.kind === 'link'
        ? context.el
        : savedRange.current
          ? findAncestor(savedRange.current.commonAncestorContainer, doc.body, (el) => el.tagName.toLowerCase() === 'a')
          : null
    if (anchor && removeAnchor(anchor)) {
      setContext(null)
      setPopover(null)
      commitDomMutation(doc)
    }
  }

  const handleInsertImage = (targetPath: string, relativeHref: string) => {
    const doc = frame.current?.contentDocument
    if (!doc?.body) return
    const resolved = resolveAsset?.(targetPath)
    let imgUrl: string | null = null
    if (resolved?.kind === 'url') {
      imgUrl = resolved.url
      loadedDeps.current.set(targetPath, { bytes: undefined, assetKey: resolved.key, mime: resolved.mime })
    } else {
      const bytes = resolved?.kind === 'bytes' ? resolved.bytes : archive.entries.get(targetPath)
      if (!bytes) return
      const mime = resolved?.kind === 'bytes' ? resolved.mime : mediaTypeOf(targetPath, pkg)
      imgUrl = blobCache.current.urlFor(targetPath, bytes, mime)
      loadedDeps.current.set(targetPath, { bytes, mime })
    }

    const sel = restoreRange(doc)
    if (!sel || sel.rangeCount === 0) return
    const altText = insertAltDraft.trim() || basename(targetPath).replace(/\.[^.]+$/, '')
    insertImageAtRange(doc, sel.getRangeAt(0), imgUrl, relativeHref, altText)
    setInsertAltDraft('')
    setPopover(null)
    commitDomMutation(doc)
  }

  const handleUpdateImageAlt = (event: React.FormEvent) => {
    event.preventDefault()
    const doc = frame.current?.contentDocument
    if (!doc?.body || context?.kind !== 'image') return
    const img = context.el
    const nextAlt = imageAltDraft.trim()
    img.removeAttribute('data-booksmith-no-alt')
    if (img.hasAttribute('data-missing')) {
      img.setAttribute('data-booksmith-orig-alt', nextAlt)
      img.setAttribute('alt', `${nextAlt}（缺失图片：${context.src}）`)
    } else {
      img.setAttribute('alt', nextAlt)
    }
    setContext({ ...context, alt: nextAlt })
    commitDomMutation(doc)
  }

  const handleDeleteImage = () => {
    const doc = frame.current?.contentDocument
    if (!doc?.body || context?.kind !== 'image') return
    context.el.remove()
    setContext(null)
    commitDomMutation(doc)
  }

  if (xmlError) {
    return (
      <div className="wysiwyg-error-stage">
        <div className="banner banner-error wysiwyg-error-banner" role="alert">
          <AlertCircle size={15} strokeWidth={1.75} aria-hidden="true" />
          <span className="wysiwyg-error-text">{xmlError}</span>
          <Button variant="secondary" size="sm" onClick={onSwitchToCode}>
            切回代码修复
          </Button>
        </div>
      </div>
    )
  }

  const resolvedTarget = context?.kind === 'link' ? resolveInBookLink(path, context.href) : null

  return (
    <div className="wysiwyg-pane" data-path={path}>
      <div className="wysiwyg-toolbar" role="toolbar" aria-label="可视化格式工具栏">
        <select
          className="wysiwyg-block-select"
          aria-label="段落格式"
          value={toolbar.block}
          onChange={(event) => {
            const val = event.target.value
            if (val !== 'other') applyBlock(val as BlockTag)
          }}
        >
          <option value="p">正文</option>
          <option value="h1">标题 1</option>
          <option value="h2">标题 2</option>
          <option value="h3">标题 3</option>
          <option value="h4">标题 4</option>
          {toolbar.block === 'other' ? <option value="other">特殊块</option> : null}
        </select>

        <span className="wysiwyg-sep" aria-hidden="true" />

        <button
          type="button"
          className={`wysiwyg-tool${toolbar.strong ? ' on' : ''}`}
          aria-pressed={toolbar.strong}
          aria-label="加粗"
          title={`加粗 (${formatShortcut('Mod+B')})`}
          onClick={() => applyInline('strong')}
        >
          <Bold size={14} strokeWidth={1.85} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`wysiwyg-tool${toolbar.em ? ' on' : ''}`}
          aria-pressed={toolbar.em}
          aria-label="斜体"
          title={`斜体 (${formatShortcut('Mod+I')})`}
          onClick={() => applyInline('em')}
        >
          <Italic size={14} strokeWidth={1.85} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`wysiwyg-tool${toolbar.code ? ' on' : ''}`}
          aria-pressed={toolbar.code}
          aria-label="行内代码"
          title="行内代码"
          onClick={() => applyInline('code')}
        >
          <Code size={14} strokeWidth={1.85} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`wysiwyg-tool${toolbar.sup ? ' on' : ''}`}
          aria-pressed={toolbar.sup}
          aria-label="上标"
          title="上标"
          onClick={() => applyInline('sup')}
        >
          <Superscript size={14} strokeWidth={1.85} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`wysiwyg-tool${toolbar.sub ? ' on' : ''}`}
          aria-pressed={toolbar.sub}
          aria-label="下标"
          title="下标"
          onClick={() => applyInline('sub')}
        >
          <Subscript size={14} strokeWidth={1.85} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="wysiwyg-tool"
          aria-label="清除行内格式"
          title="清除行内格式"
          onClick={handleClearFormatting}
        >
          <RemoveFormatting size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>

        <span className="wysiwyg-sep" aria-hidden="true" />

        <button
          type="button"
          className={`wysiwyg-tool${popover === 'link' ? ' on' : ''}`}
          aria-pressed={popover === 'link'}
          aria-label="插入或编辑链接"
          title="插入或编辑链接"
          onClick={openLinkPopover}
        >
          <Link2 size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`wysiwyg-tool${popover === 'image' ? ' on' : ''}`}
          aria-pressed={popover === 'image'}
          aria-label="插入书内图片"
          title="插入书内图片"
          onClick={() => setPopover((cur) => (cur === 'image' ? null : 'image'))}
        >
          <ImagePlus size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>

        {onSplitAtCursor ? (
          <>
            <span className="wysiwyg-sep" aria-hidden="true" />
            <button
              type="button"
              className="wysiwyg-tool"
              aria-label="在光标处拆分章节"
              title={`在光标处拆分章节 (${formatShortcut('Mod+Enter')})`}
              onClick={handleSplitAtCursor}
            >
              <Scissors size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="wysiwyg-tool"
              aria-label="插入拆分标记"
              title={`插入拆分标记 (${formatShortcut('Mod+Shift+Enter')})`}
              onClick={handleInsertSplitMarker}
            >
              <SeparatorHorizontal size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </>
        ) : null}

        <span className="wysiwyg-sep" aria-hidden="true" />

        <button
          type="button"
          className="wysiwyg-tool"
          disabled={!canUndo}
          aria-label="撤销"
          title={`撤销 (${formatShortcut('Mod+Z')})`}
          onClick={undo}
        >
          <Undo2 size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="wysiwyg-tool"
          disabled={!canRedo}
          aria-label="重做"
          title={`重做 (${formatShortcut('Mod+Shift+Z')})`}
          onClick={redo}
        >
          <Redo2 size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>

      {popover === 'link' ? (
        <form className="wysiwyg-popover" onSubmit={submitLink}>
          <label className="wysiwyg-popover-field">
            <span>链接地址</span>
            <input
              autoFocus
              type="text"
              placeholder="例如 ch004.xhtml#sec1 或 https://..."
              aria-invalid={linkError ? 'true' : undefined}
              value={linkDraft}
              onChange={(event) => {
                setLinkDraft(event.target.value)
                setLinkError(null)
              }}
            />
          </label>
          <div className="wysiwyg-popover-actions">
            {context?.kind === 'link' ? (
              <Button variant="ghost" size="sm" type="button" onClick={handleUnlink}>
                <Unlink size={13} strokeWidth={1.75} aria-hidden="true" />
                <span>移除链接</span>
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" type="button" onClick={() => setPopover(null)}>
              取消
            </Button>
            <Button variant="primary" size="sm" type="submit">
              应用
            </Button>
          </div>
          {linkError ? <p className="wysiwyg-popover-error">{linkError}</p> : null}
        </form>
      ) : null}

      {popover === 'image' ? (
        <div className="wysiwyg-popover wysiwyg-image-popover">
          {bookImages.length === 0 ? (
            <p className="wysiwyg-popover-note">
              这本书还没有图片资源，请先点击顶部「加资源」导入图片。
            </p>
          ) : (
            <>
              <label className="wysiwyg-popover-field">
                <span>替代文本（alt）</span>
                <input
                  type="text"
                  placeholder="留空则使用文件名"
                  value={insertAltDraft}
                  onChange={(event) => setInsertAltDraft(event.target.value)}
                />
              </label>
              <div className="wysiwyg-image-grid">
                {bookImages.map((item) => (
                  <button
                    key={item.path}
                    type="button"
                    className="wysiwyg-image-option"
                    title={item.relativeHref}
                    onClick={() => handleInsertImage(item.path, item.relativeHref)}
                  >
                    <img src={imageThumbnails.urls.get(item.path)} alt="" />
                    <span className="wysiwyg-image-name">{basename(item.path)}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="wysiwyg-popover-actions">
            <Button variant="ghost" size="sm" type="button" onClick={() => setPopover(null)}>
              关闭
            </Button>
          </div>
        </div>
      ) : null}

      {context && !popover ? (
        <div className="wysiwyg-context-bar" role="region" aria-label="当前选中元素">
          {context.kind === 'island' ? (
            <>
              <Code2 size={13} strokeWidth={1.75} aria-hidden="true" />
              <span className="wysiwyg-context-label">
                只读保护节点 &lt;{context.tag}&gt;，为防止破坏公式或结构标签，请切到代码模式修改
              </span>
              <Button variant="secondary" size="sm" onClick={onSwitchToCode}>
                切到代码
              </Button>
            </>
          ) : context.kind === 'link' ? (
            <>
              <Link2 size={13} strokeWidth={1.75} aria-hidden="true" />
              <span className="wysiwyg-context-label wysiwyg-context-mono" title={context.href}>
                {context.href || '（空链接）'}
              </span>
              <Button variant="secondary" size="sm" onClick={openLinkPopover}>
                编辑链接
              </Button>
              {resolvedTarget && onNavigateLink ? (
                <Button variant="ghost" size="sm" onClick={() => onNavigateLink(resolvedTarget)}>
                  <ExternalLink size={12} strokeWidth={1.75} aria-hidden="true" />
                  <span>打开目标</span>
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" onClick={handleUnlink}>
                <Unlink size={12} strokeWidth={1.75} aria-hidden="true" />
                <span>移除链接</span>
              </Button>
            </>
          ) : (
            <form className="wysiwyg-context-image" onSubmit={handleUpdateImageAlt}>
              <span className="wysiwyg-context-label wysiwyg-context-mono" title={context.src}>
                {context.src}
              </span>
              <input
                type="text"
                aria-label="图片替代文本"
                placeholder="图片描述 alt"
                value={imageAltDraft}
                onChange={(event) => setImageAltDraft(event.target.value)}
              />
              <Button variant="secondary" size="sm" type="submit">
                更新说明
              </Button>
              <Button variant="ghost" className="btn-danger-ghost" size="sm" type="button" onClick={handleDeleteImage}>
                <Trash2 size={12} strokeWidth={1.75} aria-hidden="true" />
                <span>删除图片</span>
              </Button>
            </form>
          )}
        </div>
      ) : null}

      <div className="wysiwyg-stage">
        <iframe
          ref={frame}
          className="wysiwyg-frame"
          title="可视化编辑器"
          sandbox="allow-same-origin"
          srcDoc={EMPTY_IFRAME_DOC}
          onLoad={handleFrameLoad}
        />
      </div>
    </div>
  )
}
