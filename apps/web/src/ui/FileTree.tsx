import { hasPageHistory } from '@booksmith/core'
import { useEffect, useRef, useState } from 'react'
import { basename, type LoadedBook } from '../state/bookStore'

interface FileTreeProps {
  groups: LoadedBook['groups']
  active: string | null
  dirty: Set<string>
  onOpen: (path: string) => void
  onHistory: (path: string) => void
}

interface MenuState {
  path: string
  x: number
  y: number
}

export function FileTree({ groups, active, dirty, onOpen, onHistory }: FileTreeProps) {
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
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus()
  }, [menu])

  const historyEnabled = menu ? hasPageHistory(menu.path) : false

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
                setMenu({ path, x: event.clientX, y: event.clientY })
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
          <button
            type="button"
            role="menuitem"
            className="context-menu-item"
            disabled={!historyEnabled}
            title={historyEnabled ? undefined : '图片与容器文件没有历史'}
            onClick={() => {
              const path = menu.path
              setMenu(null)
              onHistory(path)
            }}
          >
            版本历史
          </button>
        </div>
      ) : null}
    </nav>
  )
}
