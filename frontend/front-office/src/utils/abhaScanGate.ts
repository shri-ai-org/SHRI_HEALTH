// While the Scan ABHA card is open, a scan the listener reads is handed to it:
// the card shows it scanned, then fetching, then runs the usual flow.
let waiting: ((run: () => void) => void) | null = null

/** The open scan card registers here (null when it closes). */
export function setAbhaScanWaiter(next: ((run: () => void) => void) | null): void {
  waiting = next
}

/** For AbhaScannerListener: give the scan to the open scan card. False when no card is open. */
export function takeAbhaScan(run: () => void): boolean {
  if (!waiting) return false
  const card = waiting
  waiting = null
  card(run)
  return true
}
