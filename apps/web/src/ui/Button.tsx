import type { ButtonHTMLAttributes } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  ...props
}: ButtonProps) {
  const sizeClass = size === 'md' ? '' : `btn-${size}`
  return <button className={`btn btn-${variant} ${sizeClass} ${className}`.trim()} {...props} />
}
