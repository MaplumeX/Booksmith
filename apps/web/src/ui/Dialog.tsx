import { X } from 'lucide-react'
import { Dialog as RadixDialog } from 'radix-ui'
import type { FormEventHandler, ReactNode } from 'react'

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  /**
   * Explicit accessible name for the dialog container when E2E tests or screen readers
   * expect a role name different from the visible heading text.
   */
  ariaLabel?: string
  size?: 'default' | 'wide'
  className?: string
  headClassName?: string
  headerExtra?: ReactNode
  footer?: ReactNode
  onSubmit?: FormEventHandler<HTMLFormElement>
  children: ReactNode
}

/**
 * Shared modal primitive built on Radix Dialog.
 * Passes `aria-labelledby={undefined}` whenever `ariaLabel` is supplied because ARIA gives
 * `aria-labelledby` precedence over `aria-label`. See ADR 2026-11-20-precision-workbench-ui.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  ariaLabel,
  size = 'default',
  className = '',
  headClassName = '',
  headerExtra,
  footer,
  onSubmit,
  children,
}: DialogProps) {
  const contentClass = `${size === 'wide' ? 'dialog dialog-wide' : 'dialog'} ${className}`.trim()

  const body = (
    <>
      <div className="dialog-body">{children}</div>
      {footer ? <div className="dialog-actions">{footer}</div> : null}
    </>
  )

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-backdrop" />
        <RadixDialog.Content
          className={contentClass}
          aria-label={ariaLabel}
          {...(ariaLabel ? { 'aria-labelledby': undefined } : {})}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <header className={`dialog-head ${headClassName}`.trim()}>
            <div className="dialog-head-copy">
              <RadixDialog.Title className="dialog-title">{title}</RadixDialog.Title>
              {headerExtra}
            </div>
            <RadixDialog.Close asChild>
              <button type="button" className="dialog-close" aria-label="关闭">
                <X size={15} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </RadixDialog.Close>
          </header>
          {description ? (
            <RadixDialog.Description className="dialog-description">{description}</RadixDialog.Description>
          ) : null}
          {onSubmit ? (
            <form className="dialog-form" onSubmit={onSubmit}>
              {body}
            </form>
          ) : (
            body
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
