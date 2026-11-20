import { AlertCircle } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { EpubArchive, EpubPackage } from '@booksmith/core'
import { patchDocument } from '../preview/patchDocument'
import {
  buildPreviewDocument,
  EMPTY_IFRAME_DOC,
  PreviewBlobCache,
  previewResourcesChanged,
  type PreviewResourceSnapshot,
} from '../preview/render'

interface PreviewPaneProps {
  path: string
  content: string
  archive: EpubArchive
  pkg: EpubPackage
  subscribeTextChange?: (listener: (changedPath: string, value: string) => void) => () => void
}

const DEBOUNCE_MS = 180

export function PreviewPane({ path, content, archive, pkg, subscribeTextChange }: PreviewPaneProps) {
  const [failure, setFailure] = useState<string | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const blobCache = useRef<PreviewBlobCache>(new PreviewBlobCache())
  const readyDocs = useRef<WeakSet<Document>>(new WeakSet())
  const timer = useRef<number | null>(null)
  const applied = useRef<{
    path: string
    content: string
    deps: Map<string, PreviewResourceSnapshot>
  } | null>(null)
  const liveContent = useRef(content)
  const latest = useRef({ path, archive, pkg })

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
    (nextPath: string, nextContent: string, nextArchive: EpubArchive, nextPkg: EpubPackage) => {
      const iframe = frame.current
      const doc = iframe?.contentDocument
      const win = iframe?.contentWindow
      if (!iframe || !doc || !win || !isDocReady()) return

      const prev = applied.current
      if (
        prev &&
        prev.path === nextPath &&
        prev.content === nextContent &&
        !previewResourcesChanged(prev.deps, nextArchive, nextPkg)
      ) {
        return
      }

      try {
        const built = buildPreviewDocument({
          xhtml: nextContent,
          path: nextPath,
          archive: nextArchive,
          pkg: nextPkg,
          blobCache: blobCache.current,
        })
        readyDocs.current.add(doc)
        const pathChanged = prev !== null && prev.path !== nextPath
        patchDocument(doc, built.doc)
        blobCache.current.flushObsolete(nextArchive)
        if (pathChanged) win.scrollTo(0, 0)
        applied.current = { path: nextPath, content: nextContent, deps: built.dependencies }
        setFailure(null)
      } catch (error) {
        setFailure(error instanceof Error ? error.message : '预览渲染失败')
      }
    },
    [isDocReady],
  )

  const handleFrameLoad = useCallback(() => {
    const doc = frame.current?.contentDocument
    if (doc) readyDocs.current.add(doc)
    renderNow(latest.current.path, liveContent.current, latest.current.archive, latest.current.pkg)
  }, [renderNow])

  useEffect(() => {
    liveContent.current = content
    latest.current = { path, archive, pkg }
    clearTimer()

    if (!isDocReady()) return

    const prev = applied.current
    if (!prev || prev.path !== path) {
      renderNow(path, content, archive, pkg)
      return
    }

    const resourcesChanged = previewResourcesChanged(prev.deps, archive, pkg)
    if (prev.content === content && !resourcesChanged) {
      return
    }

    if (resourcesChanged && prev.content === content) {
      renderNow(path, content, archive, pkg)
      return
    }

    timer.current = window.setTimeout(() => {
      timer.current = null
      renderNow(latest.current.path, liveContent.current, latest.current.archive, latest.current.pkg)
    }, DEBOUNCE_MS)

    return clearTimer
  }, [content, path, archive, pkg, clearTimer, isDocReady, renderNow])

  useEffect(() => {
    if (!subscribeTextChange) return
    return subscribeTextChange((changedPath, value) => {
      if (changedPath !== path) return
      liveContent.current = value
      clearTimer()
      timer.current = window.setTimeout(() => {
        timer.current = null
        renderNow(latest.current.path, liveContent.current, latest.current.archive, latest.current.pkg)
      }, DEBOUNCE_MS)
    })
  }, [subscribeTextChange, path, clearTimer, renderNow])

  useEffect(
    () => () => {
      clearTimer()
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
