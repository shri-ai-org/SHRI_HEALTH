import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HIDDEN_NOTICE, restartDelay } from './dictation'
import { spokenQuery, useSpokenSearch } from './spokenSearch'

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

async function searching(onQuery = vi.fn()) {
  const hook = renderHook(() => useSpokenSearch(onQuery, 'test-search'))
  await act(async () => {
    hook.result.current.toggle()
    await Promise.resolve()
  })
  expect(hook.result.current.listening).toBe(true)
  return { ...hook, onQuery }
}

describe('spokenQuery', () => {
  it('drops the punctuation the recogniser adds and joins settled and in-flight words', () => {
    expect(spokenQuery('Linda.', 'Thompson')).toBe('Linda Thompson')
    expect(spokenQuery('  Linda,   Thompson? ')).toBe('Linda Thompson')
    expect(spokenQuery('', '')).toBe('')
  })

  it('joins a number read out digit by digit, so an MRN or phone can be spoken', () => {
    expect(spokenQuery('SJ 0 0 0 1 2 3')).toBe('SJ 000123')
    expect(spokenQuery('4 0 8 5 5 5 0 1 2 3')).toBe('4085550123')
    expect(spokenQuery('room 12 and 3')).toBe('room 12 and 3')
  })
})

describe('the patient search mic', () => {
  it('writes the spoken words into the search box as they arrive', async () => {
    const { onQuery } = await searching()
    act(() => live().say('Linda', false))
    expect(onQuery).toHaveBeenLastCalledWith('Linda')
    act(() => live().say('Linda Thompson.'))
    expect(onQuery).toHaveBeenLastCalledWith('Linda Thompson')
  })

  it('keeps listening until Stop, across the sessions Chrome ends on its own', async () => {
    const { result, onQuery } = await searching()
    act(() => live().say('Linda'))
    act(() => live().end())
    await act(async () => {
      vi.advanceTimersByTime(restartDelay(0))
    })
    expect(result.current.listening).toBe(true)
    act(() => live().say('Thompson'))
    expect(onQuery).toHaveBeenLastCalledWith('Linda Thompson')
    act(() => result.current.toggle())
    expect(result.current.listening).toBe(false)
    const count = FakeRecognition.all.length
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(FakeRecognition.all).toHaveLength(count)
  })

  it('pauses when the tab is hidden and says why', async () => {
    const { result } = await searching()
    act(() => live().say('Linda'))
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(result.current.listening).toBe(false)
    expect(result.current.notice).toBe(HIDDEN_NOTICE)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  })

  it('starts each take from an empty query: the earlier take is not repeated', async () => {
    const { result, onQuery } = await searching()
    act(() => live().say('Robert'))
    act(() => result.current.toggle())
    await act(async () => {
      result.current.toggle()
      await Promise.resolve()
    })
    act(() => live().say('Linda'))
    expect(onQuery).toHaveBeenLastCalledWith('Linda')
  })

  it('stops and lets typing take over: nothing more it heard reaches the box', async () => {
    const { result, onQuery } = await searching()
    act(() => live().say('Lin', false))
    onQuery.mockClear()
    act(() => result.current.stop())
    expect(result.current.listening).toBe(false)
    expect(onQuery).not.toHaveBeenCalled()
  })

  it('is not offered where the browser cannot listen', () => {
    Object.assign(window, { SpeechRecognition: undefined, webkitSpeechRecognition: undefined })
    const { result } = renderHook(() => useSpokenSearch(vi.fn(), 'test-search'))
    expect(result.current.available).toBe(false)
  })
})
