import { Loader2 } from 'lucide-react'
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { cn } from '../lib/cn'

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary-600 text-on-primary border-transparent hover:bg-primary-700 shadow-card',
  secondary: 'bg-primary-50 text-primary-700 border-primary-200 hover:bg-primary-100',
  outline: 'bg-surface-1 text-ink border-border hover:bg-surface-2 hover:border-border-strong',
  ghost: 'bg-transparent text-ink-muted border-transparent hover:bg-surface-2 hover:text-ink',
  danger: 'bg-critical-fg text-on-primary border-transparent hover:opacity-90',
}

// Every size is at least 44px tall (WCAG 2.5.8); density may shrink rows, never targets.
const SIZES: Record<ButtonSize, string> = {
  sm: 'min-h-11 px-3.5 text-xs gap-1.5',
  md: 'min-h-11 px-4 text-sm gap-2',
  lg: 'min-h-12 px-5 text-sm gap-2',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  icon?: ReactNode
  ref?: Ref<HTMLButtonElement>
}

/** One primary button per view. Destructive actions go through ConfirmDialog. */
export function Button({ variant = 'primary', size = 'md', loading = false, icon, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center rounded-lg border font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 aria-hidden="true" size={14} className="animate-spin" /> : icon}
      <span>{children}</span>
    </button>
  )
}
