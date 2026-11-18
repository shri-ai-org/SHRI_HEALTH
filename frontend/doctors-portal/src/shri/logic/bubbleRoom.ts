// SHRI_HEALTH: room at the foot of the page for the assistant bubble (audit issue 2, #85). The bubble
// is fixed at the bottom right (src/shri/app/AssistantBubble.tsx), so without room the page's last line
// stays under it. The room is kept exactly where the bubble shows, and nowhere else.

/** True where the bubble shows: the flag on, the clinician's AI on, and a screen that offers it. */
export function roomForBubble(flagOn: boolean, aiOn: boolean, offered: boolean): boolean {
  return flagOn && aiOn && offered
}
