import { useEffect, useRef, useState } from 'react'
import type { EpubArchive, EpubPackage } from '@booksmith/core'
import { buildPreview } from '../preview/render'

interface PreviewPaneProps {
  path: string
  content: string
  archive: EpubArchive
  pkg: EpubPackage
}

const DEBOUNCE_MS = 300

export function PreviewPane({ path, content, archive, pkg }: PreviewPaneProps) {
  const [srcDoc, setSrcDoc] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const scrollRatio = useRef(0)
  const revoke = useRef<(() => void) | null>(null)

  const rememberScroll = () => {
    const win = frame.current?.contentWindow
    if (!win) return
    const scrollable = win.document.documentElement.scrollHeight - win.innerHeight
    scrollRatio.current = scrollable > 0 ? win.scrollY / scrollable : 0
  }

  const restoreScroll = () => {
    const win = frame.current?.contentWindow
    if (!win) return
    const scrollable = win.document.documentElement.scrollHeight - win.innerHeight
    if (scrollable > 0) win.scrollTo(0, scrollRatio.current * scrollable)
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      rememberScroll()
      try {
        const next = buildPreview({ xhtml: content, path, archive, pkg })
        revoke.current?.()
        revoke.current = next.revoke
        setSrcDoc(next.html)
        setFailure(null)
      } catch (error) {
        setFailure(error instanceof Error ? error.message : '预览渲染失败')
      }
    }, DEBOUNCE_MS)

    return () => window.clearTimeout(timer)
  }, [content, path, archive, pkg])

  useEffect(
    () => () => {
      revoke.current?.()
    },
    [],
  )

  if (failure) {
    return (
      <div className="preview-pane">
        <p className="banner banner-error" role="alert">
          预览渲染失败：{failure}
        </p>
      </div>
    )
  }

  if (!srcDoc) {
    return (
      <div className="preview-pane">
        <div className="preview-skeleton" aria-busy="true" />
      </div>
    )
  }

  return (
    <div className="preview-pane">
      <iframe
        ref={frame}
        className="preview-frame"
        title="预览"
        sandbox="allow-same-origin"
        srcDoc={srcDoc}
        onLoad={restoreScroll}
      />
    </div>
  )
}
