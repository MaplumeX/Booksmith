import {
  browserXmlCodec,
  dirname,
  indentTocEntries,
  indentTocEntry,
  insertTocEntry,
  isSameOrDescendantTocPath,
  moveTocEntries,
  moveTocEntry,
  moveTocSubtree,
  outdentTocEntries,
  outdentTocEntry,
  refreshTocLabelsFromHeadings,
  removeBrokenTocEntries,
  removeTocEntries,
  removeTocEntry,
  resolvePath,
  splitFragment,
  updateTocEntry,
  type BrokenAnchor,
  type EpubPackage,
  type TocEntry,
  type TocInsertPosition,
  type TocPath,
} from '@booksmith/core'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  FolderMinus,
  IndentDecrease,
  IndentIncrease,
  Link2,
  MoreHorizontal,
  Pencil,
  Plus,
  Redo2,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from './Button'
import { ContextMenu, type ContextMenuEntry } from './ContextMenu'
import { EmptyState } from './EmptyState'
import { TocGenerateDialog } from './TocGenerateDialog'
import { TocLinkDialog } from './TocLinkDialog'

export interface TocPanelProps {
  pkg: EpubPackage
  entries: TocEntry[]
  broken: BrokenAnchor[]
  /** Null when the EPUB has neither nav.xhtml nor toc.ncx. */
  tocPath: string | null
  /** Reading order, offered as options when adding/editing an entry. */
  files: string[]
  texts: ReadonlyMap<string, string>
  activePath: string | null
  activeTocHref: string | null
  canUndo: boolean
  canRedo: boolean
  suggestTitle: (hrefOrPath: string) => string
  onNavigate: (href: string) => void
  onChange: (next: TocEntry[], extraChapters?: Map<string, string>) => void
  onUndo: () => void
  onRedo: () => void
  onInitializeToc: () => void
}

interface FlatEntry {
  entry: TocEntry
  depth: number
  path: TocPath
  key: string
  hasChildren: boolean
  siblingIndex: number
  siblingCount: number
}

function flattenTree(entries: TocEntry[], depth = 0, path: TocPath = [], out: FlatEntry[] = []): FlatEntry[] {
  entries.forEach((entry, index) => {
    const nextPath = [...path, index]
    out.push({
      entry,
      depth,
      path: nextPath,
      key: nextPath.join('.'),
      hasChildren: entry.children.length > 0,
      siblingIndex: index,
      siblingCount: entries.length,
    })
    flattenTree(entry.children, depth + 1, nextPath, out)
  })
  return out
}

function parseKeyToPath(key: string): TocPath {
  return key
    .split('.')
    .map((part) => Number(part))
    .filter((num) => Number.isInteger(num) && num >= 0)
}

interface LinkModalState {
  mode: 'add' | 'edit'
  targetPath: TocPath
  position: TocInsertPosition
  subtitle?: string
  initialLabel: string
  initialHref: string
}

interface DropIndicator {
  key: string
  position: TocInsertPosition
}

