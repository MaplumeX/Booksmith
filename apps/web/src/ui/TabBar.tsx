import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { basename } from '../state/bookStore'
import { FileTypeIcon } from './FileTypeIcon'

interface TabBarProps {
  tabs: string[]
  active: string | null
  dirty: Set<string>
  onSelect: (path: string) => void
  onClose: (path: string) => void
}

export function TabBar({ tabs, active, dirty, onSelect, onClose }: TabBarProps) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const activeTab = listRef.current?.querySelector<HTMLElement>('.tab.on')
    activeTab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  return (
    <div
      ref={listRef}
      className="tabbar"
      role="tablist"
      aria-label="已打开的文件"
      onWheel={(event) => {
        const el = listRef.current
        if (!el || event.deltaY === 0 || el.scrollWidth <= el.clientWidth) return
        el.scrollLeft += event.deltaY
      }}
    >
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
            <FileTypeIcon path={path} size={13} className="tab-icon" />
            <span>{basename(path)}</span>
          </button>
          {dirty.has(path) ? <span className="dirty-dot" aria-hidden="true" /> : null}
          <button
            type="button"
            className="tab-close"
            aria-label={`关闭 ${basename(path)}`}
            onClick={() => onClose(path)}
          >
            <X size={12} strokeWidth={1.85} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  )
}
