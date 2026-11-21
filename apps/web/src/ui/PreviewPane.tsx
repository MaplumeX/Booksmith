import { AlertCircle } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { EpubArchive, EpubPackage } from '@booksmith/core'
import { patchDocument } from '../preview/patchDocument'
import {
  buildPreviewDocument,
  EMPTY_IFRAME_DOC,
  PreviewBlobCache,
  previewResourcesChanged,
  type PreviewAssetResolver,
  type PreviewResourceSnapshot,
} from '../preview/render'
import { useResolvedTheme } from '../state/settingsStore'

export interface FragmentRevealTarget {
  path: string
  fragment: string
  key: number
}

interface PreviewPaneProps {
  path: string
  content: string
  archive: EpubArchive
  pkg: EpubPackage
  resolveAsset?: PreviewAssetResolver
  revealFragment?: FragmentRevealTarget | null
  subscribeTextChange?: (listener: (changedPath: string, value: string) => void) => () => void
  onSelectionChange?: (selection: string) => void
}

const DEBOUNCE_MS = 180

function scrollIframeToFragment(doc: Document, win: Window, fragment: string): void {
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

export function PreviewPane({
  path,
  content,
  archive,
  pkg,
  resolveAsset,
  revealFragment,
  subscribeTextChange,
  onSelectionChange,
}: PreviewPaneProps) {
  const theme = useResolvedTheme()
  const [failure, setFailure] = useState<string | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const onSelectionChangeRef = useRef(onSelectionChange)
  onSelectionChangeRef.current = onSelectionChange
  const selectionCleanupRef = useRef<(() => void) | null>(null)
  const blobCache = useRef<PreviewBlobCache>(new PreviewBlobCache())
  const readyDocs = useRef<WeakSet<Document>>(new WeakSet())
  const timer = useRef<number | null>(null)
  const applied = useRef<{
    path: string
    content: string
    theme: 'light' | 'dark'
    deps: Map<string, PreviewResourceSnapshot>
  } | null>(null)
  const liveContent = useRef(content)
  const latest = useRef({ path, archive, pkg, resolveAsset })
  const revealRef = useRef(revealFragment ?? null)
  revealRef.current = revealFragment ?? null
  const appliedRevealKey = useRef<number | null>(null)
  const themeRef = useRef(theme)
  themeRef.current = theme

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const isDocReady = useCallback((): boolean => {
    const doc = frame.current?.contentDocument
    if (!doc?.documentElement || !doc.body) return false
    return doc.documentElement.hasAttribute('data-booksmith-shell') || readyDocs.current.has(doc)
  }, [])

  const renderNow = useCallback(
    (
      nextPath: string,
      nextContent: string,
      nextArchive: EpubArchive,
      nextPkg: EpubPackage,
      nextResolveAsset?: PreviewAssetResolver,
    ) => {
      const iframe = frame.current
      const doc = iframe?.contentDocument
      const win = iframe?.contentWindow
      if (!iframe || !doc || !win || !isDocReady()) return

      const nextTheme = themeRef.current
      const prev = applied.current
      if (
        prev &&
        prev.path === nextPath &&
        prev.content === nextContent &&
        prev.theme === nextTheme &&
        !previewResourcesChanged(prev.deps, nextArchive, nextPkg, nextResolveAsset)
      ) {
        return
      }

      try {
        const built = buildPreviewDocument({
          xhtml: nextContent,
          path: nextPath,
          archive: nextArchive,
          pkg: nextPkg,
          theme: nextTheme,
          blobCache: blobCache.current,
          resolveAsset: nextResolveAsset,
        })
        readyDocs.current.add(doc)
        const pathChanged = prev !== null && prev.path !== nextPath
        patchDocument(doc, built.doc)
        blobCache.current.flushObsolete(nextArchive)
        const pending = revealRef.current
        if (pending && pending.path === nextPath && appliedRevealKey.current !== pending.key) {
          appliedRevealKey.current = pending.key
          scrollIframeToFragment(doc, win, pending.fragment)
        } else if (pathChanged) {
          win.scrollTo(0, 0)
        }
        applied.current = { path: nextPath, content: nextContent, theme: nextTheme, deps: built.dependencies }
        setFailure(null)
      } catch (error) {
        setFailure(error instanceof Error ? error.message : '预览渲染失败')
      }
    },
    [isDocReady],
  )

  const bindSelectionListeners = useCallback((doc: Document) => {
    selectionCleanupRef.current?.()
    const report = () => {
      const sel = doc.defaultView?.getSelection()
      const text = sel && !sel.isCollapsed ? sel.toString() : ''
      onSelectionChangeRef.current?.(text)
    }
    doc.addEventListener('selectionchange', report)
    doc.addEventListener('mouseup', report)
    doc.addEventListener('keyup', report)
    selectionCleanupRef.current = () => {
      doc.removeEventListener('selectionchange', report)
      doc.removeEventListener('mouseup', report)
      doc.removeEventListener('keyup', report)
    }
  }, [])

  const handleFrameLoad = useCallback(() => {
    const doc = frame.current?.contentDocument
    if (doc) {
      readyDocs.current.add(doc)
      bindSelectionListeners(doc)
    }
    renderNow(
      latest.current.path,
      liveContent.current,
      latest.current.archive,
      latest.current.pkg,
      latest.current.resolveAsset,
    )
  }, [bindSelectionListeners, renderNow])

  useEffect(() => {
    themeRef.current = theme
    if (!isDocReady() || !applied.current) return
    renderNow(
      latest.current.path,
      liveContent.current,
      latest.current.archive,
      latest.current.pkg,
      latest.current.resolveAsset,
    )
  }, [theme, isDocReady, renderNow])

  useEffect(() => {
    liveContent.current = content
    latest.current = { path, archive, pkg, resolveAsset }
    clearTimer()

    if (!isDocReady()) return

    const prev = applied.current
    if (!prev || prev.path !== path || prev.theme !== themeRef.current) {
      renderNow(path, content, archive, pkg, resolveAsset)
      return
    }

    const resourcesChanged = previewResourcesChanged(prev.deps, archive, pkg, resolveAsset)
    if (prev.content === content && !resourcesChanged) {
      return
    }

    if (resourcesChanged && prev.content === content) {
      renderNow(path, content, archive, pkg, resolveAsset)
      return
    }

    timer.current = window.setTimeout(() => {
      timer.current = null
      renderNow(
        latest.current.path,
        liveContent.current,
        latest.current.archive,
        latest.current.pkg,
        latest.current.resolveAsset,
      )
    }, DEBOUNCE_MS)

    return clearTimer
  }, [content, path, archive, pkg, resolveAsset, clearTimer, isDocReady, renderNow])

  useEffect(() => {
    if (!subscribeTextChange) return
    return subscribeTextChange((changedPath, value) => {
      if (changedPath !== path) return
      liveContent.current = value
      clearTimer()
      timer.current = window.setTimeout(() => {
        timer.current = null
        renderNow(
          latest.current.path,
          liveContent.current,
          latest.current.archive,
          latest.current.pkg,
          latest.current.resolveAsset,
        )
      }, DEBOUNCE_MS)
    })
  }, [subscribeTextChange, path, clearTimer, renderNow])

  useEffect(() => {
    if (!revealFragment || revealFragment.path !== path) return
    if (appliedRevealKey.current === revealFragment.key) return
    const iframe = frame.current
    const doc = iframe?.contentDocument
    const win = iframe?.contentWindow
    if (!doc || !win || !isDocReady() || applied.current?.path !== path) return
    appliedRevealKey.current = revealFragment.key
    scrollIframeToFragment(doc, win, revealFragment.fragment)
  }, [revealFragment?.key, revealFragment?.path, revealFragment?.fragment, path, isDocReady])

  useEffect(
    () => () => {
      clearTimer()
      selectionCleanupRef.current?.()
      selectionCleanupRef.current = null
      onSelectionChangeRef.current?.('')
      applied.current = null
      blobCache.current.dispose()
    },
    [clearTimer],
  )

  return (
    <div className="preview-pane">
      {failure ? (
        <p className="banner banner-error preview-error" role="alert">
          <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>预览渲染失败：{failure}</span>
        </p>
      ) : null}
      <iframe
        ref={frame}
        className="preview-frame"
        title="预览"
        sandbox="allow-same-origin"
        srcDoc={EMPTY_IFRAME_DOC}
        onLoad={handleFrameLoad}
        hidden={Boolean(failure)}
      />
    </div>
  )
}
