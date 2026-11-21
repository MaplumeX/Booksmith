import { Search, X } from 'lucide-react'
import { Dialog as RadixDialog } from 'radix-ui'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

export type CommandGroup = '章节与结构' | '代码编辑' | '视图与面板' | '书籍工具'

export interface CommandItem {
  id: string
  group: CommandGroup
  label: string
  keywords?: string
  shortcut?: string
  icon?: ReactNode
  disabled?: boolean
  disabledReason?: string
  onSelect: () => void
}

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  commands: CommandItem[]
}

const GROUP_ORDER: CommandGroup[] = ['章节与结构', '代码编辑', '视图与面板', '书籍工具']

function matchesQuery(item: CommandItem, tokens: string[]): boolean {
  if (tokens.length === 0) return true
  const haystack = `${item.label} ${item.group} ${item.keywords ?? ''} ${item.shortcut ?? ''}`.toLowerCase()
  return tokens.every((token) => haystack.includes(token))
}

/**
 * Spotlight-style global `⌘K` / `Ctrl+K` command palette (`width: min(560px, calc(100vw - 32px))`).
 * Aggregates structure mutations, code actions, navigation panels, and book tools with full
 * keyboard navigation and clear disabled reasons.
 * See ADR 2026-11-21-code-productivity-and-command-palette.
 */
export function CommandPalette({ open, onOpenChange, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const tokens = query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
    return commands.filter((item) => matchesQuery(item, tokens))
  }, [commands, query])

  const grouped = useMemo(() => {
    return GROUP_ORDER.map((group) => ({
      group,
      items: filtered.filter((item) => item.group === group),
    })).filter((section) => section.items.length > 0)
  }, [filtered])

  const enabledItems = useMemo(() => filtered.filter((item) => !item.disabled), [filtered])

  useEffect(() => {
    if (open) {
      setQuery('')
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    if (!activeId || !enabledItems.some((item) => item.id === activeId)) {
      setActiveId(enabledItems[0]?.id ?? null)
    }
  }, [open, enabledItems, activeId])

  useEffect(() => {
    if (!activeId || !listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-command-id="${CSS.escape(activeId)}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  const runItem = (item: CommandItem) => {
    if (item.disabled) return
    onOpenChange(false)
    item.onSelect()
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (enabledItems.length === 0) return
      const idx = enabledItems.findIndex((item) => item.id === activeId)
      const next = enabledItems[(idx + 1 + enabledItems.length) % enabledItems.length]
      if (next) setActiveId(next.id)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (enabledItems.length === 0) return
      const idx = enabledItems.findIndex((item) => item.id === activeId)
      const prev = enabledItems[(idx - 1 + enabledItems.length) % enabledItems.length]
      if (prev) setActiveId(prev.id)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const current = enabledItems.find((item) => item.id === activeId) ?? enabledItems[0]
      if (current) runItem(current)
    }
  }

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-backdrop" />
        <RadixDialog.Content
          className="dialog command-palette"
          aria-label="命令面板"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onKeyDown={handleKeyDown}
        >
          <RadixDialog.Title className="sr-only">命令面板</RadixDialog.Title>
          <div className="command-palette-search">
            <Search size={15} strokeWidth={1.8} className="command-palette-search-icon" aria-hidden="true" />
            <input
              autoFocus
              type="text"
              className="command-palette-input"
              aria-label="搜索命令"
              placeholder="输入命令名或关键词（如 拆分、格式化、样式表、目录…）"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
              <button
                type="button"
                className="command-palette-clear"
                aria-label="清空搜索"
                onClick={() => setQuery('')}
              >
                <X size={13} strokeWidth={1.8} aria-hidden="true" />
              </button>
            ) : (
              <kbd className="command-palette-esc" aria-hidden="true">
                Esc
              </kbd>
            )}
          </div>

          <div ref={listRef} className="command-palette-list" role="listbox" aria-label="可用命令">
            {grouped.length === 0 ? (
              <div className="command-palette-empty">
                <p>没有匹配「{query}」的命令</p>
                <button type="button" className="command-palette-reset" onClick={() => setQuery('')}>
                  显示全部命令
                </button>
              </div>
            ) : (
              grouped.map((section) => (
                <div key={section.group} className="command-palette-group" role="group" aria-label={section.group}>
                  <div className="command-palette-group-label">{section.group}</div>
                  {section.items.map((item) => {
                    const isActive = !item.disabled && item.id === activeId
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        disabled={item.disabled}
                        data-command-id={item.id}
                        className={`command-palette-item${isActive ? ' is-active' : ''}`}
                        onMouseEnter={() => {
                          if (!item.disabled) setActiveId(item.id)
                        }}
                        onClick={() => runItem(item)}
                      >
                        {item.icon ? (
                          <span className="command-palette-item-icon" aria-hidden="true">
                            {item.icon}
                          </span>
                        ) : null}
                        <span className="command-palette-item-copy">
                          <span className="command-palette-item-label">{item.label}</span>
                          {item.disabled && item.disabledReason ? (
                            <span className="command-palette-item-reason">{item.disabledReason}</span>
                          ) : null}
                        </span>
                        {item.shortcut ? (
                          <kbd className="command-palette-kbd" aria-hidden="true">
                            {item.shortcut}
                          </kbd>
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
