import { basename, type LoadedBook } from '../state/bookStore'

interface FileTreeProps {
  groups: LoadedBook['groups']
  active: string | null
  dirty: Set<string>
  onOpen: (path: string) => void
}

export function FileTree({ groups, active, dirty, onOpen }: FileTreeProps) {
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
            >
              <span className="tree-name">{basename(path)}</span>
              {dirty.has(path) ? <span className="dirty-dot" aria-hidden="true" /> : null}
            </button>
          ))}
        </section>
      ))}
    </nav>
  )
}
