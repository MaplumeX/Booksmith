import { hasPageHistory } from '@booksmith/core'
import { ArrowDown, ArrowUp, FilePlus2, History, Pencil, Trash2 } from 'lucide-react'
import { basename, type LoadedBook } from '../state/bookStore'
import { ContextMenu, type ContextMenuEntry } from './ContextMenu'
import { FileTypeIcon } from './FileTypeIcon'

interface FileTreeProps {
  groups: LoadedBook['groups']
  active: string | null
  dirty: Set<string>
  /** Reading order, used to decide whether a chapter can move up or down. */
  spinePaths: string[]
  onOpen: (path: string) => void
  onHistory: (path: string) => void
  onCreate: () => void
  onRename: (path: string) => void
  onDelete: (path: string) => void
  onMove: (path: string, delta: -1 | 1) => void
}

export function FileTree({
  groups,
  active,
  dirty,
  spinePaths,
  onOpen,
  onHistory,
  onCreate,
  onRename,
  onDelete,
  onMove,
}: FileTreeProps) {
  return (
    <nav className="filetree" aria-label="书籍文件">
      {groups.map((group) => (
        <section key={group.group} className="tree-group">
          <h2 className="tree-group-label">
            <span>{group.label}</span>
            <span className="tree-count">{group.paths.length}</span>
          </h2>
          {group.paths.map((path) => {
            const historyEnabled = hasPageHistory(path)
            const spineIndex = spinePaths.indexOf(path)
            const canMoveUp = spineIndex > 0
            const canMoveDown = spineIndex >= 0 && spineIndex < spinePaths.length - 1

            const menuItems: ContextMenuEntry[] = [
              ...(group.group === 'Text'
                ? [
                    {
                      id: 'create',
                      label: '新建章节',
                      icon: <FilePlus2 size={14} strokeWidth={1.6} />,
                      onSelect: onCreate,
                    },
                  ]
                : []),
              {
                id: 'rename',
                label: '重命名',
                icon: <Pencil size={14} strokeWidth={1.6} />,
                separatorBefore: group.group === 'Text',
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
                <button
                  type="button"
                  className={`tree-item${active === path ? ' on' : ''}`}
                  aria-current={active === path ? 'true' : undefined}
                  aria-label={basename(path)}
                  title={path}
                  onClick={() => onOpen(path)}
                >
                  <FileTypeIcon path={path} group={group.group} size={14} className="tree-icon" />
                  <span className="tree-name">{basename(path)}</span>
                  {dirty.has(path) ? <span className="dirty-dot" aria-hidden="true" /> : null}
                </button>
              </ContextMenu>
            )
          })}
        </section>
      ))}
    </nav>
  )
}
