import { dirname, relativePath, type EpubArchive, type EpubPackage } from '@booksmith/core'
import {
  AlignLeft,
  Anchor,
  Bold,
  Command,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Omega,
  Scissors,
  SeparatorHorizontal,
  Split,
} from 'lucide-react'
import { Popover } from 'radix-ui'
import { useEffect, useMemo, useState } from 'react'
import type { CodeBlockTag, CodeInlineTag, CodeListTag } from '../editor/codeActions'
import { formatShortcut } from '../editor/shortcuts'
import { SPECIAL_CHAR_GROUPS } from '../editor/specialChars'
import { mediaTypeOf, type PreviewAssetResolver } from '../preview/render'
import { basename } from '../state/bookStore'
import { Button } from './Button'

export type CodeFileKind = 'xhtml' | 'css' | 'xml' | 'other'

interface CodeToolbarProps {
  path: string
  fileKind: CodeFileKind
  archive: EpubArchive
  pkg: EpubPackage
  resolveAsset?: PreviewAssetResolver
  markerCount: number
  onSplitAtCursor: () => void
  onInsertSplitMarker: () => void
  onSplitAtMarkers: () => void
  onWrapBlock: (tag: CodeBlockTag) => void
  onWrapInline: (tag: CodeInlineTag) => void
  onWrapList: (tag: CodeListTag) => void
  onInsertAnchorId: (id: string) => boolean
  onInsertLink: (href: string, label?: string) => boolean
  onInsertImage: (relativeSrc: string, alt: string) => boolean
  onInsertHr: () => void
  onInsertChar: (char: string) => void
  onFormat: () => void
  onOpenCommandPalette: () => void
}

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|svg)$/i

/**
 * Compact single-row (`34px`) CodeMirror action strip aligned with Soft Craft Studio's frameless
 * document card. Uses on-demand Radix Popovers for anchor ID, link, image picker, and special
 * characters so the toolbar never inflates vertically.
 * See ADR 2026-11-21-code-productivity-and-command-palette.
 */
