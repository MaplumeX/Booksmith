import { Code2, FilePenLine, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { basename } from '../state/bookStore'
import { FileTypeIcon } from './FileTypeIcon'

export type EditorViewMode = 'code' | 'wysiwyg'

interface TabBarProps {
  tabs: string[]
  active: string | null
  dirty: Set<string>
  onSelect: (path: string) => void
  onClose: (path: string) => void
  mode?: EditorViewMode
  canWysiwyg?: boolean
  onModeChange?: (mode: EditorViewMode) => void
}

export function TabBar({
  tabs,
  active,
  dirty,
  onSelect,
  onClose,
  mode = 'code',
  canWysiwyg = false,
  onModeChange,
}: TabBarProps) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const activeTab = listRef.current?.querySelector<HTMLElement>('.tab.on')
    activeTab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  const effectiveMode: EditorViewMode = canWysiwyg ? mode : 'code'

  return (
    <div className="tabbar">
      <div
        ref={listRef}
        className="tabbar-tabs"
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

      {onModeChange && tabs.length > 0 ? (
        <div className="mode-switch" role="group" aria-label="编辑模式">
          <button
            type="button"
            className={`mode-switch-btn${effectiveMode === 'code' ? ' on' : ''}`}
            aria-pressed={effectiveMode === 'code'}
            onClick={() => onModeChange('code')}
          >
            <Code2 size={13} strokeWidth={1.75} aria-hidden="true" />
            <span>代码</span>
          </button>
          <button
            type="button"
            className={`mode-switch-btn${effectiveMode === 'wysiwyg' ? ' on' : ''}`}
            aria-pressed={effectiveMode === 'wysiwyg'}
            disabled={!canWysiwyg}
            title={canWysiwyg ? '切换到所见即所得校对模式' : '仅 .xhtml / .html 章节支持可视化编辑'}
            onClick={() => onModeChange('wysiwyg')}
          >
            <FilePenLine size={13} strokeWidth={1.75} aria-hidden="true" />
            <span>可视化</span>
          </button>
        </div>
      ) : null}
    </div>
  )
}
