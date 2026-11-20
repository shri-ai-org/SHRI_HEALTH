// The public "Forgot password?" pages' frame: the brand mark and one card, centered, readable at
// 390px. No navigation and no session: these pages are open before anyone signs in.
import type { ReactNode } from 'react'
import { BrandMark } from '../../components/layout/BrandMark'
import { Card } from '../../components/ui/Card'

export function PasswordHelpLayout({ title, intro, children, footer }: { title: string; intro?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-start justify-center bg-surface-2 px-4 py-10 sm:items-center">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-3">
          <BrandMark />
          <span className="text-sm font-semibold tracking-[0.2em] text-ink">SHRI HEALTH</span>
        </div>
        <Card className="p-6 sm:p-8">
          <h1 className="text-xl font-semibold text-ink">{title}</h1>
          {intro ? <div className="mt-2 text-sm leading-relaxed text-ink-muted">{intro}</div> : null}
          <div className="mt-6">{children}</div>
        </Card>
        {footer ? <div className="mt-4 text-center text-sm text-ink-muted">{footer}</div> : null}
      </div>
    </main>
  )
}
