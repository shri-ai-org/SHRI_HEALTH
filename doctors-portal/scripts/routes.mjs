/**
 * Every routed screen, with sensible params so each lands on real sample data.
 * Parsed from the registry source, exactly as `walk-routes.sh` does, so the
 * three harnesses cannot drift apart on what "every screen" means.
 */

import { readFileSync } from 'node:fs'

function fill(pattern) {
  if (pattern.startsWith('/patient/')) return pattern.replace(':id', 'ICH-0044051')
  if (pattern.startsWith('/stroke/case/')) return pattern.replace(':id', '0141')
  if (pattern.startsWith('/radiology/study/')) return pattern.replace(':id', 'ST-9914')
  if (pattern === '/results/:id') return '/results/R-88410'
  if (pattern.startsWith('/tele/session/')) return pattern.replace(':id', 'E-118430')
  if (pattern.startsWith('/ip/encounter/')) return pattern.replace(':id', 'E-118366')
  return pattern.replace(':id', 'E-118402')
}

/** @returns {{ id: string, path: string }[]} */
export function routedScreens(registryPath = 'src/atlas/registry.ts') {
  const src = readFileSync(registryPath, 'utf8')
  const out = []
  for (const m of src.matchAll(/id: '(S-\d\d-\d\d)',[\s\S]*?route: (null|'([^']+)')/g)) {
    if (m[3]) out.push({ id: m[1], path: fill(m[3]) })
  }
  return out
}

/** Appends `e2e=1` respecting an existing query string. */
export function withE2E(path) {
  return `${path}${path.includes('?') ? '&' : '?'}e2e=1`
}
