/**
 * The video, in the page: the visit's Jitsi room, with the other person filling
 * the card and this side's own camera small in the bottom-right corner, over it.
 * Jitsi's own tiles, self-view and tile view are off, so its picture is only ever
 * the other person; the corner picture is this page's, from the same camera, and
 * hides when the camera is turned off in the call. Jitsi's camera, microphone and
 * screen-share buttons stay; nothing leads out of Shri Health (no invite, no deep
 * link to an app, no welcome page).
 *
 * It says when the other person comes in or leaves, and when the call is closed
 * from inside the video. A video service that cannot be reached says so, in words.
 * The doctor's visit page and the patient's demo page both use it.
 */

import { VideoOff } from 'lucide-react'
import { useEffect, useRef, useState, type Ref } from 'react'

import { cn } from '../lib/cn'
import { Icon } from '../ui/primitives'

import { jitsiDomain, loadJitsi, type JitsiApi } from './jitsi'

export function JitsiRoom({
  room,
  displayName,
  waitingFor,
  onOthers,
  onLeft,
  boxRef,
  className,
}: {
  room: string
  displayName: string
  /** Said on the video while nobody else is in the room: "Waiting for Arjun to connect". */
  waitingFor?: string
  /** How many other people are in the room, as it changes. */
  onOthers?: (n: number) => void
  /** This side left from inside the video. */
  onLeft?: () => void
  /** The video's box — what a recording is cropped to. */
  boxRef?: Ref<HTMLDivElement>
  className?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [others, setOthers] = useState(0)
  const [cameraOff, setCameraOff] = useState(false)
  // The latest callbacks, without rejoining the room when they change.
  const cb = useRef({ onOthers, onLeft })
  useEffect(() => {
    cb.current = { onOthers, onLeft }
  })

  useEffect(() => {
    let api: JitsiApi | null = null
    let disposed = false
    const ids = new Set<string>()
    const count = () => {
      setOthers(ids.size)
      cb.current.onOthers?.(ids.size)
    }
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
            // Only the other person on Jitsi's stage: no filmstrip, no self-view tile, no tile view.
            filmstrip: { disabled: true },
            disableSelfView: true,
            disableSelfViewSettings: true,
            disableTileView: true,
            toolbarButtons: ['microphone', 'camera', 'desktop', 'fullscreen', 'settings', 'hangup'],
          },
          interfaceConfigOverwrite: { SHOW_JITSI_WATERMARK: false, SHOW_WATERMARK_FOR_GUESTS: false, MOBILE_APP_PROMO: false },
        })
        api.addListener('participantJoined', (e) => {
          if (e.id) ids.add(e.id)
          count()
        })
        api.addListener('participantLeft', (e) => {
          if (e.id) ids.delete(e.id)
          count()
        })
        api.addListener('videoMuteStatusChanged', (e) => setCameraOff(Boolean(e.muted)))
        api.addListener('readyToClose', () => cb.current.onLeft?.())
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
      {!failed && waitingFor && others === 0 && (
        <p className="pointer-events-none absolute left-[12px] top-[12px] rounded-full bg-black/60 px-[12px] py-[6px] text-[13px] font-medium text-white" data-alone="">
          {waitingFor}
        </p>
      )}
      {!failed && <SelfView hidden={cameraOff} />}
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

/** This side's own camera, small in the corner over the other person — mirrored, as a mirror shows you. */
function SelfView({ hidden }: { hidden: boolean }) {
  const video = useRef<HTMLVideoElement>(null)
  const [live, setLive] = useState(false)

  useEffect(() => {
    let stream: MediaStream | null = null
    let gone = false
    navigator.mediaDevices
      ?.getUserMedia({ video: true, audio: false })
      .then((s) => {
        if (gone) return s.getTracks().forEach((t) => t.stop())
        stream = s
        if (video.current) video.current.srcObject = s
        setLive(s.getVideoTracks().length > 0)
      })
      .catch(() => setLive(false))
    return () => {
      gone = true
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  return (
    <div
      aria-hidden="true"
      data-self-view={hidden || !live ? 'off' : 'on'}
      className={cn(
        'pointer-events-none absolute bottom-[76px] right-[12px] aspect-[4/3] w-[26%] min-w-[104px] max-w-[200px] overflow-hidden max-sm:bottom-[12px] rounded-[12px] bg-neutral-800 shadow-[0_6px_18px_rgb(0_0_0/0.45)] ring-2 ring-white/80 transition-opacity duration-200',
        (hidden || !live) && 'opacity-0',
      )}
    >
      <video ref={video} autoPlay muted playsInline className="size-full -scale-x-100 object-cover" />
    </div>
  )
}
