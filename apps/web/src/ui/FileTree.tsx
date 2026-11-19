import { hasPageHistory } from '@booksmith/core'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { basename, type FileGroup, type LoadedBook } from '../state/bookStore'

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

const SCROLL_GUARD_MS = 200

interface MenuState {
  path: string
  group: FileGroup
  x: number
  y: number
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
  const [menu, setMenu] = useState<MenuState | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    // Opening the menu can scroll the tree (the clicked row is brought into view), and that same
    // scroll would immediately close it. Only later scrolling means the user moved away.
    const scrollTimer = window.setTimeout(
      () => window.addEventListener('scroll', close, true),
      SCROLL_GUARD_MS,
    )
    return () => {
      window.clearTimeout(scrollTimer)
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  useEffect(() => {
    // Moving focus must not scroll the tree: any scroll closes the menu.
    menuRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus({ preventScroll: true })
  }, [menu])

  // The menu is fixed-positioned at the pointer, so a right-click near an edge would push it off
  // screen. Pull it back inside the viewport before anything reads its box.
  useLayoutEffect(() => {
    const element = menuRef.current
    if (!menu || !element) return
    const rect = element.getBoundingClientRect()
    const nextX = Math.max(8, menu.x - Math.max(0, rect.right - window.innerWidth + 8))
    const nextY = Math.max(8, menu.y - Math.max(0, rect.bottom - window.innerHeight + 8))
    if (nextX !== menu.x || nextY !== menu.y) setMenu({ ...menu, x: nextX, y: nextY })
  }, [menu])

  const historyEnabled = menu ? hasPageHistory(menu.path) : false
  const spineIndex = menu ? spinePaths.indexOf(menu.path) : -1
  const canMoveUp = spineIndex > 0
  const canMoveDown = spineIndex >= 0 && spineIndex < spinePaths.length - 1

  const run = (action: (path: string) => void) => {
    if (!menu) return
    const path = menu.path
    setMenu(null)
    action(path)
  }

  return (
    <nav className="filetree" aria-label="书籍文件">
      {groups.map((group) => (
        <section key={group.group} className="tree-group">
          <h2 className="tree-group-label">
            {group.label}
            <span className="tree-count">{group.paths.length}</span>
          </h2>
          {group.paths.map((path) => (
            <button
              key={path}
              type="button"
              className={`tree-item${active === path ? ' on' : ''}`}
              aria-current={active === path ? 'true' : undefined}
              aria-label={basename(path)}
              title={path}
              onClick={() => onOpen(path)}
              onContextMenu={(event) => {
                event.preventDefault()
                setMenu({ path, group: group.group, x: event.clientX, y: event.clientY })
              }}
            >
              <span className="tree-name">{basename(path)}</span>
              {dirty.has(path) ? <span className="dirty-dot" aria-hidden="true" /> : null}
            </button>
          ))}
        </section>
      ))}

      {menu ? (
        <div
          ref={menuRef}
          className="context-menu"
          role="menu"
          aria-label={`${basename(menu.path)} 的操作`}
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <span className="context-menu-title" title={menu.path}>
            {basename(menu.path)}
          </span>
          {menu.group === 'Text' ? (
            <>
              <button
                type="button"
                role="menuitem"
                className="context-menu-item"
                onClick={() => {
                  setMenu(null)
                  onCreate()
                }}
              >
                新建章节
              </button>
              <span className="context-menu-sep" role="separator" />
            </>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="context-menu-item"
            onClick={() => run(onRename)}
          >
            重命名
          </button>
          <button
            type="button"
            role="menuitem"
            className="context-menu-item"
            onClick={() => run(onDelete)}
          >
            删除
          </button>
          <span className="context-menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="context-menu-item"
            disabled={!canMoveUp}
            title={spineIndex < 0 ? '只有阅读顺序里的章节可以调整' : undefined}
            onClick={() => run((path) => onMove(path, -1))}
          >
            章节上移
          </button>
          <button
            type="button"
            role="menuitem"
            className="context-menu-item"
            disabled={!canMoveDown}
            onClick={() => run((path) => onMove(path, 1))}
          >
            章节下移
          </button>
          <span className="context-menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="context-menu-item"
            disabled={!historyEnabled}
            title={historyEnabled ? undefined : '图片与容器文件没有历史'}
            onClick={() => run(onHistory)}
          >
            版本历史
          </button>
        </div>
      ) : null}
    </nav>
  )
}
