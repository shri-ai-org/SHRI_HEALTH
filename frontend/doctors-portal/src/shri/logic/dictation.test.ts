import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CAP_NOTICE, MAX_NETWORK_ERRORS, MAX_RUN_SEC, restartDelay, useDictation } from './dictation'
import { NOTICE } from './speech'

/** A stand-in for Chrome's recogniser: each instance is one session the test drives. */
class FakeRecognition {
  static all: FakeRecognition[] = []
  lang = ''
  continuous = false
  interimResults = false
  maxAlternatives = 1
  started = 0
  aborted = false
  onresult: ((e: unknown) => void) | null = null
  onerror: ((e: { error: string }) => void) | null = null
  onend: (() => void) | null = null
  results: { transcript: string; isFinal: boolean }[] = []
  constructor() {
    FakeRecognition.all.push(this)
  }
  start() {
    this.started += 1
  }
  stop() {
    this.onend?.()
  }
  abort() {
    this.aborted = true
  }
  /** Chrome's event: the session's whole result list, from `resultIndex`. */
  say(transcript: string, isFinal = true) {
    const last = this.results[this.results.length - 1]
    if (last && !last.isFinal) this.results.pop()
    this.results.push({ transcript, isFinal })
    this.emit()
  }
  emit() {
    const list = this.results.map((r) => Object.assign([{ transcript: r.transcript, confidence: 0.9 }], { isFinal: r.isFinal }))
    this.onresult?.({ resultIndex: 0, results: list })
  }
  end() {
    this.onend?.()
  }
}

const live = () => FakeRecognition.all[FakeRecognition.all.length - 1]

beforeEach(() => {
  vi.useFakeTimers()
  FakeRecognition.all = []
  Object.assign(window, { SpeechRecognition: FakeRecognition, isSecureContext: true })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: () => undefined }] })) },
  })
})
afterEach(() => {
  vi.useRealTimers()
})

async function listening() {
  const hook = renderHook(() => useDictation({ arbiterId: 'test-mic' }))
  await act(async () => {
    hook.result.current.start()
    await Promise.resolve()
  })
  expect(hook.result.current.phase).toBe('recording')
  return hook
}

describe('the microphone keeps listening until Stop', () => {
  it('restarts with a fresh recogniser after Chrome ends the session on a pause, keeping what was heard', async () => {
    const { result } = await listening()
    act(() => live().say('chest pain'))
    const first = live()
    act(() => first.end())
    await act(async () => {
      vi.advanceTimersByTime(restartDelay(0))
    })
    expect(FakeRecognition.all).toHaveLength(2)
    expect(live()).not.toBe(first)
    expect(live().started).toBe(1)
    expect(live().continuous && live().interimResults).toBe(true)
    act(() => live().say('since Monday'))
    expect(result.current.phase).toBe('recording')
    expect(result.current.settled).toBe('chest pain since Monday')
  })

  it('keeps restarting across many pauses (well past a minute), with no duplicated words', async () => {
    const { result } = await listening()
    for (let i = 0; i < 12; i += 1) {
      act(() => live().say(`word${i}`))
      // Chrome repeats the final result in later events: it is taken once.
      act(() => live().emit())
      act(() => live().end())
      await act(async () => {
        vi.advanceTimersByTime(10_000)
      })
    }
    expect(result.current.phase).toBe('recording')
    expect(result.current.settled).toBe(Array.from({ length: 12 }, (_, i) => `word${i}`).join(' '))
  })

  it('keeps words still in flight when a session ends, without repeating them', async () => {
    const { result } = await listening()
    act(() => live().say('shortness of', false))
    act(() => live().end())
    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    act(() => live().say('breath on stairs'))
    expect(result.current.settled).toBe('shortness of breath on stairs')
  })

  it('Stop really stops: no restart afterwards', async () => {
    const { result } = await listening()
    act(() => live().say('no allergies'))
    const count = FakeRecognition.all.length
    act(() => result.current.stop())
    act(() => live().end())
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(FakeRecognition.all).toHaveLength(count)
    expect(live().aborted).toBe(true)
    expect(result.current.phase).toBe('review')
    expect(result.current.settled).toBe('no allergies')
  })

  it("restarts quietly after 'no-speech' and 'network'", async () => {
    const { result } = await listening()
    act(() => {
      live().onerror?.({ error: 'no-speech' })
      live().end()
    })
    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })
    act(() => {
      live().onerror?.({ error: 'network' })
      live().end()
    })
    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })
    expect(FakeRecognition.all).toHaveLength(3)
    expect(result.current.phase).toBe('recording')
    expect(result.current.notice).toBeNull()
  })

  it("says the speech service is unreachable only when 'network' never stops (Brave blocks it)", async () => {
    const { result } = await listening()
    for (let i = 0; i < MAX_NETWORK_ERRORS; i += 1) {
      act(() => {
        live().onerror?.({ error: 'network' })
        live().end()
      })
      await act(async () => {
        vi.advanceTimersByTime(5_000)
      })
    }
    expect(result.current.notice).toBe(NOTICE.network)
    expect(result.current.phase).not.toBe('recording')
  })

  it("stops with a clear message on 'not-allowed' (microphone permission)", async () => {
    const { result } = await listening()
    const count = FakeRecognition.all.length
    act(() => {
      live().onerror?.({ error: 'not-allowed' })
      live().end()
    })
    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })
    expect(FakeRecognition.all).toHaveLength(count)
    expect(result.current.notice).toBe(NOTICE.blocked)
    expect(result.current.phase).toBe('unavailable')
  })

  it('closes the microphone after 15 minutes, keeping every word', async () => {
    const { result } = await listening()
    act(() => live().say('long consultation'))
    await act(async () => {
      vi.advanceTimersByTime(MAX_RUN_SEC * 1000)
    })
    expect(result.current.phase).toBe('review')
    expect(result.current.notice).toBe(CAP_NOTICE)
    expect(result.current.settled).toBe('long consultation')
  })

  it('backs off while sessions end fast, never spinning', () => {
    expect(restartDelay(0)).toBe(0)
    expect(restartDelay(1)).toBe(250)
    expect(restartDelay(3)).toBe(1000)
    expect(restartDelay(20)).toBe(3000)
  })
})
