import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pollStatus } from './rxStatusPoll'

describe('pollStatus', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** A line whose status moves through `steps`, one step per read. */
  function line(steps: string[]) {
    const state = { status: steps[0], reads: 0 }
    return {
      state,
      pending: () => (['queued', 'sent'].includes(state.status) ? ['rx-1'] : []),
      read: vi.fn(async () => {
        state.reads += 1
        state.status = steps[Math.min(state.reads, steps.length - 1)]
      }),
    }
  }

  it('reads every 3 seconds and stops once the status is final', async () => {
    const l = line(['queued', 'sent', 'accepted'])
    const onStop = vi.fn()
    pollStatus({ pending: l.pending, read: l.read, isHidden: () => false, onStop })
    await vi.advanceTimersByTimeAsync(2999)
    expect(l.read).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(l.state.status).toBe('sent')
    await vi.advanceTimersByTimeAsync(3000)
    expect(l.state.status).toBe('accepted')
    expect(onStop).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30000)
    expect(l.read).toHaveBeenCalledTimes(2)
  })

  it('stops after 30 seconds and leaves a line still queued as queued', async () => {
    const l = line(['queued'])
    const onStop = vi.fn()
    pollStatus({ pending: l.pending, read: l.read, isHidden: () => false, onStop })
    await vi.advanceTimersByTimeAsync(60000)
    expect(l.read).toHaveBeenCalledTimes(10)
    expect(l.state.status).toBe('queued')
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('stops when the user leaves the screen', async () => {
    const l = line(['queued'])
    const stop = pollStatus({ pending: l.pending, read: l.read, isHidden: () => false })
    await vi.advanceTimersByTimeAsync(6000)
    stop()
    await vi.advanceTimersByTimeAsync(30000)
    expect(l.read).toHaveBeenCalledTimes(2)
  })

  it('stops when the tab is hidden', async () => {
    const l = line(['queued'])
    let hidden = false
    const onStop = vi.fn()
    pollStatus({ pending: l.pending, read: l.read, isHidden: () => hidden, onStop })
    await vi.advanceTimersByTimeAsync(3000)
    hidden = true
    await vi.advanceTimersByTimeAsync(30000)
    expect(l.read).toHaveBeenCalledTimes(1)
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('keeps one request in flight and keeps the last status when a read fails', async () => {
    let inFlight = 0
    let most = 0
    let fail = true
    const status = { value: 'queued' }
    const read = vi.fn(async () => {
      inFlight += 1
      most = Math.max(most, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5000))
      inFlight -= 1
      if (fail) {
        fail = false
        throw new Error('read failed')
      }
      status.value = 'accepted'
    })
    pollStatus({ pending: () => (status.value === 'queued' ? ['rx-1', 'rx-2'] : []), read, isHidden: () => false })
    await vi.advanceTimersByTimeAsync(8000)
    expect(status.value).toBe('queued')
    await vi.advanceTimersByTimeAsync(30000)
    expect(most).toBe(1)
    expect(status.value).toBe('accepted')
  })
})
