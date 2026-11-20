import {
  browserXmlParser,
  dirname,
  relativePath,
  resolvePath,
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
  Moon,
  Redo2,
  RemoveFormatting,
  Subscript,
  Sun,
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
import { buildPreview, mediaTypeOf } from '../preview/render'
import { basename } from '../state/bookStore'
import { Button } from './Button'

export type WysiwygShortcut = 'save' | 'close-tab' | 'next-tab' | 'prev-tab' | 'search'

export interface WysiwygPaneProps {
  path: string
  content: string
  archive: EpubArchive
  pkg: EpubPackage
  externalVersion?: number
  flushRef?: React.MutableRefObject<(() => void) | null>
  onChange: (value: string) => void
  onSwitchToCode: () => void
  onShortcut?: (action: WysiwygShortcut) => void
  onNavigateLink?: (target: { path: string; fragment: string }) => void
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

export function WysiwygPane({
  path,
  content,
  archive,
  pkg,
  externalVersion = 0,
  flushRef,
  onChange,
  onSwitchToCode,
  onShortcut,
  onNavigateLink,
}: WysiwygPaneProps) {
  const [srcDoc, setSrcDoc] = useState('')
  const [xmlError, setXmlError] = useState<string | null>(null)
  const [paperTheme, setPaperTheme] = useState<'light' | 'dark'>('light')
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
  const revokePreview = useRef<(() => void) | null>(null)
  const insertedBlobUrls = useRef<string[]>([])
  const savedRange = useRef<Range | null>(null)
  const scrollRatio = useRef(0)

  const syncTimer = useRef<number | null>(null)
  const undoTimer = useRef<number | null>(null)
  const undoStack = useRef<string[]>([])
  const undoIndex = useRef(0)
  const hasPendingEdit = useRef(false)

  const lastSyncedXhtml = useRef<string | null>(null)
  const loadedKey = useRef<string | null>(null)
  const loadedArchive = useRef<EpubArchive | null>(null)
  const loadedPkg = useRef<EpubPackage | null>(null)
  const liveSession = useRef<{ path: string; xhtml: string; islands: string[] }>({
    path,
    xhtml: content,
    islands: [],
  })

  const onChangeRef = useRef(onChange)
  const onShortcutRef = useRef(onShortcut)
  onChangeRef.current = onChange
  onShortcutRef.current = onShortcut

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

  useEffect(() => {
    const isSameFileAndSelfSync =
      liveSession.current.path === path &&
      content === lastSyncedXhtml.current &&
      loadedKey.current === `${path}::${paperTheme}::${externalVersion}` &&
      loadedArchive.current === archive &&
      loadedPkg.current === pkg

    if (isSameFileAndSelfSync) return

    // Flush any pending edits before loading a new document or rebuilding the preview frame.
    if (hasPendingEdit.current) {
      emitNow()
    }
    hasPendingEdit.current = false
    clearTimers()

    const win = frame.current?.contentWindow
    if (win && liveSession.current.path === path) {
      const scrollable = win.document.documentElement.scrollHeight - win.innerHeight
      scrollRatio.current = scrollable > 0 ? win.scrollY / scrollable : 0
    } else {
      scrollRatio.current = 0
    }

    const wellFormed = checkXmlWellFormed(content, browserXmlParser)
    if (!wellFormed.ok) {
      setXmlError(wellFormed.message)
      setSrcDoc('')
      setContext(null)
      setPopover(null)
      return
    }

    const next = buildPreview({
      xhtml: content,
      path,
      archive,
      pkg,
      editable: { paperTheme },
    })

    revokePreview.current?.()
    revokePreview.current = next.revoke
    liveSession.current = { path, xhtml: content, islands: next.islands }
    lastSyncedXhtml.current = content
    loadedKey.current = `${path}::${paperTheme}::${externalVersion}`
    loadedArchive.current = archive
    loadedPkg.current = pkg
    savedRange.current = null
    setXmlError(null)
    setContext(null)
    setPopover(null)
    setSrcDoc(next.html)
  }, [path, content, archive, pkg, paperTheme, externalVersion, clearTimers, emitNow])

  useEffect(() => {
    return () => {
      if (syncTimer.current !== null) emitNow()
      clearTimers()
      revokePreview.current?.()
      for (const url of insertedBlobUrls.current) URL.revokeObjectURL(url)
    }
  }, [clearTimers, emitNow])

  const frameListenersCleanup = useRef<(() => void) | null>(null)

  const handleFrameLoad = useCallback(() => {
    frameListenersCleanup.current?.()
    const doc = frame.current?.contentDocument
    const win = frame.current?.contentWindow
    if (!doc?.body || !win) return

    const scrollable = doc.documentElement.scrollHeight - win.innerHeight
    if (scrollable > 0 && scrollRatio.current > 0) {
      win.scrollTo(0, scrollRatio.current * scrollable)
    }

    hasPendingEdit.current = false
    undoStack.current = [doc.body.innerHTML]
    undoIndex.current = 0
    updateUndoFlags()
    refreshToolbar()

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

    frameListenersCleanup.current = () => {
      doc.body?.removeEventListener('input', onInput)
      doc.body?.removeEventListener('click', onClick)
      doc.body?.removeEventListener('keyup', onSelectionChange)
      doc.body?.removeEventListener('mouseup', onSelectionChange)
      doc.removeEventListener('selectionchange', onSelectionChange)
      doc.removeEventListener('keydown', onKeyDown)
    }
  }, [
    applyInline,
    commitDomMutation,
    emitNow,
    redo,
    refreshToolbar,
    scheduleSync,
    scheduleUndoSnapshot,
    undo,
    updateUndoFlags,
  ])

  useEffect(() => {
    return () => frameListenersCleanup.current?.()
  }, [])

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
    if (popover !== 'image') return new Map<string, string>()
    const map = new Map<string, string>()
    for (const item of bookImages) {
      const bytes = archive.entries.get(item.path)
      if (!bytes) continue
      const copy = new Uint8Array(bytes.length)
      copy.set(bytes)
      map.set(item.path, URL.createObjectURL(new Blob([copy.buffer], { type: mediaTypeOf(item.path, pkg) })))
    }
    return map
  }, [popover, bookImages, archive, pkg])

  useEffect(() => {
    return () => {
      for (const url of imageThumbnails.values()) URL.revokeObjectURL(url)
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
    const bytes = archive.entries.get(targetPath)
    if (!bytes) return
    const copy = new Uint8Array(bytes.length)
    copy.set(bytes)
    const blobUrl = URL.createObjectURL(new Blob([copy.buffer], { type: mediaTypeOf(targetPath, pkg) }))
    insertedBlobUrls.current.push(blobUrl)

    const sel = restoreRange(doc)
    if (!sel || sel.rangeCount === 0) return
    const altText = insertAltDraft.trim() || basename(targetPath).replace(/\.[^.]+$/, '')
    insertImageAtRange(doc, sel.getRangeAt(0), blobUrl, relativeHref, altText)
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
          title="加粗 (⌘B)"
          onClick={() => applyInline('strong')}
        >
          <Bold size={14} strokeWidth={1.85} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`wysiwyg-tool${toolbar.em ? ' on' : ''}`}
          aria-pressed={toolbar.em}
          aria-label="斜体"
          title="斜体 (⌘I)"
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

        <span className="wysiwyg-sep" aria-hidden="true" />

        <button
          type="button"
          className="wysiwyg-tool"
          disabled={!canUndo}
          aria-label="撤销"
          title="撤销 (⌘Z)"
          onClick={undo}
        >
          <Undo2 size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="wysiwyg-tool"
          disabled={!canRedo}
          aria-label="重做"
          title="重做 (⌘⇧Z)"
          onClick={redo}
        >
          <Redo2 size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>

        <span className="wysiwyg-spacer" />

        <button
          type="button"
          className={`wysiwyg-tool wysiwyg-paper-toggle${paperTheme === 'dark' ? ' on' : ''}`}
          aria-pressed={paperTheme === 'dark'}
          aria-label={paperTheme === 'dark' ? '切换浅色纸面' : '切换暗色纸面'}
          title={paperTheme === 'dark' ? '切换浅色纸面' : '切换暗色纸面'}
          onClick={() => setPaperTheme((cur) => (cur === 'light' ? 'dark' : 'light'))}
        >
          {paperTheme === 'dark' ? (
            <Moon size={14} strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <Sun size={14} strokeWidth={1.75} aria-hidden="true" />
          )}
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
                    <img src={imageThumbnails.get(item.path)} alt="" />
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
        {!srcDoc ? (
          <div className="preview-skeleton" aria-busy="true" />
        ) : (
          <iframe
            ref={frame}
            className="wysiwyg-frame"
            title="可视化编辑器"
            sandbox="allow-same-origin"
            srcDoc={srcDoc}
            onLoad={handleFrameLoad}
          />
        )}
      </div>
    </div>
  )
}
