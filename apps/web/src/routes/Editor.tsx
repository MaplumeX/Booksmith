import {
  addManifestItem,
  browserXmlCodec,
  dirname,
  findBrokenAnchors,
  readNavToc,
  writeNavToc,
  writeNcxToc,
  writeOpfMetadata,
  zipArchive,
  type SearchFile,
  type TocEntry,
} from '@booksmith/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api } from '../api/client'
import { mediaTypeOf } from '../preview/render'
import { navigate } from '../router'
import { extensionOf, groupFiles, loadBook, proseLength, type LoadedBook } from '../state/bookStore'
import { Button } from '../ui/Button'
import { CodePane } from '../ui/CodePane'
import { EmptyState } from '../ui/EmptyState'
import { FileTree } from '../ui/FileTree'
import { MediaPane } from '../ui/MediaPane'
import { PreviewPane } from '../ui/PreviewPane'
import { MetadataPanel } from '../ui/MetadataPanel'
import { SearchPanel } from '../ui/SearchPanel'
import { TocPanel } from '../ui/TocPanel'
import type { RevealTarget } from '../ui/CodePane'
import { StatusBar } from '../ui/StatusBar'
import { TabBar } from '../ui/TabBar'
import { VersionsPanel } from '../ui/VersionsPanel'

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' }
type SidebarTab = 'preview' | 'search' | 'metadata' | 'toc' | 'versions'

const SIDEBAR_MIN = 400
const SIDEBAR_MAX = 560
const SIDEBAR_TABS: Array<[SidebarTab, string]> = [
  ['preview', '预览'],
  ['search', '查找'],
  ['metadata', '元数据'],
  ['toc', '目录'],
  ['versions', '版本'],
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

function isPreviewable(path: string | null): boolean {
  if (!path) return false
  const extension = extensionOf(path)
  return extension === 'xhtml' || extension === 'html' || extension === 'htm'
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
  const texts = useRef<Map<string, string>>(new Map())

  const applyBook = useCallback((loaded: LoadedBook) => {
    texts.current = new Map(loaded.texts)
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
      .then((loaded) => {
        if (cancelled) return
        applyBook(loaded)
        setState({ status: 'ready' })
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

  const handleChange = useCallback((path: string, value: string) => {
    texts.current.set(path, value)
    setDirty((current) => {
      if (current.has(path)) return current
      const next = new Set(current)
      next.add(path)
      return next
    })
  }, [])

  const reload = useCallback(async () => {
    try {
      const loaded = await loadBook(bookId)
      const previousTabs = tabs
      const previousActive = active
      texts.current = new Map(loaded.texts)
      setBook(loaded)
      setDirty(new Set())
      setConflict(false)
      setSaveError(null)
      const kept = previousTabs.filter((path) => loaded.archive.entries.has(path))
      setTabs(kept)
      setActive(kept.includes(previousActive ?? '') ? previousActive : (kept[0] ?? null))
    } catch (error) {
      setSaveError(messageFor(error))
    }
  }, [bookId, tabs, active])

  const save = useCallback(async () => {
    if (!book || dirty.size === 0 || saving) return
    setSaving(true)
    setSaveError(null)
    setConflict(false)
    try {
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
      const result = await api.save(book.id, book.version, bytes)
      setBook({ ...book, version: result.version, archive: { order, entries } })
      setDirty(new Set())
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true)
      } else {
        setSaveError(messageFor(error))
      }
    } finally {
      setSaving(false)
    }
  }, [book, dirty, saving])

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
      setBook({ ...book, archive, groups: groupFiles(book.pkg, archive) })
      // Binary entries are not editable, so they stay out of the tab strip.
    },
    [book],
  )

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
      const modifier = event.metaKey || event.ctrlKey
      if (!modifier) return
      if (event.key.toLowerCase() === 's' && !event.shiftKey) {
        event.preventDefault()
        void save()
      }
      if (event.key.toLowerCase() === 'f' && event.shiftKey) {
        event.preventDefault()
        setSidebarTab('search')
        setSideOpen(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [save])

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
        />
      )
    }
    if (sidebarTab === 'versions') {
      return (
        <VersionsPanel
          bookId={book.id}
          currentVersion={book.version}
          onRestored={() => {
            void reload()
          }}
        />
      )
    }
    if (sidebarTab === 'metadata') {
      return (
        <MetadataPanel
          metadata={book.pkg.metadata}
          onApply={(draft) => {
            handleChange(book.pkg.opfPath, writeOpfMetadata(texts.current.get(book.pkg.opfPath) ?? '', draft, browserXmlCodec))
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
        onChange={(next) => {
          if (book.pkg.navPath) {
            const navXml = texts.current.get(book.pkg.navPath)
            if (navXml) handleChange(book.pkg.navPath, writeNavToc(navXml, next, browserXmlCodec))
          }
          if (book.pkg.ncxPath) {
            const ncxXml = texts.current.get(book.pkg.ncxPath)
            if (ncxXml) handleChange(book.pkg.ncxPath, writeNcxToc(ncxXml, next, browserXmlCodec))
          }
        }}
      />
    )
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
        <span className="appbar-meta">v{book.version}</span>
        <span className="appbar-spacer" />
        {dirty.size > 0 ? <span className="appbar-flag">{dirty.size} 处未保存</span> : null}
        <Button
          variant="ghost"
          className="sidebar-toggle"
          aria-expanded={sideOpen}
          onClick={() => setSideOpen((openSide) => !openSide)}
        >
          预览
        </Button>
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
        <Button variant="primary" onClick={() => void save()} disabled={dirty.size === 0 || saving}>
          {saving ? '保存中…' : '保存'}
        </Button>
      </header>

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
          onOpen={(path) => {
            open(path)
            setTreeOpen(false)
          }}
        />
        <div className="editor-column">
          <TabBar tabs={tabs} active={active} dirty={dirty} onSelect={setActive} onClose={close} />
          {active ? (
            editable ? (
              <CodePane
                path={active}
                content={content}
                reveal={reveal}
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

      <StatusBar
        path={active}
        characters={editable ? proseLength(active, content) : null}
        dirtyCount={dirty.size}
      />
    </div>
  )
}
