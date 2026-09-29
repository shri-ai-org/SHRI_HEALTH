import { ChevronLeft } from 'lucide-react'
import { Link } from 'react-router-dom'

import { P } from '../app/paths'
import { Card, Icon } from '../ui/primitives'

/** An address that is not a screen — the old build's copy, in this build's card. */
export function NotFound() {
  return (
    <div className="mx-auto w-full max-w-[640px] py-[40px]">
      <Card title="No screen at this address">
        <p className="text-[14px]/[1.5] text-sh-text-2">
          Addresses here are screens, not endpoints. Press <kbd className="rounded-[6px] bg-sh-hover px-[6px] py-[2px] text-[12px] text-sh-text">/</kbd> to
          search for a patient.
        </p>
        <Link
          to={P.myDay}
          className="mt-[18px] inline-flex h-[44px] w-fit items-center gap-[6px] rounded-full bg-sh-primary pl-[14px] pr-[18px] text-[13px] font-medium text-sh-on-primary hover:bg-sh-primary-hover"
        >
          <Icon icon={ChevronLeft} size={16} />
          My Day
        </Link>
      </Card>
    </div>
  )
}
