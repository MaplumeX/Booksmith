import type { ButtonHTMLAttributes } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost'
}

export function Button({ variant = 'secondary', className = '', ...props }: ButtonProps) {
  return <button className={`btn btn-${variant} ${className}`.trim()} {...props} />
}
