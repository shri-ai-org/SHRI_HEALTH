/**
 * A teleconsult address with no patient behind it (`src/screens/m27/
 * Telehealth.tsx` NoParty): it says so, rather than silently showing someone
 * else, and offers the way back to today's queue.
 */

import { UserX, Video } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import { ScreenFrame } from '../app/ScreenFrame'
import { EmptyState } from '../ui/EmptyState'
import { Card, Pill } from '../ui/primitives'

export function NoParty({ screenId, id }: { screenId: string; id?: string }) {
  const navigate = useNavigate()
  return (
    <ScreenFrame screenId={screenId} sub="No patient at this address.">
      <Card className="max-w-[672px]">
        <EmptyState
          icon={UserX}
          why={`There is no patient or teleconsult with the id “${id ?? ''}” here. Pick one from today’s queue.`}
          action={
            <Pill variant="control" size="lg" icon={Video} onClick={() => navigate('/tele/queue')}>
              Telehealth
            </Pill>
          }
        />
      </Card>
    </ScreenFrame>
  )
}
