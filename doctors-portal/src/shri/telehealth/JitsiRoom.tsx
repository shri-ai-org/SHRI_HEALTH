/**
 * The video, in the visit page: the visit's Jitsi room, joined as the doctor,
 * with Jitsi's own camera, microphone and screen-share buttons and nothing that
 * leads out of Shri Health (no invite, no deep link to an app, no welcome page).
 * It says when the patient comes in or leaves, and when the call is closed from
 * inside the video. A video service that cannot be reached says so, in words.
 */

import { VideoOff } from 'lucide-react'
import { useEffect, useRef, useState, type Ref } from 'react'

import { cn } from '../lib/cn'
import { Icon } from '../ui/primitives'

import { jitsiDomain, loadJitsi, type JitsiApi } from './jitsi'

export function JitsiRoom({
  room,
  displayName,
  onOthers,
  onLeft,
  boxRef,
  className,
}: {
  room: string
  displayName: string
  /** How many other people are in the room, as it changes. */
  onOthers: (n: number) => void
  /** The doctor left from inside the video. */
  onLeft: () => void
  /** The video's box — what a recording is cropped to. */
  boxRef?: Ref<HTMLDivElement>
  className?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState<string | null>(null)
  // The latest callbacks, without rejoining the room when they change.
  const cb = useRef({ onOthers, onLeft })
  useEffect(() => {
    cb.current = { onOthers, onLeft }
  })

  useEffect(() => {
    let api: JitsiApi | null = null
    let disposed = false
    const others = new Set<string>()
    loadJitsi()
      .then((Api) => {
        if (disposed || !host.current) return
        api = new Api(jitsiDomain(), {
          roomName: room,
          parentNode: host.current,
          width: '100%',
          height: '100%',
          userInfo: { displayName },
          configOverwrite: {
            prejoinConfig: { enabled: false },
            prejoinPageEnabled: false,
            disableDeepLinking: true,
            enableWelcomePage: false,
            enableClosePage: false,
            disableInviteFunctions: true,
            startWithAudioMuted: false,
            startWithVideoMuted: false,
            toolbarButtons: ['microphone', 'camera', 'desktop', 'tileview', 'fullscreen', 'settings', 'hangup'],
          },
          interfaceConfigOverwrite: { SHOW_JITSI_WATERMARK: false, SHOW_WATERMARK_FOR_GUESTS: false, MOBILE_APP_PROMO: false },
        })
        api.addListener('participantJoined', (e) => {
          if (e.id) others.add(e.id)
          cb.current.onOthers(others.size)
        })
        api.addListener('participantLeft', (e) => {
          if (e.id) others.delete(e.id)
          cb.current.onOthers(others.size)
        })
        api.addListener('readyToClose', () => cb.current.onLeft())
      })
      .catch((e: Error) => !disposed && setFailed(e.message))
    return () => {
      disposed = true
      api?.dispose()
    }
  }, [room, displayName])

  return (
    <div ref={boxRef} className={cn('relative overflow-hidden rounded-[18px] bg-black', className)} data-video-room={room}>
      <div ref={host} className="absolute inset-0" />
      {failed && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-[10px] p-[24px] text-center text-white">
          <Icon icon={VideoOff} size={28} />
          <p className="text-[16px] font-semibold">{failed}</p>
          <p className="max-w-[420px] text-[14px] opacity-80">Check the internet connection, then end the call and start it again. If it keeps happening, ask IT whether the video service is running.</p>
        </div>
      )}
    </div>
  )
}
