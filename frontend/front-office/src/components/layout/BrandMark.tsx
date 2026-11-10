import { cn } from '../../utils/cn'
import logo from '../../logo.png'

/** The SHRI HEALTH mark (DESIGN_SYSTEM §12.2). Below 640px the mark stands
 *  alone; beside it, the uppercase wordmark. */
export function BrandMark({ className }: { className?: string }) {
  return <img src={logo} alt="" width={153} height={256} className={cn('block h-9 w-auto select-none object-contain', className)} draggable={false} />
}
