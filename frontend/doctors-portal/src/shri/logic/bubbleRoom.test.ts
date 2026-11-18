import { describe, expect, it } from 'vitest'

import { roomForBubble } from './bubbleRoom'

// Audit issue 2: the fixed assistant bubble sat over the last line of Linda's record. The page keeps
// room at its foot exactly where the bubble shows, and nowhere else.
describe('room at the foot of the page for the assistant bubble', () => {
  it('is kept where the bubble shows: the flag on, the AI on, a screen that offers it', () => {
    expect(roomForBubble(true, true, true)).toBe(true)
  })

  it('is not kept on a screen that does not offer the bubble', () => {
    expect(roomForBubble(true, true, false)).toBe(false)
  })

  it('changes nothing with the flag off', () => {
    expect(roomForBubble(false, true, true)).toBe(false)
  })

  it('changes nothing when the clinician has the AI turned off', () => {
    expect(roomForBubble(true, false, true)).toBe(false)
  })
})
