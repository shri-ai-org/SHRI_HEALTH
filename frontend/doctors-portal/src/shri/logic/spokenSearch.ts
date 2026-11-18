// The patient search box's microphone: the same recorder as the notes
// (`useDictation`: it keeps listening until Stop, restarting Chrome's sessions
// in place, and pauses when the tab is hidden), with the spoken words written
// into the search box as a query.

import { useCallback, useEffect, useRef } from 'react'

import { useDictation } from './dictation'

/**
 * What was heard, as a search query: the settled words and the ones still in
 * flight, without the sentence punctuation the recogniser adds, and with a
 * number read out digit by digit ("4 0 8 5") joined into one ("4085"), so an
 * MRN or a phone number can be spoken.
 */
export function spokenQuery(settled: string, interim = ''): string {
  return `${settled} ${interim}`
    .replace(/[.,!?;:]+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\d(?: \d\b)+/g, (digits) => digits.replace(/ /g, ''))
}

export interface SpokenSearch {
  /** The microphone is open (or the browser is asking for it). */
  listening: boolean
  /** False where this browser cannot listen at all: the mic is not offered. */
  available: boolean
  /** Why listening stopped or could not start, in words the clinician can act on. */
  notice: string | null
  /** A press of the mic: starts a new take, or stops the one in progress (its words stay in the box). */
  toggle: () => void
  /** Typing takes over: the take stops and nothing more it heard reaches the box. */
  stop: () => void
}

/**
 * Speech into a search box. Each take starts from an empty query and replaces
 * the box's text as the words arrive; Stop keeps what was heard in the box, as
 * typed text.
 */
export function useSpokenSearch(onQuery: (query: string) => void, arbiterId = 'patient-search'): SpokenSearch {
  const d = useDictation({ arbiterId })
  const listening = d.phase === 'requesting' || d.phase === 'recording'
  const query = spokenQuery(d.settled, d.interim)
  const take = useRef(false)
  const onQueryRef = useRef(onQuery)

  useEffect(() => {
    onQueryRef.current = onQuery
  })

  // Only words from a take this box started reach it, and an empty take leaves the box alone.
  useEffect(() => {
    if (take.current && query) onQueryRef.current(query)
  }, [query])

  const { start, stop, reset } = d
  const toggle = useCallback(() => {
    if (listening) {
      stop()
      return
    }
    reset()
    take.current = true
    start()
  }, [listening, reset, start, stop])

  const detach = useCallback(() => {
    take.current = false
    stop()
  }, [stop])

  return { listening, available: d.supportNotice === null, notice: d.notice ?? d.supportNotice, toggle, stop: detach }
}
