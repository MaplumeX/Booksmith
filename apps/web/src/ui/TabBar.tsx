import { basename } from '../state/bookStore'

interface TabBarProps {
  tabs: string[]
  active: string | null
  dirty: Set<string>
  onSelect: (path: string) => void
  onClose: (path: string) => void
}

export function TabBar({ tabs, active, dirty, onSelect, onClose }: TabBarProps) {
  return (
    <div className="tabbar" role="tablist" aria-label="已打开的文件">
      {tabs.map((path) => (
        <div
          key={path}
          className={`tab${active === path ? ' on' : ''}`}
          data-dirty={dirty.has(path) ? 'true' : 'false'}
        >
          <button
            type="button"
            role="tab"
            aria-selected={active === path}
            className="tab-label"
            onClick={() => onSelect(path)}
            title={path}
          >
            {basename(path)}
          </button>
          {dirty.has(path) ? <span className="dirty-dot" aria-hidden="true" /> : null}
          <button
            type="button"
            className="tab-close"
            aria-label={`关闭 ${basename(path)}`}
            onClick={() => onClose(path)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
