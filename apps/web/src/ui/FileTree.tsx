import { hasPageHistory, type AgentProposalFile } from '@booksmith/core'
import {
  ArrowDown,
  ArrowUp,
  CheckSquare,
  Copy,
  FileCode2,
  FilePlus2,
  History,
  Merge,
  Pencil,
  Plus,
  Scissors,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatShortcut } from '../editor/shortcuts'
import { basename, type LoadedBook } from '../state/bookStore'
import { ContextMenu, type ContextMenuEntry } from './ContextMenu'
import { FileTypeIcon } from './FileTypeIcon'

interface FileTreeProps {
  groups: LoadedBook['groups']
  active: string | null
  dirty: Set<string>
  /** Reading order, used to decide whether a chapter can move up or down. */
  spinePaths: string[]
  /** Number of pending `<hr class="sigil_split_marker" />` markers per chapter path. */
  markerCounts?: ReadonlyMap<string, number>
  /** Pending Agent proposal change kinds by file path while a proposal is under review. */
  reviewMarks?: ReadonlyMap<string, AgentProposalFile['kind']>
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
  onDelete: (path: string) => void
  onMove: (path: string, delta: -1 | 1) => void
}

export function FileTree({
  groups,
  active,
  dirty,
  spinePaths,
  markerCounts,
  reviewMarks,
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
  onDelete,
  onMove,
}: FileTreeProps) {
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const lastSelectedRef = useRef<string | null>(null)

  const textPaths = useMemo(
    () => groups.find((group) => group.group === 'Text')?.paths ?? [],
    [groups],
  )

  useEffect(() => {
    const valid = new Set(textPaths)
    setSelected((prev) => {
      let changed = false
      const next = new Set<string>()
      for (const path of prev) {
        if (valid.has(path)) next.add(path)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [textPaths])

  const selectedInOrder = useMemo(
    () => textPaths.filter((path) => selected.has(path)),
    [textPaths, selected],
  )

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelected(new Set())
    lastSelectedRef.current = null
  }

  const toggleSelectPath = (path: string, shiftKey: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (shiftKey && lastSelectedRef.current && textPaths.includes(lastSelectedRef.current)) {
        const from = textPaths.indexOf(lastSelectedRef.current)
        const to = textPaths.indexOf(path)
        if (from >= 0 && to >= 0) {
          const [start, end] = from <= to ? [from, to] : [to, from]
          for (let i = start; i <= end; i += 1) {
            const p = textPaths[i]
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

  const showBatchBar = selectMode || selected.size > 0

  return (
    <nav className="filetree" aria-label="书籍文件">
      {showBatchBar ? (
        <div className="tree-batch-bar" role="region" aria-label="章节批量操作">
          <span className="tree-batch-count">已选 {selectedInOrder.length} 章</span>
          <div className="tree-batch-actions">
            {onMergeSelected ? (
              <button
                type="button"
                className="tree-batch-btn"
                disabled={selectedInOrder.length < 2}
                title={selectedInOrder.length < 2 ? '至少选择 2 个章节以合并' : '按阅读顺序合并选中章节'}
                aria-label="合并选中章节"
                onClick={() => {
                  onMergeSelected(selectedInOrder)
                  exitSelectMode()
                }}
              >
                <Merge size={12} strokeWidth={1.8} aria-hidden="true" />
                <span>合并</span>
              </button>
            ) : null}
            {onLinkStylesheets ? (
              <button
                type="button"
                className="tree-batch-btn"
                disabled={selectedInOrder.length === 0}
                title="为选中章节批量关联 CSS 样式表"
                aria-label="为选中章节关联样式表"
                onClick={() => onLinkStylesheets(selectedInOrder)}
              >
                <FileCode2 size={12} strokeWidth={1.8} aria-hidden="true" />
                <span>样式表</span>
              </button>
            ) : null}
            <button
              type="button"
              className="tree-batch-close"
              aria-label="退出多选"
              title="退出多选"
              onClick={exitSelectMode}
            >
              <X size={12} strokeWidth={1.85} aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}

      {groups.map((group) => (
        <section key={group.group} className="tree-group">
          <h2 className="tree-group-label">
            <span>{group.label}</span>
            <span className="tree-group-right">
              {group.group === 'Text' && group.paths.length > 1 && (onMergeSelected || onLinkStylesheets) ? (
                <button
                  type="button"
                  className={`tree-group-action${selectMode ? ' is-active' : ''}`}
                  aria-label="多选章节"
                  aria-pressed={selectMode}
                  title={selectMode ? '退出多选模式' : '多选章节以批量合并或关联样式表'}
                  onClick={() => {
                    if (selectMode) exitSelectMode()
                    else setSelectMode(true)
                  }}
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
            const historyEnabled = hasPageHistory(path)
            const spineIndex = spinePaths.indexOf(path)
            const canMoveUp = spineIndex > 0
            const canMoveDown = spineIndex >= 0 && spineIndex < spinePaths.length - 1
            const markerCount = markerCounts?.get(path) ?? 0
            const isText = group.group === 'Text'
            const isSelected = isText && selected.has(path)

            const menuItems: ContextMenuEntry[] = [
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
                    ...(onMergeSelected && selectedInOrder.length >= 2 && isSelected
                      ? [
                          {
                            id: 'merge-selected',
                            label: `合并选中的 ${selectedInOrder.length} 章`,
                            icon: <Merge size={14} strokeWidth={1.6} />,
                            onSelect: () => {
                              onMergeSelected(selectedInOrder)
                              exitSelectMode()
                            },
                          },
                        ]
                      : []),
                    ...(onLinkStylesheets
                      ? [
                          {
                            id: 'link-css',
                            label:
                              isSelected && selectedInOrder.length > 1
                                ? `为选中的 ${selectedInOrder.length} 章关联样式表…`
                                : '关联样式表…',
                            icon: <FileCode2 size={14} strokeWidth={1.6} />,
                            separatorBefore: true,
                            opensDialog: true,
                            onSelect: () =>
                              onLinkStylesheets(isSelected && selectedInOrder.length > 1 ? selectedInOrder : [path]),
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
                opensDialog: true,
                onSelect: () => onRename(path),
              },
              {
                id: 'delete',
                label: '删除',
                icon: <Trash2 size={14} strokeWidth={1.6} />,
                danger: true,
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
                      {basename(path)}
                    </span>
                  </>
                }
                items={menuItems}
              >
                <div className={`tree-row${isSelected ? ' is-selected' : ''}`}>
                  {isText && selectMode ? (
                    <input
                      type="checkbox"
                      className="tree-checkbox"
                      checked={isSelected}
                      aria-label={`选择 ${basename(path)}`}
                      onChange={() => toggleSelectPath(path, false)}
                    />
                  ) : null}
                  <button
                    type="button"
                    className={`tree-item${active === path ? ' on' : ''}`}
                    aria-current={active === path ? 'true' : undefined}
                    aria-label={basename(path)}
                    title={path}
                    onClick={(event) => {
                      if (isText && (selectMode || event.shiftKey || event.metaKey || event.ctrlKey)) {
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
      ))}
    </nav>
  )
}
