/**
 * The doctor's portal says its demonstration code where patient demo pages can
 * hear it: in the demo directory room on the hospital's Jitsi, joined quietly (no
 * camera, no microphone, nothing on screen), every few seconds. A patient demo
 * page on any device then shows the code without anyone typing it. Off on the
 * public meet.jit.si, where joining a room needs a sign-in. Mounted once, in the
 * shell.
 */

import { useRef } from 'react'

import { useCurrentStaff } from '@/store/session'

import { callLink } from './callLink'
import { demoCode, demoCodeMadeAt, DIRECTORY_ROOM } from './demoCode'
import { isPublicJitsi } from './jitsi'
import { JitsiRoom } from './JitsiRoom'

const EVERY_MS = 3000

export function CodeBeacon() {
  const me = useCurrentStaff()
  const timer = useRef(0)
  if (isPublicJitsi()) return null
  const say = () => callLink.send(DIRECTORY_ROOM, { k: 'code', code: demoCode(), at: demoCodeMadeAt(), doctor: me?.name ?? 'Your doctor' })
  return (
    <div aria-hidden="true" className="pointer-events-none fixed -left-[10000px] top-0 h-[240px] w-[320px] opacity-0" data-code-beacon="">
      <JitsiRoom
        room={DIRECTORY_ROOM}
        displayName="Shri Health portal"
        quiet
        onJoined={() => {
          say()
          window.clearInterval(timer.current)
          timer.current = window.setInterval(say, EVERY_MS)
        }}
        className="size-full"
      />
    </div>
  )
}
