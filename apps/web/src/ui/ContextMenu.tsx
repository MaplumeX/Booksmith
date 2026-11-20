import { ContextMenu as RadixContextMenu } from 'radix-ui'
import { useRef, type ReactNode } from 'react'

export interface ContextMenuEntry {
  id: string
  label: string
  icon?: ReactNode
  disabled?: boolean
  title?: string
  danger?: boolean
  separatorBefore?: boolean
  /** Set true when selecting this item opens a Dialog so closing the menu does not steal focus. */
  opensDialog?: boolean
  onSelect: () => void
}

interface ContextMenuProps {
  ariaLabel: string
  header?: ReactNode
  items: ContextMenuEntry[]
  children: ReactNode
}

/**
 * Shared right-click menu built on Radix ContextMenu.
 * Preserves `.context-menu` and `role="menuitem"` semantics while delegating collision clamping
 * and arrow-key navigation to Radix. See ADR 2026-11-20-precision-workbench-ui.
 */
export function ContextMenu({ ariaLabel, header, items, children }: ContextMenuProps) {
  const skipFocusRestore = useRef(false)

  return (
    <RadixContextMenu.Root
      onOpenChange={(open) => {
        if (open) skipFocusRestore.current = false
      }}
    >
      <RadixContextMenu.Trigger asChild>{children}</RadixContextMenu.Trigger>
      <RadixContextMenu.Portal>
        <RadixContextMenu.Content
          className="context-menu"
          aria-label={ariaLabel}
          collisionPadding={8}
          onCloseAutoFocus={(event) => {
            if (skipFocusRestore.current) {
              event.preventDefault()
              skipFocusRestore.current = false
            }
          }}
        >
          {header ? <div className="context-menu-header">{header}</div> : null}
          {items.map((item) => (
            <div key={item.id}>
              {item.separatorBefore ? <RadixContextMenu.Separator className="context-menu-sep" /> : null}
              <RadixContextMenu.Item
                className={`context-menu-item${item.danger ? ' is-danger' : ''}`}
                disabled={item.disabled}
                title={item.title}
                onSelect={() => {
                  if (item.opensDialog) skipFocusRestore.current = true
                  item.onSelect()
                }}
              >
                {item.icon ? (
                  <span className="context-menu-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                ) : null}
                <span className="context-menu-label">{item.label}</span>
              </RadixContextMenu.Item>
            </div>
          ))}
        </RadixContextMenu.Content>
      </RadixContextMenu.Portal>
    </RadixContextMenu.Root>
  )
}