export function CodeToolbar({
  path,
  fileKind,
  archive,
  pkg,
  resolveAsset,
  markerCount,
  onSplitAtCursor,
  onInsertSplitMarker,
  onSplitAtMarkers,
  onWrapBlock,
  onWrapInline,
  onWrapList,
  onInsertAnchorId,
  onInsertLink,
  onInsertImage,
  onInsertHr,
  onInsertChar,
  onFormat,
  onOpenCommandPalette,
}: CodeToolbarProps) {
  const [openPopover, setOpenPopover] = useState<'anchor' | 'link' | 'image' | 'chars' | null>(null)
  const [anchorDraft, setAnchorDraft] = useState('')
  const [anchorError, setAnchorError] = useState<string | null>(null)
  const [linkHref, setLinkHref] = useState('')
  const [linkLabel, setLinkLabel] = useState('')
  const [linkError, setLinkError] = useState<string | null>(null)
  const [imageAlt, setImageAlt] = useState('')
  const [activeCharGroup, setActiveCharGroup] = useState(SPECIAL_CHAR_GROUPS[0]!.id)

  const bookImages = useMemo(() => {
    const items: Array<{ path: string; relativeHref: string }> = []
    const base = dirname(path)
    for (const entryPath of archive.order) {
      if (!IMAGE_EXTENSION.test(entryPath)) continue
      items.push({ path: entryPath, relativeHref: relativePath(base, entryPath) })
    }
    return items
  }, [archive, path])

  const imageThumbnails = useMemo(() => {
    if (openPopover !== 'image') return { urls: new Map<string, string>(), blobs: [] as string[] }
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
  }, [openPopover, bookImages, archive, pkg, resolveAsset])

  useEffect(() => {
    return () => {
      for (const url of imageThumbnails.blobs) URL.revokeObjectURL(url)
    }
  }, [imageThumbnails])

  const isXhtml = fileKind === 'xhtml'
  const canFormat = fileKind === 'xhtml' || fileKind === 'css' || fileKind === 'xml'

  const currentCharGroup =
    SPECIAL_CHAR_GROUPS.find((g) => g.id === activeCharGroup) ?? SPECIAL_CHAR_GROUPS[0]!

  return (
    <div className="code-toolbar" role="toolbar" aria-label="代码编辑工具条">
      <div className="code-toolbar-scroll">
        {isXhtml ? (
          <>
            <button
              type="button"
              className="code-tool"
              aria-label="在光标处拆分章节"
              title={`在光标处拆分章节 (${formatShortcut('Mod+Enter')})`}
              onClick={onSplitAtCursor}
            >
              <Scissors size={13} strokeWidth={1.8} aria-hidden="true" />
              <span className="code-tool-label">拆分</span>
            </button>
            <button
              type="button"
              className="code-tool"
              aria-label="插入拆分标记"
              title={`插入拆分标记 (${formatShortcut('Mod+Shift+Enter')})`}
              onClick={onInsertSplitMarker}
            >
              <SeparatorHorizontal size={13} strokeWidth={1.8} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="code-tool"
              disabled={markerCount === 0}
              aria-label="按标记拆分章节"
              title={markerCount > 0 ? `按标记批量拆分（${markerCount} 处）` : '先插入拆分标记后再按标记拆分'}
              onClick={onSplitAtMarkers}
            >
              <Split size={13} strokeWidth={1.8} aria-hidden="true" />
              {markerCount > 0 ? <span className="code-tool-badge">{markerCount}</span> : null}
            </button>

            <span className="code-toolbar-sep" aria-hidden="true" />

            <select
              className="code-block-select"
              aria-label="包裹块级标签"
              value=""
              onChange={(event) => {
                const value = event.target.value as CodeBlockTag | ''
                if (value) onWrapBlock(value)
              }}
            >
              <option value="" disabled>
                块标签
              </option>
              <option value="p">正文 &lt;p&gt;</option>
              <option value="h1">标题 1 &lt;h1&gt;</option>
              <option value="h2">标题 2 &lt;h2&gt;</option>
              <option value="h3">标题 3 &lt;h3&gt;</option>
              <option value="h4">标题 4 &lt;h4&gt;</option>
              <option value="blockquote">引用 &lt;blockquote&gt;</option>
            </select>

            <button
              type="button"
              className="code-tool"
              aria-label="加粗标签"
              title="包裹 <strong>"
              onClick={() => onWrapInline('strong')}
            >
              <Bold size={13} strokeWidth={1.9} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="code-tool"
              aria-label="斜体标签"
              title="包裹 <em>"
              onClick={() => onWrapInline('em')}
            >
              <Italic size={13} strokeWidth={1.9} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="code-tool"
              aria-label="无序列表"
              title="转为无序列表 <ul>"
              onClick={() => onWrapList('ul')}
            >
              <List size={13} strokeWidth={1.8} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="code-tool"
              aria-label="有序列表"
              title="转为有序列表 <ol>"
              onClick={() => onWrapList('ol')}
            >
              <ListOrdered size={13} strokeWidth={1.8} aria-hidden="true" />
            </button>

            <span className="code-toolbar-sep" aria-hidden="true" />

            <Popover.Root
              open={openPopover === 'anchor'}
              onOpenChange={(open) => {
                setOpenPopover(open ? 'anchor' : null)
                if (open) {
                  setAnchorDraft('')
                  setAnchorError(null)
                }
              }}
            >
              <Popover.Trigger asChild>
                <button
                  type="button"
                  className={`code-tool${openPopover === 'anchor' ? ' on' : ''}`}
                  aria-label="插入锚点 ID"
                  title="为当前元素或光标处插入 id 锚点"
                >
                  <Anchor size={13} strokeWidth={1.8} aria-hidden="true" />
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content className="code-popover" sideOffset={6} collisionPadding={12} align="start">
                  <form
                    className="code-popover-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      if (!onInsertAnchorId(anchorDraft)) {
                        setAnchorError('请输入合法的 XML ID（字母或下划线开头，不含空格）')
                        return
                      }
                      setOpenPopover(null)
                    }}
                  >
                    <label className="panel-field">
                      <span>锚点 ID</span>
                      <input
                        autoFocus
                        type="text"
                        placeholder="例如 sec-1 或 note_01"
                        aria-invalid={anchorError ? 'true' : undefined}
                        value={anchorDraft}
                        onChange={(event) => {
                          setAnchorDraft(event.target.value)
                          setAnchorError(null)
                        }}
                      />
                    </label>
                    {anchorError ? <p className="code-popover-error">{anchorError}</p> : null}
                    <div className="code-popover-actions">
                      <Button variant="ghost" size="sm" type="button" onClick={() => setOpenPopover(null)}>
                        取消
                      </Button>
                      <Button variant="primary" size="sm" type="submit">
                        插入 ID
                      </Button>
                    </div>
                  </form>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            <Popover.Root
              open={openPopover === 'link'}
              onOpenChange={(open) => {
                setOpenPopover(open ? 'link' : null)
                if (open) {
                  setLinkHref('')
                  setLinkLabel('')
                  setLinkError(null)
                }
              }}
            >
              <Popover.Trigger asChild>
                <button
                  type="button"
                  className={`code-tool${openPopover === 'link' ? ' on' : ''}`}
                  aria-label="插入链接"
                  title="插入 <a> 链接"
                >
                  <Link2 size={13} strokeWidth={1.8} aria-hidden="true" />
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content className="code-popover" sideOffset={6} collisionPadding={12} align="start">
                  <form
                    className="code-popover-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      if (!onInsertLink(linkHref, linkLabel)) {
                        setLinkError('请输入链接地址（如 ch002.xhtml#sec1 或 https://...）')
                        return
                      }
                      setOpenPopover(null)
                    }}
                  >
                    <label className="panel-field">
                      <span>链接地址（href）</span>
                      <input
                        autoFocus
                        type="text"
                        placeholder="例如 ch002.xhtml#sec1"
                        aria-invalid={linkError ? 'true' : undefined}
                        value={linkHref}
                        onChange={(event) => {
                          setLinkHref(event.target.value)
                          setLinkError(null)
                        }}
                      />
                    </label>
                    <label className="panel-field">
                      <span>链接文本（已有选区时自动包裹选区）</span>
                      <input
                        type="text"
                        placeholder="留空则使用地址文本"
                        value={linkLabel}
                        onChange={(event) => setLinkLabel(event.target.value)}
                      />
                    </label>
                    {linkError ? <p className="code-popover-error">{linkError}</p> : null}
                    <div className="code-popover-actions">
                      <Button variant="ghost" size="sm" type="button" onClick={() => setOpenPopover(null)}>
                        取消
                      </Button>
                      <Button variant="primary" size="sm" type="submit">
                        插入链接
                      </Button>
                    </div>
                  </form>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            <Popover.Root
              open={openPopover === 'image'}
              onOpenChange={(open) => {
                setOpenPopover(open ? 'image' : null)
                if (open) setImageAlt('')
              }}
            >
              <Popover.Trigger asChild>
                <button
                  type="button"
                  className={`code-tool${openPopover === 'image' ? ' on' : ''}`}
                  aria-label="插入书内图片"
                  title="插入书内图片 <img>"
                >
                  <ImagePlus size={13} strokeWidth={1.8} aria-hidden="true" />
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content className="code-popover code-popover-wide" sideOffset={6} collisionPadding={12} align="start">
                  {bookImages.length === 0 ? (
                    <p className="code-popover-note">这本书还没有图片资源，请先点击顶部「加资源」导入图片。</p>
                  ) : (
                    <div className="code-popover-form">
                      <label className="panel-field">
                        <span>替代文本（alt）</span>
                        <input
                          type="text"
                          placeholder="留空则使用文件名"
                          value={imageAlt}
                          onChange={(event) => setImageAlt(event.target.value)}
                        />
                      </label>
                      <div className="wysiwyg-image-grid">
                        {bookImages.map((item) => (
                          <button
                            key={item.path}
                            type="button"
                            className="wysiwyg-image-option"
                            title={item.relativeHref}
                            onClick={() => {
                              const alt = imageAlt.trim() || basename(item.path).replace(/\.[^.]+$/, '')
                              onInsertImage(item.relativeHref, alt)
                              setOpenPopover(null)
                            }}
                          >
                            <img src={imageThumbnails.urls.get(item.path)} alt="" />
                            <span className="wysiwyg-image-name">{basename(item.path)}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            <button
              type="button"
              className="code-tool"
              aria-label="插入分隔线"
              title="插入分隔线 <hr />"
              onClick={onInsertHr}
            >
              <Minus size={13} strokeWidth={1.9} aria-hidden="true" />
            </button>

            <Popover.Root
              open={openPopover === 'chars'}
              onOpenChange={(open) => setOpenPopover(open ? 'chars' : null)}
            >
              <Popover.Trigger asChild>
                <button
                  type="button"
                  className={`code-tool${openPopover === 'chars' ? ' on' : ''}`}
                  aria-label="插入特殊字符"
                  title="插入常用中文标点、破折号与数学符号"
                >
                  <Omega size={13} strokeWidth={1.8} aria-hidden="true" />
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content className="code-popover code-chars-popover" sideOffset={6} collisionPadding={12} align="start">
                  <div className="code-chars-tabs" role="tablist" aria-label="特殊字符分组">
                    {SPECIAL_CHAR_GROUPS.map((group) => (
                      <button
                        key={group.id}
                        type="button"
                        role="tab"
                        aria-selected={currentCharGroup.id === group.id}
                        className={`code-chars-tab${currentCharGroup.id === group.id ? ' on' : ''}`}
                        onClick={() => setActiveCharGroup(group.id)}
                      >
                        {group.label}
                      </button>
                    ))}
                  </div>
                  <div className="code-chars-grid" role="tabpanel" aria-label={currentCharGroup.label}>
                    {currentCharGroup.items.map((item) => (
                      <button
                        key={`${currentCharGroup.id}-${item.label}`}
                        type="button"
                        className="code-char-btn"
                        title={item.label}
                        aria-label={`插入 ${item.label}`}
                        onClick={() => {
                          onInsertChar(item.char)
                          setOpenPopover(null)
                        }}
                      >
                        {item.display ?? item.char}
                      </button>
                    ))}
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            <span className="code-toolbar-sep" aria-hidden="true" />
          </>
        ) : null}

        {canFormat ? (
          <button
            type="button"
            className="code-tool"
            aria-label="美化格式化代码"
            title={`格式化当前文件 (${formatShortcut('Alt+Shift+F')})`}
            onClick={onFormat}
          >
            <AlignLeft size={13} strokeWidth={1.8} aria-hidden="true" />
            <span className="code-tool-label">格式化</span>
          </button>
        ) : null}
      </div>

      <button
        type="button"
        className="code-toolbar-cmd"
        aria-label="打开命令面板"
        title={`命令面板 (${formatShortcut('Mod+K')})`}
        onClick={onOpenCommandPalette}
      >
        <Command size={12} strokeWidth={1.8} aria-hidden="true" />
        <kbd>{formatShortcut('Mod+K')}</kbd>
      </button>
    </div>
  )
}
