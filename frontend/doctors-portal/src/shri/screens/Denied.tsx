import { Send, ShieldX, Undo2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import { useSession } from '@/store/session'
import { useUI } from '@/store/ui'

import { landingFor } from '../app/landing'
import { forceState } from '../state/ai'
import { Card, Icon, Pill } from '../ui/primitives'

const GRANTED_BY = 'your medical superintendent'

/**
 * A screen whose capability the signed-in persona does not hold. The old
 * build's refusal (`src/components/states.tsx` `DeniedPanel`), word for word:
 * the wording is identical for every reason access can be refused, because a
 * message that distinguished them would reveal whether a record exists.
 *
 * `screenId` is set only for a screen this build draws, so the route walk's
 * `data-screen-id` count stays a count of screens really drawn.
 */
export function Denied({ capability, screenId }: { capability: string; screenId?: string }) {
  const navigate = useNavigate()
  const toast = useUI((s) => s.toast)
  const persona = useSession((s) => s.persona)

  function goBack() {
    forceState(null)
    // Opened cold there is nothing to go back to, so it goes to the persona's landing.
    if ((window.history.state as { idx?: number } | null)?.idx) navigate(-1)
    else navigate(landingFor(persona), { replace: true })
  }

  return (
    <div className="mx-auto w-full max-w-[560px] py-[40px]" data-screen-id={screenId}>
      <Card className="items-center text-center">
        <span className="inline-flex size-[48px] items-center justify-center rounded-full bg-sh-neu-bg text-sh-neu-fg" aria-hidden="true">
          <Icon icon={ShieldX} size={22} />
        </span>
        <h1 className="mt-[14px] text-[20px]/[1.2] font-medium tracking-[-0.012em] text-sh-text">This is not available to you</h1>
        <p className="mt-[8px] text-[14px] text-sh-text-2">
          You do not hold{' '}
          <code className="rounded-[6px] bg-sh-inner px-[6px] py-[2px] font-mono text-[13px] text-sh-text">{capability}</code> for this
          subject.
        </p>
        <p className="mt-[10px] text-[13px]/[1.5] text-sh-text-3">
          The wording here is deliberately identical for every reason access can be refused. A message that distinguished them would reveal
          whether a record exists.
        </p>
        <div className="mt-[18px] flex flex-wrap justify-center gap-[10px]">
          <Pill
            variant="primary"
            size="xl"
            icon={Send}
            onClick={() =>
              toast({
                tone: 'info',
                title: 'Access request sent',
                detail: `${capability} requested from ${GRANTED_BY}. You will be told when it is decided; nothing opens until then.`,
              })
            }
          >
            Request access
          </Pill>
          <Pill variant="control" size="xl" icon={Undo2} onClick={goBack}>
            Go back
          </Pill>
        </div>
        <p className="mt-[14px] text-[13px] text-sh-text-3">Granted by {GRANTED_BY}.</p>
      </Card>
    </div>
  )
}
