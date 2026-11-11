/**
 * The assistant's face — ported from `src/components/assistant-icon.tsx`: the
 * robot with a chat bubble that marks the RAG assistant's entry point, as the
 * old build drew it. Inline, so it needs no request and keeps its own colours
 * in both themes; decorative — the button carrying it has the name.
 *
 * The gradient ids are per instance (`useId`), because the face is drawn more
 * than once on a page (the bubble and the drawer's header) and a repeated id
 * would paint every copy with the first one's gradients.
 */

import { useId } from 'react'

import { cn } from '../lib/cn'

export function AssistantIcon({ className }: { className?: string }) {
  const id = useId().replace(/:/g, '')
  const head = `${id}-head`
  const visor = `${id}-visor`
  const bubble = `${id}-bubble`
  return (
    <svg viewBox="0 0 128 128" aria-hidden="true" className={cn('block', className)}>
      <defs>
        <linearGradient id={head} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" />
          <stop offset="1" stopColor="#bcd8ff" />
        </linearGradient>
        <linearGradient id={visor} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#0b3a8c" />
          <stop offset="1" stopColor="#04163f" />
        </linearGradient>
        <linearGradient id={bubble} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#0a5cff" />
          <stop offset="1" stopColor="#16c1c9" />
        </linearGradient>
      </defs>
      <ellipse cx="50" cy="104" rx="30" ry="11" fill="#dce9ff" />
      <circle cx="55" cy="12" r="6" fill="#1a73ff" />
      <path d="M53.5 17h3v8h-3z" fill="#1a73ff" />
      <rect x="46" y="23" width="18" height="6" rx="3" fill="#1a73ff" />
      <rect x="7" y="46" width="12" height="28" rx="6" fill="#1a73ff" />
      <rect x="91" y="46" width="12" height="28" rx="6" fill="#1a73ff" />
      <rect x="14" y="27" width="82" height="66" rx="33" fill={`url(#${head})`} stroke="#9cc4ff" strokeWidth="2" />
      <rect x="22" y="39" width="66" height="42" rx="21" fill={`url(#${visor})`} />
      <path d="M34 61q6-8 12 0M64 61q6-8 12 0M49 69q6 5 12 0" fill="none" stroke="#7fd6ff" strokeWidth="3.5" strokeLinecap="round" />
      <path
        d="M80 78h26a18 18 0 0 1 0 36H82l-16 10 3-15a18 18 0 0 1 11-31z"
        fill={`url(#${bubble})`}
        stroke="#fff"
        strokeWidth="4"
        strokeLinejoin="round"
        paintOrder="stroke"
      />
      <g fill="#fff">
        <circle cx="80" cy="96" r="4.5" />
        <circle cx="93" cy="96" r="4.5" />
        <circle cx="106" cy="96" r="4.5" />
      </g>
    </svg>
  )
}
