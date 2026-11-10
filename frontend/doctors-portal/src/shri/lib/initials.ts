// ported from src/shell/PatientBanner.tsx:143-152 (`initials`): a person's two
// initials — honorifics dropped, split on spaces and the dots of "R. Lakshmanan".

export function initials(name: string): string {
  return name
    .replace(/^(Dr\.?|Sr\.|Mr|Ms|Mrs)\s+/i, '')
    .split(/[\s.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase()
}
