import { getBatchSpineMoveCapability, hasPageHistory, type AgentProposalFile } from '@booksmith/core'
import {
  ArrowDown,
  ArrowUp,
  CheckSquare,
  Copy,
  FileCode2,
  FilePlus2,
  History,
  Lock,
  Merge,
  Pencil,
  Plus,
  Scissors,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { formatShortcut } from '../editor/shortcuts'
import { basename, type LoadedBook } from '../state/bookStore'
import { ContextMenu, type ContextMenuEntry } from './ContextMenu'
import { FileTypeIcon } from './FileTypeIcon'

export interface FileTreeSelectionRemap {
  seq: number
  map: ReadonlyMap<string, string>
}

interface FileTreeProps {
  groups: LoadedBook['groups']
  active: string | null
  dirty: Set<string>
  /** Reading order, used to decide whether chapters can move up or down. */
  spinePaths: string[]
  /** Protected archive paths (`META-INF/container.xml`, OPF) that cannot be batch-selected, renamed, or deleted. */
  protectedPaths?: ReadonlySet<string>
  /** Number of pending `<hr class="sigil_split_marker" />` markers per chapter path. */
  markerCounts?: ReadonlyMap<string, number>
  /** Pending Agent proposal change kinds by file path while a proposal is under review. */
  reviewMarks?: ReadonlyMap<string, AgentProposalFile['kind']>
  /** Remaps currently selected paths after a batch rename completes. */
  selectionRemap?: FileTreeSelectionRemap | null
  onOpen: (path: string) => void
  onHistory: (path: string) => void
  onCreate: () => void
  onCreateStylesheet?: () => void
  onDuplicate?: (path: string) => void
  onSplitAtMarkers?: (path: string) => void
  onMergeWithPrevious?: (path: string) => void
  onMergeSelected?: (paths: string[]) => void
  onLinkStylesheets?: (paths: string[]) => void
  onRename: (path: string) => void
  onBatchRename?: (paths: string[]) => void
  onDelete: (path: string) => void
  onBatchDelete?: (paths: string[]) => void
  onMove: (path: string, delta: -1 | 1) => void
  onBatchMove?: (paths: string[], delta: -1 | 1) => void
}

export function FileTree({
  groups,
  active,
  dirty,
  spinePaths,
  protectedPaths,
  markerCounts,
  reviewMarks,
  selectionRemap,
  onOpen,
  onHistory,
  onCreate,
  onCreateStylesheet,
  onDuplicate,
  onSplitAtMarkers,
  onMergeWithPrevious,
  onMergeSelected,
  onLinkStylesheets,
  onRename,
  onBatchRename,
  onDelete,
  onBatchDelete,
  onMove,
  onBatchMove,
}: FileTreeProps) {
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const lastSelectedRef = useRef<string | null>(null)
  const appliedRemapSeqRef = useRef(0)

  const textPathSet = useMemo(
    () => new Set(groups.find((group) => group.group === 'Text')?.paths ?? []),
    [groups],
  )
  const spineSet = useMemo(() => new Set(spinePaths), [spinePaths])

  // Flat list of every selectable path in visual order so Shift-range selection works across groups.
  // See ADR 2026-11-26-filetree-batch-operations.
  const allSelectablePaths = useMemo(() => {
    const out: string[] = []
    for (const group of groups) {
      for (const path of group.paths) {
        if (!protectedPaths?.has(path)) out.push(path)
      }
    }
    return out
  }, [groups, protectedPaths])

  // Remap selection before pruning when a batch rename completes so renamed items stay selected.
  useEffect(() => {
    if (!selectionRemap || selectionRemap.seq === appliedRemapSeqRef.current) return
    appliedRemapSeqRef.current = selectionRemap.seq
    setSelected((prev) => {
      if (prev.size === 0) return prev
      const next = new Set<string>()
      for (const path of prev) {
        next.add(selectionRemap.map.get(path) ?? path)
      }
      return next
    })
    if (lastSelectedRef.current) {
      lastSelectedRef.current = selectionRemap.map.get(lastSelectedRef.current) ?? lastSelectedRef.current
    }
  }, [selectionRemap])

  useEffect(() => {
    const valid = new Set(allSelectablePaths)
    setSelected((prev) => {
      let changed = false
      const next = new Set<string>()
      for (const path of prev) {
        if (valid.has(path)) next.add(path)
        else changed = true
      }
      return changed ? next : prev
    })
    if (lastSelectedRef.current && !valid.has(lastSelectedRef.current)) {
      lastSelectedRef.current = null
    }
  }, [allSelectablePaths])

  const selectedInOrder = useMemo(
    () => allSelectablePaths.filter((path) => selected.has(path)),
    [allSelectablePaths, selected],
  )

  const selectedSpineInOrder = useMemo(
    () => spinePaths.filter((path) => selected.has(path)),
    [spinePaths, selected],
  )

  const allSelectedAreText = useMemo(
    () => selectedInOrder.length > 0 && selectedInOrder.every((path) => textPathSet.has(path)),
    [selectedInOrder, textPathSet],
  )

  const allSelectedInSpine = useMemo(
    () => selectedInOrder.length > 0 && selectedInOrder.every((path) => spineSet.has(path)),
    [selectedInOrder, spineSet],
  )

  const moveCapability = useMemo(
    () =>
      allSelectedInSpine
        ? getBatchSpineMoveCapability(spinePaths, selected)
        : { canMoveUp: false, canMoveDown: false },
    [allSelectedInSpine, spinePaths, selected],
  )

  const allSelectableChecked =
    allSelectablePaths.length > 0 && selectedInOrder.length === allSelectablePaths.length

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelected(new Set())
    lastSelectedRef.current = null
  }

  const toggleSelectPath = (path: string, shiftKey: boolean) => {
    if (protectedPaths?.has(path)) return
    setSelected((prev) => {
      const next = new Set(prev)
      if (shiftKey && lastSelectedRef.current && allSelectablePaths.includes(lastSelectedRef.current)) {
        const from = allSelectablePaths.indexOf(lastSelectedRef.current)
        const to = allSelectablePaths.indexOf(path)
        if (from >= 0 && to >= 0) {
          const [start, end] = from <= to ? [from, to] : [to, from]
          for (let i = start; i <= end; i += 1) {
            const p = allSelectablePaths[i]
            if (p) next.add(p)
          }
          return next
        }
      }
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
    lastSelectedRef.current = path
  }

  const toggleSelectAll = () => {
    if (allSelectableChecked) {
      setSelected(new Set())
      lastSelectedRef.current = null
      return
    }
    setSelected(new Set(allSelectablePaths))
    lastSelectedRef.current = allSelectablePaths[allSelectablePaths.length - 1] ?? null
  }

  const toggleSelectGroup = (paths: string[]) => {
    const selectable = paths.filter((path) => !protectedPaths?.has(path))
    if (selectable.length === 0) return
    const everySelected = selectable.every((path) => selected.has(path))
    setSelected((prev) => {
      const next = new Set(prev)
      if (everySelected) {
        for (const path of selectable) next.delete(path)
      } else {
        for (const path of selectable) next.add(path)
      }
      return next
    })
    lastSelectedRef.current = selectable[selectable.length - 1] ?? null
  }

  const showBatchBar = selectMode || selected.size > 0
  const hasBatchHandlers = Boolean(
    onMergeSelected || onLinkStylesheets || onBatchRename || onBatchDelete || onBatchMove,
  )

  const handleTreeKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null
    if (
      target &&
      (target.tagName === 'TEXTAREA' ||
        target.isContentEditable ||
        (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'checkbox'))
    ) {
      return
    }

    if (event.key === 'Escape' && showBatchBar) {
      event.preventDefault()
      exitSelectMode()
      return
    }

    // Scope Cmd/Ctrl+A to active multi-select mode so focusing the file tree never hijacks editor Select All.
    // See ADR 2026-11-26-filetree-batch-operations.
    if (showBatchBar && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      toggleSelectAll()
      return
    }

    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      if (selectedInOrder.length > 0 && onBatchMove) {
        const delta: -1 | 1 = event.key === 'ArrowUp' ? -1 : 1
        if ((delta === -1 && moveCapability.canMoveUp) || (delta === 1 && moveCapability.canMoveDown)) {
          event.preventDefault()
          onBatchMove(selectedSpineInOrder, delta)
        }
      }
      return
    }

    if (showBatchBar && (event.key === 'Delete' || event.key === 'Backspace')) {
      if (selectedInOrder.length > 0 && onBatchDelete) {
        event.preventDefault()
        onBatchDelete(selectedInOrder)
      }
    }
  }

  const canMerge = Boolean(onMergeSelected && allSelectedAreText && selectedSpineInOrder.length >= 2)
  const canLinkCss = Boolean(onLinkStylesheets && allSelectedAreText && selectedInOrder.length >= 1)
  const canRename = Boolean(onBatchRename && selectedInOrder.length >= 1)
  const canDelete = Boolean(onBatchDelete && selectedInOrder.length >= 1)

  const moveUpTitle = !allSelectedInSpine
    ? selectedInOrder.length === 0
      ? '先勾选要调整顺序的章节'
      : '仅当选中项全部为阅读顺序内的章节时可批量移序'
    : moveCapability.canMoveUp
      ? '批量上移 (Alt+↑)'
      : '最靠前的选中章节已在顶部'

  const moveDownTitle = !allSelectedInSpine
    ? selectedInOrder.length === 0
      ? '先勾选要调整顺序的章节'
      : '仅当选中项全部为阅读顺序内的章节时可批量移序'
    : moveCapability.canMoveDown
      ? '批量下移 (Alt+↓)'
      : '最靠后的选中章节已在底部'

  const mergeTitle =
    selectedInOrder.length === 0
      ? '至少选择 2 个正文章节以合并'
      : !allSelectedAreText
        ? '仅支持合并正文章节（TEXT 分组）'
        : selectedSpineInOrder.length < 2
          ? '至少选择 2 个阅读顺序内的章节以合并'
          : '按阅读顺序合并选中章节'

  const cssTitle =
    selectedInOrder.length === 0
      ? '先勾选要关联样式表的章节'
      : !allSelectedAreText
        ? '仅支持为正文章节（TEXT 分组）批量关联样式表'
        : '为选中章节批量关联 CSS 样式表'

  return (
    <nav className="filetree" aria-label="书籍文件" tabIndex={-1} onKeyDown={handleTreeKeyDown}>
      {hasBatchHandlers && allSelectablePaths.length > 0 ? (
        <div className="tree-sticky-header">
          {showBatchBar ? (
            <div className="tree-batch-bar" role="region" aria-label="文件批量操作">
              <div className="tree-batch-top">
                <span className="tree-batch-count">已选 {selectedInOrder.length} 项</span>
                <div className="tree-batch-top-actions">
                  <button
                    type="button"
                    className="tree-batch-link"
                    disabled={allSelectablePaths.length === 0}
                    onClick={toggleSelectAll}
                  >
                    {allSelectableChecked ? '取消全选' : '全选'}
                  </button>
                  <button
                    type="button"
                    className="tree-batch-done"
                    aria-label="退出多选"
                    title="退出多选模式 (Esc)"
                    onClick={exitSelectMode}
                  >
                    完成
                  </button>
                </div>
              </div>
              <div className="tree-batch-actions">
                {onBatchMove ? (
                  <>
                    <button
                      type="button"
                      className="tree-batch-icon-btn"
                      disabled={!moveCapability.canMoveUp}
                      title={moveUpTitle}
                      aria-label="批量上移"
                      onClick={() => onBatchMove(selectedSpineInOrder, -1)}
                    >
                      <ArrowUp size={13} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="tree-batch-icon-btn"
                      disabled={!moveCapability.canMoveDown}
                      title={moveDownTitle}
                      aria-label="批量下移"
                      onClick={() => onBatchMove(selectedSpineInOrder, 1)}
                    >
                      <ArrowDown size={13} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                  </>
                ) : null}
                {onMergeSelected ? (
                  <button
                    type="button"
                    className="tree-batch-icon-btn"
                    disabled={!canMerge}
                    title={mergeTitle}
                    aria-label="合并选中章节"
                    onClick={() => {
                      onMergeSelected(selectedSpineInOrder)
                      exitSelectMode()
                    }}
                  >
                    <Merge size={13} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                ) : null}
                {onLinkStylesheets ? (
                  <button
                    type="button"
                    className="tree-batch-icon-btn"
                    disabled={!canLinkCss}
                    title={cssTitle}
                    aria-label="为选中章节关联样式表"
                    onClick={() => onLinkStylesheets(selectedInOrder)}
                  >
                    <FileCode2 size={13} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                ) : null}
                {onBatchRename ? (
                  <button
                    type="button"
                    className="tree-batch-icon-btn"
                    disabled={!canRename}
                    title={canRename ? `批量重命名选中的 ${selectedInOrder.length} 个文件` : '先勾选要重命名的文件'}
                    aria-label="批量重命名"
                    onClick={() => onBatchRename(selectedInOrder)}
                  >
                    <Pencil size={13} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                ) : null}
                {onBatchDelete ? (
                  <button
                    type="button"
                    className="tree-batch-icon-btn is-danger"
                    disabled={!canDelete}
                    title={canDelete ? `批量删除选中的 ${selectedInOrder.length} 个文件 (Delete)` : '先勾选要删除的文件'}
                    aria-label="批量删除"
                    onClick={() => onBatchDelete(selectedInOrder)}
                  >
                    <Trash2 size={13} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="tree-toolbar">
              <span className="tree-toolbar-meta">{allSelectablePaths.length} 个可管理文件</span>
              <button
                type="button"
                className="tree-toolbar-btn"
                aria-label="多选文件"
                aria-pressed={false}
                title="进入多选模式以批量删除、重命名、移序或合并（也可按住 Shift / Ctrl 点击）"
                onClick={() => setSelectMode(true)}
              >
                <CheckSquare size={12} strokeWidth={1.75} aria-hidden="true" />
                <span>多选</span>
              </button>
            </div>
          )}
        </div>
      ) : null}

      <div className="tree-scroll">
        {groups.map((group) => {
          const groupSelectable = group.paths.filter((path) => !protectedPaths?.has(path))
          const groupAllSelected =
            groupSelectable.length > 0 && groupSelectable.every((path) => selected.has(path))

          return (
            <section key={group.group} className="tree-group">
              <h2 className="tree-group-label">
                <span>{group.label}</span>
                <span className="tree-group-right">
                  {showBatchBar && groupSelectable.length > 0 ? (
                    <button
                      type="button"
                      className={`tree-group-action${groupAllSelected ? ' is-active' : ''}`}
                      aria-label={groupAllSelected ? `取消全选 ${group.label}` : `全选 ${group.label}`}
                      aria-pressed={groupAllSelected}
                      title={groupAllSelected ? `取消全选 ${group.label}` : `全选 ${group.label}`}
                      onClick={() => toggleSelectGroup(group.paths)}
                    >
                      <CheckSquare size={12} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  ) : null}
                  {group.group === 'Styles' && onCreateStylesheet ? (
                    <button
                      type="button"
                      className="tree-group-action"
                      aria-label="新建样式表"
                      title="新建空白 CSS 样式表"
                      onClick={onCreateStylesheet}
                    >
                      <Plus size={12} strokeWidth={1.9} aria-hidden="true" />
                    </button>
                  ) : null}
                  <span className="tree-count">{group.paths.length}</span>
                </span>
              </h2>
              {group.paths.map((path) => {
                const isProtected = Boolean(protectedPaths?.has(path))
                const historyEnabled = hasPageHistory(path)
                const spineIndex = spinePaths.indexOf(path)
                const canMoveUp = spineIndex > 0
                const canMoveDown = spineIndex >= 0 && spineIndex < spinePaths.length - 1
                const markerCount = markerCounts?.get(path) ?? 0
                const isText = group.group === 'Text'
                const isSelected = !isProtected && selected.has(path)
                const useMultiMenu = isSelected && selectedInOrder.length > 1

                const menuItems: ContextMenuEntry[] = useMultiMenu
                  ? [
                      ...(onMergeSelected && allSelectedAreText && selectedSpineInOrder.length >= 2
                        ? [
                            {
                              id: 'merge-selected',
                              label: `合并选中的 ${selectedSpineInOrder.length} 章`,
                              icon: <Merge size={14} strokeWidth={1.6} />,
                              onSelect: () => {
                                onMergeSelected(selectedSpineInOrder)
                                exitSelectMode()
                              },
                            },
                          ]
                        : []),
                      ...(onLinkStylesheets && allSelectedAreText
                        ? [
                            {
                              id: 'link-css-selected',
                              label: `为选中的 ${selectedInOrder.length} 章关联样式表…`,
                              icon: <FileCode2 size={14} strokeWidth={1.6} />,
                              opensDialog: true,
                              onSelect: () => onLinkStylesheets(selectedInOrder),
                            },
                          ]
                        : []),
                      ...(onBatchMove && allSelectedInSpine
                        ? [
                            {
                              id: 'batch-move-up',
                              label: `批量上移选中的 ${selectedSpineInOrder.length} 章`,
                              icon: <ArrowUp size={14} strokeWidth={1.6} />,
                              separatorBefore: allSelectedAreText,
                              disabled: !moveCapability.canMoveUp,
                              onSelect: () => onBatchMove(selectedSpineInOrder, -1),
                            },
                            {
                              id: 'batch-move-down',
                              label: `批量下移选中的 ${selectedSpineInOrder.length} 章`,
                              icon: <ArrowDown size={14} strokeWidth={1.6} />,
                              disabled: !moveCapability.canMoveDown,
                              onSelect: () => onBatchMove(selectedSpineInOrder, 1),
                            },
                          ]
                        : []),
                      ...(onBatchRename
                        ? [
                            {
                              id: 'batch-rename',
                              label: `批量重命名选中的 ${selectedInOrder.length} 项…`,
                              icon: <Pencil size={14} strokeWidth={1.6} />,
                              separatorBefore: allSelectedAreText || allSelectedInSpine,
                              opensDialog: true,
                              onSelect: () => onBatchRename(selectedInOrder),
                            },
                          ]
                        : []),
                      ...(onBatchDelete
                        ? [
                            {
                              id: 'batch-delete',
                              label: `批量删除选中的 ${selectedInOrder.length} 项…`,
                              icon: <Trash2 size={14} strokeWidth={1.6} />,
                              danger: true,
                              opensDialog: true,
                              onSelect: () => onBatchDelete(selectedInOrder),
                            },
                          ]
                        : []),
                    ]
                  : [
                      ...(isText
                        ? [
                            {
                              id: 'create',
                              label: '新建章节',
                              icon: <FilePlus2 size={14} strokeWidth={1.6} />,
                              onSelect: onCreate,
                            },
                            ...(onDuplicate
                              ? [
                                  {
                                    id: 'duplicate',
                                    label: '复制章节',
                                    icon: <Copy size={14} strokeWidth={1.6} />,
                                    onSelect: () => onDuplicate(path),
                                  },
                                ]
                              : []),
                            ...(onSplitAtMarkers
                              ? [
                                  {
                                    id: 'split-markers',
                                    label: markerCount > 0 ? `按标记拆分（${markerCount} 处）` : '按标记拆分',
                                    icon: <Scissors size={14} strokeWidth={1.6} />,
                                    separatorBefore: true,
                                    disabled: markerCount === 0,
                                    title:
                                      markerCount === 0
                                        ? `先在正文插入拆分标记（${formatShortcut('Mod+Shift+Enter')}）后再按标记批量拆分`
                                        : undefined,
                                    onSelect: () => onSplitAtMarkers(path),
                                  },
                                ]
                              : []),
                            ...(onMergeWithPrevious
                              ? [
                                  {
                                    id: 'merge-prev',
                                    label: '与上一章合并',
                                    icon: <Merge size={14} strokeWidth={1.6} />,
                                    disabled: spineIndex <= 0,
                                    title: spineIndex <= 0 ? '第一章无法与上一章合并' : undefined,
                                    onSelect: () => onMergeWithPrevious(path),
                                  },
                                ]
                              : []),
                            ...(onLinkStylesheets
                              ? [
                                  {
                                    id: 'link-css',
                                    label: '关联样式表…',
                                    icon: <FileCode2 size={14} strokeWidth={1.6} />,
                                    separatorBefore: true,
                                    opensDialog: true,
                                    onSelect: () => onLinkStylesheets([path]),
                                  },
                                ]
                              : []),
                          ]
                        : []),
                      ...(group.group === 'Styles' && onCreateStylesheet
                        ? [
                            {
                              id: 'create-css',
                              label: '新建样式表',
                              icon: <FilePlus2 size={14} strokeWidth={1.6} />,
                              onSelect: onCreateStylesheet,
                            },
                          ]
                        : []),
                      {
                        id: 'rename',
                        label: '重命名',
                        icon: <Pencil size={14} strokeWidth={1.6} />,
                        separatorBefore: isText || group.group === 'Styles',
                        disabled: isProtected,
                        title: isProtected ? '受保护的容器文件无法重命名' : undefined,
                        opensDialog: true,
                        onSelect: () => onRename(path),
                      },
                      {
                        id: 'delete',
                        label: '删除',
                        icon: <Trash2 size={14} strokeWidth={1.6} />,
                        danger: true,
                        disabled: isProtected,
                        title: isProtected ? '受保护的容器文件无法删除' : undefined,
                        opensDialog: true,
                        onSelect: () => onDelete(path),
                      },
                      {
                        id: 'move-up',
                        label: '章节上移',
                        icon: <ArrowUp size={14} strokeWidth={1.6} />,
                        separatorBefore: true,
                        disabled: !canMoveUp,
                        title: spineIndex < 0 ? '只有阅读顺序里的章节可以调整' : undefined,
                        onSelect: () => onMove(path, -1),
                      },
                      {
                        id: 'move-down',
                        label: '章节下移',
                        icon: <ArrowDown size={14} strokeWidth={1.6} />,
                        disabled: !canMoveDown,
                        onSelect: () => onMove(path, 1),
                      },
                      {
                        id: 'history',
                        label: '版本历史',
                        icon: <History size={14} strokeWidth={1.6} />,
                        separatorBefore: true,
                        disabled: !historyEnabled,
                        title: historyEnabled ? undefined : '图片与容器文件没有历史',
                        opensDialog: true,
                        onSelect: () => onHistory(path),
                      },
                    ]

                return (
                  <ContextMenu
                    key={path}
                    ariaLabel={`${basename(path)} 的操作`}
                    header={
                      <>
                        <FileTypeIcon path={path} group={group.group} size={13} />
                        <span className="context-menu-title" title={path}>
                          {useMultiMenu ? `已选 ${selectedInOrder.length} 项` : basename(path)}
                        </span>
                      </>
                    }
                    items={menuItems}
                  >
                    <div
                      className={`tree-row${isSelected ? ' is-selected' : ''}${isProtected && showBatchBar ? ' is-protected' : ''}`}
                    >
                      {showBatchBar ? (
                        isProtected ? (
                          <span
                            className="tree-protected-lock"
                            title="受保护的容器文件不可参与批量操作"
                            aria-label={`${basename(path)} 受保护，不可多选`}
                          >
                            <Lock size={11} strokeWidth={1.75} aria-hidden="true" />
                          </span>
                        ) : (
                          <input
                            type="checkbox"
                            className="tree-checkbox"
                            checked={isSelected}
                            aria-label={`选择 ${basename(path)}`}
                            onChange={() => toggleSelectPath(path, false)}
                          />
                        )
                      ) : null}
                      <button
                        type="button"
                        className={`tree-item${active === path ? ' on' : ''}`}
                        aria-current={active === path ? 'true' : undefined}
                        aria-label={basename(path)}
                        title={isProtected ? `${path}（受保护的容器文件）` : path}
                        onClick={(event) => {
                          if (
                            !isProtected &&
                            (selectMode || event.shiftKey || event.metaKey || event.ctrlKey)
                          ) {
                            toggleSelectPath(path, event.shiftKey)
                            return
                          }
                          onOpen(path)
                        }}
                      >
                        <FileTypeIcon path={path} group={group.group} size={14} className="tree-icon" />
                        <span className="tree-name">{basename(path)}</span>
                        {reviewMarks?.has(path) ? (
                          <span
                            className={`tree-review-badge is-${reviewMarks.get(path)!}`}
                            title="待审阅变更"
                          >
                            {reviewMarks.get(path) === 'create'
                              ? '增'
                              : reviewMarks.get(path) === 'delete'
                                ? '删'
                                : reviewMarks.get(path) === 'rename'
                                  ? '移'
                                  : '改'}
                          </span>
                        ) : null}
                        {markerCount > 0 ? (
                          <span className="tree-marker-badge" title={`${markerCount} 处待拆分标记`}>
                            ✂{markerCount}
                          </span>
                        ) : null}
                        {dirty.has(path) ? <span className="dirty-dot" aria-hidden="true" /> : null}
                      </button>
                    </div>
                  </ContextMenu>
                )
              })}
            </section>
          )
        })}
      </div>
    </nav>
  )
}
