import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '../../utils/cn'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline' | 'success'
type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

// DESIGN_SYSTEM §10.1. `danger` fills with the emergency red — keep it for
// destructive confirmations; `success` gets a real (darker) hover, fixing
// the spec's §17 gap.
const VARIANTS: Record<ButtonVariant, string> = {
  // The one gradient: a lit top edge, a tinted contact shadow, a glow on hover.
  primary:
    'bg-[image:var(--gradient-primary)] text-on-primary border-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_1px_2px_rgba(29,78,216,0.35),0_4px_12px_-4px_rgba(37,99,235,0.45)] hover:brightness-[1.08] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_2px_4px_rgba(29,78,216,0.3),0_10px_24px_-8px_rgba(37,99,235,0.55)]',
  secondary: 'bg-primary-50 text-primary-text border-primary-200 dark:border-primary-500/35 hover:bg-primary-100 hover:border-primary-300 dark:hover:border-primary-500/60',
  ghost: 'bg-transparent text-ink-subtle border-transparent hover:bg-surface-2 hover:text-ink',
  danger:
    'bg-danger text-on-danger border-transparent hover:bg-[color-mix(in_oklab,var(--color-danger)_86%,black)] shadow-[0_1px_3px_0_rgba(220,38,38,0.3)] hover:shadow-[0_4px_16px_0_rgba(220,38,38,0.3)]',
  outline: 'bg-surface-1 text-ink border-border shadow-card-sm hover:bg-surface-2 hover:border-border-strong',
  success:
    'bg-success-fg text-on-primary border-transparent hover:bg-[color-mix(in_oklab,var(--color-success-fg)_85%,black)] shadow-[0_1px_3px_0_rgba(22,163,74,0.3)] hover:shadow-[0_4px_16px_0_rgba(22,163,74,0.3)] dark:text-ink-inverse',
}

// Every size has a MIN HEIGHT — padding alone does not guarantee 44px.
// `xs` (36px) is only for dense rows that sit inside a larger target.
// From 1024px (pointer screens) controls step down slightly for a denser desk
// screen; touch sizes keep the 44px floor.
const SIZES: Record<ButtonSize, string> = {
  xs: 'min-h-9 px-3 py-1.5 text-xs rounded-lg gap-1.5 lg:min-h-8',
  sm: 'min-h-11 px-3.5 py-2 text-xs rounded-lg gap-1.5 lg:min-h-9',
  md: 'min-h-11 px-4 py-2 text-sm rounded-lg gap-2 lg:min-h-10',
  lg: 'min-h-12 px-5 py-2.5 text-sm rounded-xl gap-2 lg:min-h-11',
  xl: 'min-h-14 px-8 py-4 text-base rounded-2xl gap-3',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Shows a spinner in place of `icon` and disables the button. */
  loading?: boolean
  icon?: ReactNode
  iconRight?: ReactNode
  fullWidth?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading = false, icon, iconRight, fullWidth = false, className = '', children, disabled, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex select-none items-center justify-center border text-center font-semibold transition-all duration-200 active:scale-[0.97]',
        'focus:outline-none focus-visible:ring-4 focus-visible:ring-primary-600/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...props}
    >
      {loading ? <Loader2 size={14} className="shrink-0 animate-spin" aria-hidden="true" /> : icon}
      {children}
      {iconRight}
    </button>
  )
})