function RowMenuDropdown({
  ariaLabel,
  items,
}: {
  ariaLabel: string
  items: ContextMenuEntry[]
}) {
  const skipFocusRestore = useRef(false)
  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (open) skipFocusRestore.current = false
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="toc-more-btn"
          aria-label={ariaLabel}
          title="更多操作"
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal size={13} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="context-menu"
          align="end"
          sideOffset={4}
          collisionPadding={8}
          onCloseAutoFocus={(event) => {
            if (skipFocusRestore.current) {
              event.preventDefault()
              skipFocusRestore.current = false
            }
          }}
        >
          {items.map((item) => (
            <div key={item.id}>
              {item.separatorBefore ? <DropdownMenu.Separator className="context-menu-sep" /> : null}
              <DropdownMenu.Item
                className={`context-menu-item${item.danger ? ' is-danger' : ''}`}
                disabled={item.disabled}
                title={item.title}
                onSelect={() => {
                  if (item.opensDialog) skipFocusRestore.current = true
                  item.onSelect()
                }}
              >
                {item.icon ? (
                  <span className="context-menu-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                ) : null}
                <span className="context-menu-label">{item.label}</span>
              </DropdownMenu.Item>
            </div>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

export function TocPanel({
  pkg,
  entries,
  broken,
  tocPath,
  files,
  texts,
  activePath,
  activeTocHref,
  canUndo,
  canRedo,
  suggestTitle,
  onNavigate,
  onChange,
  onUndo,
  onRedo,
  onInitializeToc,
}: TocPanelProps) {
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [brokenOnly, setBrokenOnly] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set())
  const [multiSelectMode, setMultiSelectMode] = useState(false)
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null)
  const [linkModal, setLinkModal] = useState<LinkModalState | null>(null)
  const [generateOpen, setGenerateOpen] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null)

  const feedbackTimer = useRef<number | null>(null)

  const showFeedback = (message: string) => {
    setFeedback(message)
    if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current)
    feedbackTimer.current = window.setTimeout(() => {
      feedbackTimer.current = null
      setFeedback(null)
    }, 4500)
  }

  useEffect(
    () => () => {
      if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current)
    },
    [],
  )

  const brokenHrefs = useMemo(() => new Set(broken.map((entry) => entry.href)), [broken])
  const flat = useMemo(() => flattenTree(entries), [entries])
  const flatKeySet = useMemo(() => new Set(flat.map((item) => item.key)), [flat])

  // Clear stale selections when tree shape changes.
  useEffect(() => {
    setSelectedKeys((prev) => {
      if (prev.size === 0) return prev
      const next = new Set<string>()
      for (const key of prev) {
        if (flatKeySet.has(key)) next.add(key)
      }
      return next.size === prev.size ? prev : next
    })
  }, [flatKeySet])

  // Automatically clear broken-only filter once every broken anchor is resolved.
  useEffect(() => {
    if (broken.length === 0 && brokenOnly) setBrokenOnly(false)
  }, [broken.length, brokenOnly])

  const isFiltering = query.trim().length > 0 || brokenOnly

  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (isFiltering) {
      return flat.filter(({ entry }) => {
        if (brokenOnly && !brokenHrefs.has(entry.href)) return false
        if (!q) return true
        return entry.label.toLowerCase().includes(q) || entry.href.toLowerCase().includes(q)
      })
    }
    const visible: FlatEntry[] = []
    for (const item of flat) {
      let hidden = false
      for (let len = 1; len < item.path.length; len += 1) {
        if (collapsed.has(item.path.slice(0, len).join('.'))) {
          hidden = true
          break
        }
      }
      if (!hidden) visible.push(item)
    }
    return visible
  }, [flat, isFiltering, query, brokenOnly, brokenHrefs, collapsed])

  const activeEntryKey = useMemo(() => {
    if (!tocPath) return null
    if (activeTocHref) {
      const exact = flat.find(({ entry }) => entry.href === activeTocHref)
      if (exact) return exact.key
    }
    if (!activePath) return null
    const tocDir = dirname(tocPath)
    const byChapter = flat.find(({ entry }) => {
      if (!entry.href) return false
      const { path } = splitFragment(entry.href)
      if (!path) return false
      return resolvePath(tocDir, path) === activePath
    })
    return byChapter?.key ?? null
  }, [flat, tocPath, activeTocHref, activePath])

  if (!tocPath) {
    return (
      <div className="toc-panel toc-panel-missing">
        <EmptyState
          title="尚未建立目录"
          description="这本书还没有 nav.xhtml 或 toc.ncx。初始化后即可编排或从正文标题自动生成目录。"
          action={
            <Button variant="primary" size="sm" onClick={onInitializeToc}>
              初始化目录
            </Button>
          }
        />
      </div>
    )
  }

  const tocDirPath = tocPath

  function commitRename(path: TocPath, nextLabel: string) {
    const trimmed = nextLabel.trim()
    setEditingKey(null)
    if (!trimmed) return
    onChange(updateTocEntry(entries, path, (entry) => ({ ...entry, label: trimmed, rawHtml: '' })))
  }

  function toggleCollapse(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function expandToDepth(maxVisibleDepth: number) {
    // maxVisibleDepth = 0 -> level 1 only; 1 -> levels 1-2; Infinity -> expand all.
    if (!Number.isFinite(maxVisibleDepth)) {
      setCollapsed(new Set())
      return
    }
    const next = new Set<string>()
    for (const item of flat) {
      if (item.hasChildren && item.depth >= maxVisibleDepth) {
        next.add(item.key)
      }
    }
    setCollapsed(next)
  }

  function toggleSelect(key: string, shiftKey = false) {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (shiftKey && selectionAnchor) {
        const startIdx = visibleRows.findIndex((row) => row.key === selectionAnchor)
        const endIdx = visibleRows.findIndex((row) => row.key === key)
        if (startIdx >= 0 && endIdx >= 0) {
          const [lo, hi] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx]
          for (let i = lo; i <= hi; i += 1) {
            const row = visibleRows[i]
            if (row) next.add(row.key)
          }
          return next
        }
      }
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    setSelectionAnchor(key)
  }

  function clearSelection() {
    setSelectedKeys(new Set())
    setMultiSelectMode(false)
    setSelectionAnchor(null)
  }

  function selectedPaths(): TocPath[] {
    return [...selectedKeys].map(parseKeyToPath).filter((p) => p.length > 0)
  }

  function handleBatchIndent() {
    const paths = selectedPaths()
    if (paths.length === 0) return
    onChange(indentTocEntries(entries, paths))
    setSelectedKeys(new Set())
  }

  function handleBatchOutdent() {
    const paths = selectedPaths()
    if (paths.length === 0) return
    onChange(outdentTocEntries(entries, paths))
    setSelectedKeys(new Set())
  }

  function handleBatchMove(delta: -1 | 1) {
    const paths = selectedPaths()
    if (paths.length === 0) return
    onChange(moveTocEntries(entries, paths, delta))
    setSelectedKeys(new Set())
  }

  function handleBatchRemove(keepChildren: boolean) {
    const paths = selectedPaths()
    if (paths.length === 0) return
    onChange(removeTocEntries(entries, paths, { keepChildren }))
    clearSelection()
  }

  function handleRefreshTitles(paths?: TocPath[]) {
    const result = refreshTocLabelsFromHeadings(entries, tocDirPath, texts, browserXmlCodec, { paths })
    if (result.updatedCount === 0) {
      showFeedback(
        result.skippedRichCount > 0
          ? `标题均为最新（保留了 ${result.skippedRichCount} 条含公式标题）`
          : '目录标题已与正文一致，无需更新',
      )
      return
    }
    onChange(result.entries)
    showFeedback(
      `已刷新 ${result.updatedCount} 条标题${result.skippedRichCount > 0 ? `（跳过 ${result.skippedRichCount} 条含公式标题）` : ''}`,
    )
  }

  function handleCleanBroken() {
    const { entries: cleaned, removedCount } = removeBrokenTocEntries(entries, tocDirPath, texts as Map<string, string>)
    if (removedCount === 0) {
      showFeedback('没有失效锚点需要清理')
      return
    }
    onChange(cleaned)
    showFeedback(`已清理 ${removedCount} 个失效锚点（有效子项已保留）`)
  }

  function openAddDialog(targetPath: TocPath = [], position: TocInsertPosition = 'after', subtitle?: string) {
    setLinkModal({
      mode: 'add',
      targetPath,
      position,
      subtitle,
      initialLabel: '',
      initialHref: '',
    })
  }

  function openEditDialog(item: FlatEntry) {
    setLinkModal({
      mode: 'edit',
      targetPath: item.path,
      position: 'after',
      subtitle: `修改「${item.entry.label || '未命名'}」的目标文件、锚点或标题`,
      initialLabel: item.entry.label,
      initialHref: item.entry.href,
    })
  }

  function buildRowMenuItems(item: FlatEntry): ContextMenuEntry[] {
    const { entry, depth, path, key, hasChildren, siblingIndex, siblingCount } = item
    const canMoveUp = siblingIndex > 0
    const canMoveDown = siblingIndex < siblingCount - 1
    const canIndent = siblingIndex > 0
    const canOutdent = depth > 0

    return [
      {
        id: 'rename',
        label: '重命名 (F2)',
        icon: <Pencil size={14} strokeWidth={1.6} />,
        onSelect: () => setEditingKey(key),
      },
      {
        id: 'edit-link',
        label: brokenHrefs.has(entry.href) ? '修复链接 / 锚点' : '编辑链接 / 锚点',
        icon: <Link2 size={14} strokeWidth={1.6} />,
        opensDialog: true,
        onSelect: () => openEditDialog(item),
      },
      {
        id: 'insert-after',
        label: '在下方插入条目',
        icon: <Plus size={14} strokeWidth={1.6} />,
        separatorBefore: true,
        opensDialog: true,
        onSelect: () => openAddDialog(path, 'after', `将在「${entry.label}」之后插入同级目录项`),
      },
      {
        id: 'insert-child',
        label: '添加子项',
        icon: <CornerDownRight size={14} strokeWidth={1.6} />,
        opensDialog: true,
        onSelect: () => openAddDialog(path, 'inside', `将作为「${entry.label}」的子级目录项添加`),
      },
      {
        id: 'move-up',
        label: '上移 (Alt+↑)',
        icon: <ArrowUp size={14} strokeWidth={1.6} />,
        separatorBefore: true,
        disabled: !canMoveUp,
        onSelect: () => onChange(moveTocEntry(entries, path, -1)),
      },
      {
        id: 'move-down',
        label: '下移 (Alt+↓)',
        icon: <ArrowDown size={14} strokeWidth={1.6} />,
        disabled: !canMoveDown,
        onSelect: () => onChange(moveTocEntry(entries, path, 1)),
      },
      {
        id: 'indent',
        label: '缩进为上一项子项 (Tab)',
        icon: <IndentIncrease size={14} strokeWidth={1.6} />,
        disabled: !canIndent,
        onSelect: () => onChange(indentTocEntry(entries, path)),
      },
      {
        id: 'outdent',
        label: '取消缩进升一级 (Shift+Tab)',
        icon: <IndentDecrease size={14} strokeWidth={1.6} />,
        disabled: !canOutdent,
        onSelect: () => onChange(outdentTocEntry(entries, path)),
      },
      {
        id: 'refresh-title',
        label: '从正文刷新此项标题',
        icon: <RefreshCw size={14} strokeWidth={1.6} />,
        separatorBefore: true,
        onSelect: () => handleRefreshTitles([path]),
      },
      ...(hasChildren
        ? [
            {
              id: 'remove-keep-children',
              label: '仅删除此项（子项上提）',
              icon: <FolderMinus size={14} strokeWidth={1.6} />,
              separatorBefore: true,
              onSelect: () => onChange(removeTocEntry(entries, path, { keepChildren: true })),
            },
            {
              id: 'remove-subtree',
              label: '连同子项全部删除',
              icon: <Trash2 size={14} strokeWidth={1.6} />,
              danger: true,
              onSelect: () => onChange(removeTocEntry(entries, path)),
            },
          ]
        : [
            {
              id: 'remove',
              label: '删除条目',
              icon: <Trash2 size={14} strokeWidth={1.6} />,
              separatorBefore: true,
              danger: true,
              onSelect: () => onChange(removeTocEntry(entries, path)),
            },
          ]),
    ]
  }

  function handleListKeyDown(event: React.KeyboardEvent<HTMLUListElement>) {
    const target = event.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
      return
    }

    const mod = event.metaKey || event.ctrlKey
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) onRedo()
      else onUndo()
      return
    }
    if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      onRedo()
      return
    }

    if (visibleRows.length === 0) return
    const currentIndex = visibleRows.findIndex((row) => row.key === focusedKey)
    const activeRow = currentIndex >= 0 ? visibleRows[currentIndex] : undefined

    if (event.key === 'ArrowDown' && !event.altKey) {
      event.preventDefault()
      const nextRow = visibleRows[Math.min(visibleRows.length - 1, currentIndex + 1)]
      if (nextRow) setFocusedKey(nextRow.key)
      return
    }
    if (event.key === 'ArrowUp' && !event.altKey) {
      event.preventDefault()
      const prevRow = visibleRows[Math.max(0, currentIndex <= 0 ? 0 : currentIndex - 1)]
      if (prevRow) setFocusedKey(prevRow.key)
      return
    }

    if (!activeRow) return

    if (event.key === 'ArrowRight' && activeRow.hasChildren && collapsed.has(activeRow.key)) {
      event.preventDefault()
      toggleCollapse(activeRow.key)
      return
    }
    if (event.key === 'ArrowLeft' && activeRow.hasChildren && !collapsed.has(activeRow.key)) {
      event.preventDefault()
      toggleCollapse(activeRow.key)
      return
    }
    if (event.key === 'F2') {
      event.preventDefault()
      setEditingKey(activeRow.key)
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      if (selectedKeys.size > 0) {
        if (event.shiftKey) handleBatchOutdent()
        else handleBatchIndent()
      } else if (event.shiftKey) {
        if (activeRow.depth > 0) onChange(outdentTocEntry(entries, activeRow.path))
      } else if (activeRow.siblingIndex > 0) {
        onChange(indentTocEntry(entries, activeRow.path))
      }
      return
    }
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      const delta: -1 | 1 = event.key === 'ArrowUp' ? -1 : 1
      if (selectedKeys.size > 0) handleBatchMove(delta)
      else onChange(moveTocEntry(entries, activeRow.path, delta))
      return
    }
    if (event.key === 'Delete') {
      event.preventDefault()
      if (selectedKeys.size > 0) {
        handleBatchRemove(true)
      } else {
        // Keyboard Delete lifts children instead of silently wiping a whole subtree.
        onChange(removeTocEntry(entries, activeRow.path, { keepChildren: activeRow.hasChildren }))
      }
    }
  }

  function handleDragOver(event: React.DragEvent<HTMLLIElement>, item: FlatEntry) {
    if (!dragKey || dragKey === item.key) return
    const fromPath = parseKeyToPath(dragKey)
    if (isSameOrDescendantTocPath(fromPath, item.path)) {
      event.dataTransfer.dropEffect = 'none'
      setDropIndicator(null)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5
    const position: TocInsertPosition = ratio < 0.28 ? 'before' : ratio > 0.72 ? 'after' : 'inside'
    setDropIndicator((prev) =>
      prev && prev.key === item.key && prev.position === position ? prev : { key: item.key, position },
    )
  }

  function handleDrop(event: React.DragEvent<HTMLLIElement>, item: FlatEntry) {
    event.preventDefault()
    const sourceKey = dragKey || event.dataTransfer.getData('text/plain')
    const indicator = dropIndicator
    setDragKey(null)
    setDropIndicator(null)
    if (!sourceKey || sourceKey === item.key) return
    const fromPath = parseKeyToPath(sourceKey)
    if (fromPath.length === 0 || isSameOrDescendantTocPath(fromPath, item.path)) return
    const position = indicator && indicator.key === item.key ? indicator.position : 'after'
    onChange(moveTocSubtree(entries, fromPath, item.path, position))
  }

  const showCheckboxes = multiSelectMode || selectedKeys.size > 0
  const selectedHasChildren = useMemo(() => {
    for (const item of flat) {
      if (selectedKeys.has(item.key) && item.hasChildren) return true
    }
    return false
  }, [flat, selectedKeys])

  return (
    <div className="toc-panel">
      <div className="toc-head">
        <div className="toc-toolbar" role="toolbar" aria-label="目录工具栏">
          <div className="toc-toolbar-main">
            <Button
              variant="secondary"
              size="sm"
              className="toc-tool-btn"
              onClick={() => openAddDialog([], 'after', '将追加到目录末尾')}
            >
              <Plus size={13} strokeWidth={1.75} aria-hidden="true" />
              <span>新增</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="toc-tool-btn"
              title="从正文标题扫描并生成或补全目录"
              onClick={() => setGenerateOpen(true)}
            >
              <Sparkles size={13} strokeWidth={1.75} aria-hidden="true" />
              <span>生成</span>
            </Button>
          </div>
          <div className="toc-toolbar-icons">
            <button
              type="button"
              className="toc-icon-btn"
              aria-label="撤销目录操作"
              title="撤销目录操作 (⌘Z)"
              disabled={!canUndo}
              onClick={onUndo}
            >
              <Undo2 size={13} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="toc-icon-btn"
              aria-label="重做目录操作"
              title="重做目录操作 (⌘⇧Z)"
              disabled={!canRedo}
              onClick={onRedo}
            >
              <Redo2 size={13} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  className="toc-icon-btn"
                  aria-label="更多目录操作"
                  title="展开层级、多选与批量工具"
                >
                  <MoreHorizontal size={14} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="context-menu" align="end" sideOffset={4} collisionPadding={8}>
                  <div className="context-menu-header">目录视图与批量工具（共 {flat.length} 项）</div>
                  <DropdownMenu.Item className="context-menu-item" onSelect={() => expandToDepth(0)}>
                    <span className="context-menu-label">仅展开 1 级</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="context-menu-item" onSelect={() => expandToDepth(1)}>
                    <span className="context-menu-label">展开至 2 级</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="context-menu-item" onSelect={() => expandToDepth(Infinity)}>
                    <span className="context-menu-label">全部展开</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator className="context-menu-sep" />
                  <DropdownMenu.Item
                    className="context-menu-item"
                    onSelect={() => {
                      if (showCheckboxes) clearSelection()
                      else setMultiSelectMode(true)
                    }}
                  >
                    <span className="context-menu-icon" aria-hidden="true">
                      <CheckSquare size={14} strokeWidth={1.6} />
                    </span>
                    <span className="context-menu-label">{showCheckboxes ? '退出多选模式' : '多选批量调级'}</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator className="context-menu-sep" />
                  <DropdownMenu.Item
                    className="context-menu-item"
                    disabled={flat.length === 0}
                    onSelect={() => handleRefreshTitles()}
                  >
                    <span className="context-menu-icon" aria-hidden="true">
                      <RefreshCw size={14} strokeWidth={1.6} />
                    </span>
                    <span className="context-menu-label">从正文刷新全部标题</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="context-menu-item is-danger"
                    disabled={broken.length === 0}
                    onSelect={handleCleanBroken}
                  >
                    <span className="context-menu-icon" aria-hidden="true">
                      <Trash2 size={14} strokeWidth={1.6} />
                    </span>
                    <span className="context-menu-label">清理失效锚点（{broken.length}）</span>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </div>

        {flat.length > 0 ? (
          <div className="toc-filter-row">
            <div className="toc-search">
              <Search size={12} strokeWidth={1.75} className="toc-search-icon" aria-hidden="true" />
              <input
                type="search"
                aria-label="筛选目录"
                placeholder={`筛选 ${flat.length} 项…`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query ? (
                <button
                  type="button"
                  className="toc-search-clear"
                  aria-label="清除筛选"
                  onClick={() => setQuery('')}
                >
                  <X size={11} strokeWidth={1.75} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            {broken.length > 0 ? (
              <button
                type="button"
                className={`toc-broken-toggle${brokenOnly ? ' is-active' : ''}`}
                aria-pressed={brokenOnly}
                title="仅显示失效锚点条目"
                onClick={() => setBrokenOnly((v) => !v)}
              >
                <AlertTriangle size={11} strokeWidth={1.75} aria-hidden="true" />
                <span>{broken.length}</span>
              </button>
            ) : null}
          </div>
        ) : null}

        {selectedKeys.size > 0 ? (
          <div className="toc-batch-bar" role="region" aria-label="批量操作">
            <span className="toc-batch-count">已选 {selectedKeys.size} 项</span>
            <div className="toc-batch-actions">
              <button type="button" title="批量上移" aria-label="批量上移" onClick={() => handleBatchMove(-1)}>
                <ArrowUp size={12} strokeWidth={1.75} aria-hidden="true" />
              </button>
              <button type="button" title="批量下移" aria-label="批量下移" onClick={() => handleBatchMove(1)}>
                <ArrowDown size={12} strokeWidth={1.75} aria-hidden="true" />
              </button>
              <button type="button" title="批量缩进" aria-label="批量缩进" onClick={handleBatchIndent}>
                <IndentIncrease size={12} strokeWidth={1.75} aria-hidden="true" />
              </button>
              <button type="button" title="批量取消缩进" aria-label="批量取消缩进" onClick={handleBatchOutdent}>
                <IndentDecrease size={12} strokeWidth={1.75} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="is-danger"
                title={selectedHasChildren ? '批量删除（保留子项上提）' : '批量删除'}
                aria-label="批量删除"
                onClick={() => handleBatchRemove(selectedHasChildren)}
              >
                <Trash2 size={12} strokeWidth={1.75} aria-hidden="true" />
              </button>
              <button type="button" title="取消多选" aria-label="取消多选" onClick={clearSelection}>
                <X size={12} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
          </div>
        ) : null}

        {feedback ? (
          <p className="toc-feedback" role="status">
            <span>{feedback}</span>
            <button type="button" aria-label="关闭提示" onClick={() => setFeedback(null)}>
              <X size={11} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </p>
        ) : null}
      </div>

      {flat.length === 0 ? (
        <div className="toc-empty">
          <EmptyState
            title="目录为空"
            description="可以直接从正文章节标题自动生成目录，或手动添加第一条目录。"
            action={
              <div className="toc-empty-actions">
                <Button variant="primary" size="sm" onClick={() => setGenerateOpen(true)}>
                  <Sparkles size={13} strokeWidth={1.75} aria-hidden="true" />
                  <span>从标题生成</span>
                </Button>
                <Button variant="secondary" size="sm" onClick={() => openAddDialog([], 'after')}>
                  新增条目
                </Button>
              </div>
            }
          />
        </div>
      ) : visibleRows.length === 0 ? (
        <div className="toc-empty-filter">
          <p>没有匹配的目录项</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQuery('')
              setBrokenOnly(false)
            }}
          >
            清除筛选
          </Button>
        </div>
      ) : (
        <ul
          className="toc-list"
          role="tree"
          aria-label="书籍目录"
          tabIndex={0}
          onKeyDown={handleListKeyDown}
        >
          {visibleRows.map((item) => {
            const { entry, depth, path, key, hasChildren } = item
            const isBroken = brokenHrefs.has(entry.href)
            const isCollapsed = collapsed.has(key)
            const isSelected = selectedKeys.has(key)
            const isActive = activeEntryKey === key
            const isFocused = focusedKey === key
            const isEditing = editingKey === key
            const dropClass =
              dropIndicator && dropIndicator.key === key ? ` drop-${dropIndicator.position}` : ''
            const visualDepth = Math.min(depth, 5)
            const menuItems = buildRowMenuItems(item)

            return (
              <ContextMenu
                key={key}
                ariaLabel={`${entry.label || '目录项'} 的操作`}
                header={
                  <span className="context-menu-title" title={entry.href}>
                    {entry.label || '（空标题）'}
                  </span>
                }
                items={menuItems}
              >
                <li
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-expanded={hasChildren ? !isCollapsed : undefined}
                  aria-selected={isSelected || isActive}
                  data-toc-key={key}
                  data-toc-depth={depth}
                  className={`toc-item${isActive ? ' is-active' : ''}${isSelected ? ' is-selected' : ''}${isFocused ? ' is-focused' : ''}${isBroken ? ' broken' : ''}${dragKey === key ? ' is-dragging' : ''}${dropClass}`}
                  style={{ paddingLeft: `${8 + visualDepth * 14}px` }}
                  draggable={!isEditing && !isFiltering}
                  onDragStart={(event) => {
                    setDragKey(key)
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', key)
                  }}
                  onDragOver={(event) => handleDragOver(event, item)}
                  onDragLeave={() => {
                    setDropIndicator((prev) => (prev?.key === key ? null : prev))
                  }}
                  onDrop={(event) => handleDrop(event, item)}
                  onDragEnd={() => {
                    setDragKey(null)
                    setDropIndicator(null)
                  }}
                >
                  {showCheckboxes ? (
                    <input
                      type="checkbox"
                      className="toc-select-box"
                      checked={isSelected}
                      aria-label={`选择 ${entry.label || '目录项'}`}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => toggleSelect(key, (event.nativeEvent as MouseEvent).shiftKey)}
                    />
                  ) : null}

                  {hasChildren ? (
                    <button
                      type="button"
                      className="toc-chevron"
                      aria-label={isCollapsed ? `展开 ${entry.label}` : `折叠 ${entry.label}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggleCollapse(key)
                      }}
                    >
                      {isCollapsed ? (
                        <ChevronRight size={12} strokeWidth={1.75} aria-hidden="true" />
                      ) : (
                        <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
                      )}
                    </button>
                  ) : (
                    <span className="toc-chevron-spacer" aria-hidden="true" />
                  )}

                  {isEditing ? (
                    <input
                      className="toc-edit"
                      aria-label="重命名目录项"
                      autoFocus
                      defaultValue={entry.label}
                      onBlur={(event) => commitRename(path, event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          commitRename(path, event.currentTarget.value)
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          setEditingKey(null)
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="toc-label"
                      title={entry.href ? `${entry.label}\n${entry.href}` : entry.label}
                      onClick={(event) => {
                        setFocusedKey(key)
                        if (event.shiftKey || event.metaKey || event.ctrlKey) {
                          event.preventDefault()
                          toggleSelect(key, event.shiftKey)
                          return
                        }
                        setSelectionAnchor(key)
                        if (entry.href) onNavigate(entry.href)
                      }}
                      onDoubleClick={(event) => {
                        event.stopPropagation()
                        setEditingKey(key)
                      }}
                    >
                      <span className="toc-label-text">{entry.label || '（空标题）'}</span>
                    </button>
                  )}

                  {isBroken && !isEditing ? (
                    <button
                      type="button"
                      className="toc-warn-pill"
                      title="锚点失效，点击修复链接"
                      onClick={(event) => {
                        event.stopPropagation()
                        openEditDialog(item)
                      }}
                    >
                      <AlertTriangle size={10} strokeWidth={1.9} aria-hidden="true" />
                      <span>断链</span>
                    </button>
                  ) : null}

                  {!isEditing ? (
                    <span className="toc-row-more">
                      <RowMenuDropdown ariaLabel={`${entry.label || '目录项'} 的更多操作`} items={menuItems} />
                    </span>
                  ) : null}
                </li>
              </ContextMenu>
            )
          })}
        </ul>
      )}

      <TocLinkDialog
        open={linkModal !== null}
        mode={linkModal?.mode ?? 'add'}
        subtitle={linkModal?.subtitle}
        initialLabel={linkModal?.initialLabel ?? ''}
        initialHref={linkModal?.initialHref ?? ''}
        tocPath={tocDirPath}
        files={files}
        texts={texts}
        suggestTitle={suggestTitle}
        onOpenChange={(open) => {
          if (!open) setLinkModal(null)
        }}
        onSubmit={({ label, href }) => {
          if (!linkModal) return
          if (linkModal.mode === 'add') {
            onChange(
              insertTocEntry(
                entries,
                linkModal.targetPath,
                { label, href, rawHtml: '', children: [] },
                linkModal.position,
              ),
            )
            if (linkModal.position === 'inside' && linkModal.targetPath.length > 0) {
              setCollapsed((prev) => {
                const next = new Set(prev)
                next.delete(linkModal.targetPath.join('.'))
                return next
              })
            }
          } else {
            onChange(
              updateTocEntry(entries, linkModal.targetPath, (entry) => ({
                ...entry,
                label,
                href,
                rawHtml: label === entry.label ? entry.rawHtml : '',
              })),
            )
          }
        }}
      />

      <TocGenerateDialog
        open={generateOpen}
        pkg={pkg}
        texts={texts}
        tocPath={tocDirPath}
        existingEntries={entries}
        onOpenChange={setGenerateOpen}
        onApply={(nextEntries, updatedChapters, summary) => {
          onChange(nextEntries, updatedChapters)
          showFeedback(summary)
        }}
      />
    </div>
  )
}
