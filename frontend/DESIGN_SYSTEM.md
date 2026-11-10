# SHRI HEALTH Portal Design System

**Look, feel and behaviour of the SHRI HEALTH portal.** Written so a team can build a new portal from this file alone (procurement, inventory, admin or any other kind) and have it look, move and respond exactly like ours.

> **Reference implementation:** `client/` in the SHRI HEALTH repository (React 19 + Tailwind CSS v4 + framer-motion 11 + lucide-react).
> **Examples in this guide use our healthcare screens** (patients, doctors, medicines, appointments). Swap in your own domain: *Medicines* can become *Stock items*, *Appointments* can become *Purchase orders*, *My doctors* can become *Suppliers*, and so on. The patterns stay the same.
> Every value here is copied from the working code. **Appendix A is the complete stylesheet, verbatim.** If a table and the appendix ever disagree, the appendix wins.

---

## Contents

0. [Quick start](#0-quick-start)
1. [Design principles](#1-design-principles)
2. [Stack & setup](#2-stack--setup)
3. [Typography](#3-typography)
4. [Colour system](#4-colour-system)
5. [Radius, shadow, spacing, density, z-index](#5-radius-shadow-spacing-density-z-index)
6. [Theme switching (light / dark / system) and accessibility modes](#6-theme-switching-light--dark--system-and-accessibility-modes)
7. [Layout & responsiveness](#7-layout--responsiveness)
8. [App shell & navbar](#8-app-shell--navbar)
9. [Dashboards: the bento grid and friends](#9-dashboards-the-bento-grid-and-friends)
10. [Components](#10-components)
11. [Motion & animation](#11-motion--animation)
12. [Icons, logo & SVG assets](#12-icons-logo--svg-assets)
13. [AI assistant surfaces (docked chat & insight bubbles)](#13-ai-assistant-surfaces-docked-chat--insight-bubbles)
14. [Sign-in screens](#14-sign-in-screens)
15. [Accessibility & print](#15-accessibility--print)
16. [New-screen checklist](#16-new-screen-checklist)
17. [Known gaps to fix when you reuse this](#17-known-gaps-to-fix-when-you-reuse-this)
- [Appendix A: the complete stylesheet (`index.css`)](#appendix-a-the-complete-stylesheet-indexcss)
- [Appendix B: the assistant mark SVG](#appendix-b-the-assistant-mark-svg)

---

## 0. Quick start

A new portal gets the same look in six steps.

1. **Create the app:** Vite + React + TypeScript.
2. **Install:**
   ```bash
   npm i tailwindcss @tailwindcss/vite framer-motion lucide-react \
     @fontsource-variable/plus-jakarta-sans
   # Optional Indic fallbacks we ship (drop any you don't need):
   npm i @fontsource-variable/noto-sans-kannada @fontsource-variable/noto-sans-devanagari \
     @fontsource-variable/noto-sans-tamil @fontsource-variable/noto-sans-malayalam
   ```
3. **`vite.config.js`:**
   ```js
   import { defineConfig } from 'vite'
   import react from '@vitejs/plugin-react'
   import tailwindcss from '@tailwindcss/vite'
   export default defineConfig({
     plugins: [react(), tailwindcss()],
     build: {
       // Fonts are never inlined as data: URLs, so a strict CSP `font-src 'self'` still works.
       assetsInlineLimit: (filePath) => (/\.(woff2?|ttf|otf)$/.test(filePath) ? false : undefined),
     },
   })
   ```
4. **`src/index.css`:** paste Appendix A. There is no `tailwind.config.js`: all tokens live in CSS under `@theme static`.
5. **`index.html`:** add the viewport meta, the `theme-color` meta and the **pre-paint theme script** from §6.1. This is what stops a white flash in dark mode.
6. **Wrap the app** in `<MotionConfig reducedMotion="user">` and build the shell from §8.

---

## 1. Design principles

These are what make the portal feel "premium, calm, trustworthy". Keep them.

| Principle | What it means in practice |
|---|---|
| **Calm, clinical, premium** | A cool blue-grey ground (`#E8EDF4`), white cards, hairline borders, soft layered shadows, and one blue action colour. There is no gradient noise, and colour always carries meaning. |
| **One font** | Plus Jakarta Sans Variable everywhere: 400 for body, 500/600 for UI, 600 for headings, 700 for the wordmark. Never add a second display font. |
| **Readable first** | A 14px reading floor (`text-sm`). 12–13px is only for non-essential metadata. The type scale is one step larger than typical consumer apps. |
| **44px touch targets** | Every control is at least 44×44px (`min-h-11`, `.tap-target`, `.tap-reach`). Density may shrink *rows*, never *targets*. |
| **Colour is never the only signal** | A status chip has words. An icon tile sits beside a label. Charts have a legend, end labels and a table view. |
| **Hue, not saturation** | Add colour through **soft tints** of a destination's hue (§4.4). Solid, saturated fills are reserved for a few deliberate focal points: the stat tiles, the activity panel and the date block. |
| **Semantic colour is reserved** | `danger` red is for emergencies only; ordinary errors use `critical`. Indigo means AI and nothing else. Pastel `accent-*` colours mark categories, never state. |
| **No fake UI** | Don't render a control that doesn't work. Unbuilt features are *absent*, not greyed out. |
| **Every state designed** | Each panel has loading (skeleton), empty (calm message plus next action), error (retry plus reference id) and success states. One failed panel never blanks the page. |
| **Motion is quiet** | 150–250ms, one easing curve (`cubic-bezier(0.16,1,0.3,1)`), no page transitions, no looping decoration inside the app. Reduced motion is honoured everywhere. |
| **Dark mode is designed, not inverted** | It has its own ramp. Text is `#E7ECF3`, not pure white, to limit halation. Primary hover gets *lighter* in dark mode. |

---

## 2. Stack & setup

| Piece | Version / setting |
|---|---|
| React | 19 |
| Tailwind CSS | v4 via `@tailwindcss/vite`. Tokens in `@theme static { … }`, no JS config file. `static` makes Tailwind emit every token even if no class uses it, because JS and `color-mix()` read them. Don't use `@theme inline`: it breaks the `.dark` redefinition. |
| Dark variant | `@variant dark (&:where(.dark, .dark *));`. Dark mode is class-based on `<html>`. |
| Animation | framer-motion 11, with the whole app wrapped in `<MotionConfig reducedMotion="user">` |
| Icons | lucide-react (0.446+) |
| Breakpoints | Tailwind defaults: `sm` 40rem (640), `md` 48rem (768), `lg` 64rem (1024), `xl` 80rem (1280), `2xl` 96rem (1536). Plus arbitrary `min-[360px]:` / `min-[380px]:` for very small phones. |

`index.html` head essentials:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<meta name="theme-color" content="#E8EDF4" />
<link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png" />
<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" />
<!-- + the pre-paint theme script from §6.1 -->
```

`viewport-fit=cover` is required. Without it `env(safe-area-inset-*)` is 0, and fixed bottom bars sit under the iPhone home indicator.

---

## 3. Typography

### 3.1 Font loading

Fonts are loaded with CSS `@import` at the top of `index.css`. They are self-hosted through Fontsource, with no Google CDN.

```css
@import '@fontsource-variable/plus-jakarta-sans';
@import '@fontsource-variable/noto-sans-kannada';
@import '@fontsource-variable/noto-sans-devanagari';
@import '@fontsource-variable/noto-sans-tamil';
@import '@fontsource-variable/noto-sans-malayalam';
@import "tailwindcss";
```

```css
--font-sans: 'Plus Jakarta Sans Variable', 'Noto Sans Kannada Variable',
             'Noto Sans Devanagari Variable', 'Noto Sans Tamil Variable',
             'Noto Sans Malayalam Variable', system-ui, -apple-system, 'Segoe UI', sans-serif;
--font-display: var(--font-sans);
```

The Noto families come **after** Jakarta, so they only render characters Jakarta lacks, such as Indian scripts. Fontsource's own `unicode-range` makes the browser download them only when needed.

### 3.2 Global text rules

```css
body {
  font-family: var(--font-sans); font-weight: 400; letter-spacing: 0.01em;
  font-synthesis: none; -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility;
}
h1, h2, h3, h4, h5, h6 { font-weight: 600; letter-spacing: -0.02em; line-height: 1.05; }
```

- **Weights in use:** `font-semibold` (the workhorse: headings, buttons, labels), `font-medium` (nav items, secondary UI), `font-bold` (wordmark, admin page titles, initials) and `font-normal`. Don't use `font-black` or arbitrary weights.
- **Numbers** in tables, KPIs and counters use `tabular-nums`.
- **Eyebrows / section labels:** `text-xs font-semibold uppercase tracking-wider text-ink-subtle`.
- **Wordmark:** `text-[15px] font-bold tracking-[0.06em]`, uppercase text (e.g. "SHRI HEALTH").

### 3.3 Type scale

Large-text mode (`html[data-large-text='true']`) re-defines the *tokens*, so the whole ramp grows with no page zoom. For that reason, **never hard-code `text-[13px]`**; always use the tokens.

| Class | Default | Large text | Use |
|---|---|---|---|
| `text-2xs` | 0.75rem / 12px | 0.875rem | Non-essential glyph labels only (badges, counts) |
| `text-xs` | 0.8125rem / 13px | 0.9375rem | Dense metadata, hints, table cells in compact portals |
| `text-sm` | 0.875rem / 14px | 1rem | **Reading floor.** Secondary text, buttons, nav, inputs |
| `text-base` | 1rem / 16px | 1.125rem | Body |
| `text-lg` | 1.125rem / 18px | 1.25rem | Lead text |
| `text-xl` | 1.25rem / 20px | 1.375rem | Card headings, clinician page titles on phones |
| `text-2xl` | 1.5rem / 24px | 1.625rem | Section and page headings, KPI values |
| `text-3xl` | 1.875rem / 30px | 2rem | Page titles (patient portal, sm+) |
| `text-4xl` | 2.25rem / 36px | 2.375rem | Rare display |

From 1024px the root steps down to 15px for desk density, but the ramp is lifted by 16/15 there (both modes), so these pixel sizes hold on every screen: only spacing tightens, never text.

Below 767px, all `input`, `select` and `textarea` elements get `font-size: max(16px, 1em)`. This stops iOS from zooming when a field gets focus.

### 3.4 Heading recipes

| Where | Classes |
|---|---|
| Page title, comfortable portal (patient) | `text-2xl font-semibold tracking-tight text-ink sm:text-3xl` + subtitle `mt-1.5 text-sm text-ink-muted` |
| Page title, compact portal (clinician) | `text-xl font-semibold tracking-tight text-ink sm:text-2xl` + subtitle `mt-0.5 text-xs text-ink-muted` |
| Page title, admin | `text-2xl font-bold tracking-tight text-ink` + subtitle `mt-1 text-sm text-ink-muted` |
| Dashboard section heading | `SectionHeading` (§9.2): a 44px row, soft tinted icon + `text-sm font-semibold text-ink` |
| Card header title | `text-sm font-semibold text-ink` |
| Modal title | `text-base font-semibold text-ink leading-snug tracking-tight` |
| KPI value | `text-2xl font-semibold leading-none tracking-tight tabular-nums` |

---

## 4. Colour system

All colours are CSS custom properties, which Tailwind exposes as utilities (`bg-surface-1`, `text-ink-muted`, `border-border-soft` and so on). **Always use tokens, never raw hex, in components.** Dark mode works only because every token is redefined under `:root.dark`.

### 4.1 Neutrals: ground, surfaces, ink, borders

| Token | Light | Dark | Role |
|---|---|---|---|
| `bg` | `#E8EDF4` | `#14181F` | Page ground (cool blue-grey) |
| `surface-1` | `#FFFFFF` | `#1D232D` | Cards, header, menus, inputs |
| `surface-2` | `#F4F7FA` | `#262E39` | Hover fills, wells, segmented tracks, table head |
| `surface-3` | `#E4EAF2` | `#303945` | Progress tracks, inactive toggles, skeleton highlight |
| `scrim` | `rgba(15,23,42,0.45)` | `rgba(0,0,0,0.66)` | Behind modals and drawers |
| `ink` | `#0F172A` | `#E7ECF3` | Primary text (AAA) |
| `ink-muted` | `#3F4E63` | `#B3BECD` | Body copy, secondary text (AAA) |
| `ink-subtle` | `#57677C` | `#8D9BAD` | Metadata, never below 14px (AA) |
| `ink-inverse` | `#FFFFFF` | `#14181F` | Text on `bg-ink` |
| `border-soft` | `#D9E1EA` | `#2B333E` | Default hairlines, dividers |
| `border` | `#C2CEDB` | `#3A4450` | Input borders, card borders on Home |
| `border-strong` | `#7C8BA0` | `#6E7A8C` | Hover borders, a 3:1 non-text edge (WCAG 1.4.11) |

### 4.2 Brand / action: primary blue

| Token | Light | Dark |
|---|---|---|
| `primary-50` | `#EFF6FF` | `#1E2A3D` |
| `primary-100` | `#DBEAFE` | `#24344B` |
| `primary-200` | `#BFDBFE` | same as light |
| `primary-300` | `#93C5FD` | same as light |
| `primary-400` | `#60A5FA` | same as light |
| `primary-500` | `#3B82F6` | `#7FA9F0` (primary used as text, focus) |
| **`primary-600`** | **`#2563EB`**, the action colour | `#2F5FBF` (fill) |
| `primary-700` | `#1D4ED8` (hover, links) | `#3A6ACC`. Hover is **lighter**, not darker, in dark mode. |
| `primary-800` / `-900` | `#1E40AF` / `#1E3A8A` | same as light |
| `on-primary` | `#FFFFFF` | `#F2F6FF` |
| `focus` | `#2563EB` | `#7FA9F0` |

- **Selected / active state everywhere:** `bg-primary-50 text-primary-700`.
- **Links and text actions:** `text-primary-700`.

### 4.3 Semantic (status) pairs

Always use the `-bg` + `-fg` pair together.

| Pair | Light bg / fg | Dark bg / fg | Meaning |
|---|---|---|---|
| `success` | `#E6F0EE` / `#2F6B5E` | `#1A2B29` / `#93C6BC` | Done, confirmed |
| `warning` | `#FBF0E2` / `#8A5A1B` | `#2A2519` / `#D7BE86` | Needs attention, pending |
| `critical` | `#FBEAE7` / `#A33A28` | `#33201C` / `#F0A99A` | Errors, validation, allergies |
| `info` | `#E8EFF6` / `#33608A` | `#1E2A38` / `#9CC0E8` | Neutral notices |
| `therapy` | `#EDEAF4` / `#574B7D` | `#262238` / `#BCB0E0` | A 5th category (purple) |
| `danger` | `#DC2626` (fg `#B91C1C`) | `#C0322D` (fg `#FF9A8F`) | **Emergency only**, e.g. "Call 108". Text on it uses `on-danger` (`#FFFFFF`). |
| `ai` / `ai-soft` | `#4F46E5` / `#EEF0FD` | `#A5A0F5` / `#22203A` | **Reserved for AI** surfaces |
| `clinic-accent` / `-strong` / `-soft` | `#16A34A` / `#15803D` / `#DCFCE7` | `#3FB973` / `#7FD9A4` / `#17301F` | One scoped accent: shapes use `-accent`, text uses `-strong` |

### 4.4 Categorical colour: three tiers, from quiet to loud

**Tier 1: pastel accents (quiet).** Use these for chips, category wells and the assistant's sky.

| Token pair | Light bg / fg | Dark bg / fg |
|---|---|---|
| `accent-sky` | `#E8EFF6` / `#3A6288` | `#1E2A38` / `#9CC0E8` |
| `accent-teal` | `#E6F0EE` / `#3C6B63` | `#1A2B29` / `#93C6BC` |
| `accent-sand` | `#F4EDE0` / `#7E6128` | `#2A2519` / `#D7BE86` |
| `accent-clay` | `#F6E9E4` / `#8B5544` | `#2E211C` / `#DBA895` |
| `accent-sage` | `#E9F0E6` / `#4C6B46` | `#1F2A1D` / `#A9C79F` |

Each `-fg` clears 4.9:1 in light and 7.4:1 in dark. Use them for **category**, never state.

**Tier 2: destination hues (`TONE_HEX`), used as soft tints.** Every navigation destination owns one hue. That hue appears on the navbar glyph, the drawer tile, the dashboard section heading and the "Go to" tile, so a place is recognisable by colour *and* shape.

```ts
export type IconTone = 'blue' | 'teal' | 'green' | 'amber' | 'orange' | 'red' | 'pink' | 'violet' | 'indigo' | 'gray'
export const TONE_HEX: Record<IconTone, string> = {
  blue: '#0A84FF', teal: '#30B0C7', green: '#34C759', amber: '#FF9F0A', orange: '#FF6B2C',
  red: '#FF3B30', pink: '#FF2D55', violet: '#AF52DE', indigo: '#5856D6', gray: '#8E8E93',
}
export function toneTint(tone: IconTone, alpha: number): string {
  const hex = TONE_HEX[tone]
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
/** A card tinted in a tone. The tint is LAYERED over the element's own surface
 *  (keep a bg-surface-* class on it), so it is opaque and theme-aware. */
export function tintedSurface(tone: IconTone, alpha = 0.08) {
  const tint = toneTint(tone, alpha)
  return { backgroundImage: `linear-gradient(${tint}, ${tint})`, borderColor: toneTint(tone, Math.min(alpha * 3.5, 0.45)) }
}
```

Our patient portal's assignment: Home `blue`, Appointments `orange`, Medicines `teal`, My Health `pink`, Health Notes `amber`, Reports `indigo`, AI Insights `violet`, My doctors `green`, Emergency `red`.

How much tint to use:

| Where | Amount |
|---|---|
| Soft icon tile | 12% of the hue (18% in dark), glyph a shade darker (`color-mix(... 72%, black)`, pure hue in dark) |
| Card wash (list cards, "Go to" tiles) | `tintedSurface(hue, 0.045)`, i.e. a 4.5% wash and a ~16% border |
| Button wash | ≤ 10% |

> **Rule of taste (from user feedback):** colour must be *subtle, not glowing, professional*. Put hue in tints; don't use solid saturated tiles for headings.

**Tier 3: solid tiles (loud, deliberate).** White text in both themes; these never change with the theme.

| Token | Hex | Contrast | Meaning in our portal |
|---|---|---|---|
| `tile-blue` | `#2F5AA8` | 6.7:1 | Appointments / logistics / updates |
| `tile-teal` | `#22685F` | 6.5:1 | Medicines |
| `tile-violet` | `#6A4E9E` | 6.6:1 | People / care team |
| `tile-amber` | `#8F5F32` | 5.5:1 | Allergy / attention |

Use them for the 4 KPI snapshot tiles, the activity timeline panel, the date block and avatar initials fills. For procurement: *Open POs* = blue, *Stock items* = teal, *Suppliers* = violet, *Low stock* = amber.

### 4.5 Charts

`chart-1` is `#2563EB` (dark `#5B8FE8`); `chart-2` is `#EB6834` (dark `#D95926`). Use at most two series. Always add a legend, end-of-line value labels, a hover/tap/keyboard tooltip and a "Show table" twin. Lines are 2px, markers at least 8px, gridlines hairline. Don't draw coloured "normal range" bands.

### 4.6 High contrast

`html[data-high-contrast='true']` darkens ink and borders:

- **Light:** ink `#000`, muted and subtle `#1E293B`, borders `#475569`, strong border `#334155`.
- **Dark:** ink `#FFF`, muted `#E2E8F0`, subtle `#CBD5E1`, borders `#8D9BAD`, strong border `#B3BECD`.

Inputs get `border-strong` edges. Place these rules **after** the dark block, or dark wins the tie.

---

## 5. Radius, shadow, spacing, density, z-index

### 5.1 Radius

| Token | Value | Typical use |
|---|---|---|
| `rounded` / `radius-sm` | 0.25rem | Tiny chips, `kbd` |
| `rounded-md` | 0.5rem | Status badge xs, small notices |
| `rounded-lg` | 0.75rem | **Buttons, inputs, nav items, menu items, toasts** |
| `rounded-xl` | 1rem | **Cards, tiles, menus, modals, table wrappers** |
| `rounded-2xl` | 1.25rem | Bottom sheet top, xl buttons, speech bubbles |
| `rounded-3xl` | 1.5rem | Hero cards (rare) |
| `rounded-full` | pill | Avatars, toggles, radio chips, FAB, badges |
| Icon tiles | `rounded-[8px]` (28px), `rounded-[10px]` (36px), `rounded-[14px]` (48px) | Squircle feel |

### 5.2 Shadows

The shadows are soft and layered, like paper resting on a surface.

| Token | Light | Dark |
|---|---|---|
| `shadow-card` | `0 1px 2px 0 rgba(15,23,42,0.04), 0 1px 3px 0 rgba(15,23,42,0.06)` | `0 1px 2px 0 rgba(0,0,0,0.40), 0 1px 3px 0 rgba(0,0,0,0.30)` |
| `shadow-card-md` | `0 2px 8px 0 rgba(15,23,42,0.06), 0 1px 3px 0 rgba(15,23,42,0.04)` | `0 2px 8px 0 rgba(0,0,0,0.45), 0 1px 3px 0 rgba(0,0,0,0.30)` |
| `shadow-card-lg` | `0 4px 16px 0 rgba(15,23,42,0.08), 0 2px 6px 0 rgba(15,23,42,0.04)` | `0 4px 16px 0 rgba(0,0,0,0.50), 0 2px 6px 0 rgba(0,0,0,0.35)` |
| `shadow-glow` | `0 0 0 3px rgba(37,99,235,0.12)` | `0 0 0 3px rgba(127,169,240,0.22)` |

Shadow ladder:

- **Resting** cards and tiles use `shadow-card`.
- **Hover** raises a card to `shadow-card-md` and lifts it `-translate-y-0.5`.
- **Floating** menus, drawers, toasts and the FAB use `shadow-card-lg`.
- **Modal:** `shadow-[0_20px_60px_0_rgba(15,23,42,0.18)]`.
- **Primary button:** a blue-tinted `shadow-[0_1px_3px_0_rgba(37,99,235,0.3)]`, which becomes `hover:shadow-[0_4px_16px_0_rgba(37,99,235,0.35)]`.

### 5.3 Spacing rhythm

Tailwind's default 4px scale; there are no custom spacing tokens.

| Context | Value |
|---|---|
| Page container | `mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 sm:py-6` (max 1280px) |
| Vertical stack between page sections | `space-y-6` (comfortable) · `space-y-4` (compact/clinical) |
| Grid gaps | `gap-4 sm:gap-5` on dashboards, `gap-3` inside tiles and lists |
| Card padding | `p-4 sm:p-5` (Home), `p-5` (admin cards), `p-3` (dense) |
| Heading → card | `mt-3.5` |
| Card header strip | `px-4 py-2.5 border-b border-border-soft` |
| List row | `px-4 py-2` (compact) · `px-5 py-3.5` (admin lists) |
| Menu item | `min-h-11 px-3.5` |

### 5.4 Density and touch targets

```css
--tap-min: 2.75rem;                /* 44px, WCAG 2.5.8 */
--row-h-compact: 2rem;             /* 32px rows (staff / clinical portals) */
--row-h-comfortable: 2.5rem;       /* 40px rows (public / patient portal)  */
[data-density='compact']                  { --row-h: var(--row-h-compact); }
[data-density='comfortable'], :root       { --row-h: var(--row-h-comfortable); }
.clinical-row { min-height: var(--row-h); }
```

Set `data-density` on the shell root:

- **compact** for expert, staff and back-office roles. A procurement officer's tables fit here.
- **comfortable** for public users and occasional users.

Density changes **row height only**. Buttons stay at least 44px.

### 5.5 z-index ladder

| z | What |
|---|---|
| `z-10` | Sticky table head, modal panel, chart tooltip, sticky save bar |
| `z-20` | Docked AI chat panel and its scrim |
| `z-30` | Sticky header, notification panel, phone bottom bar, AI launcher, insight bubble |
| `z-40` | Account menu |
| `z-50` | Modal, drawer, bottom sheet, nav drawer, idle warning |
| `z-[60]` | Toasts |
| `100` | Skip link |

Modals, drawers and bottom sheets are **portalled to `document.body`**, so no container on the page can trap them.

---

## 6. Theme switching (light / dark / system) and accessibility modes

### 6.1 The pre-paint script (must be in `<head>`, blocking, not a module)

A module script is deferred, so without this block React would paint light first and the page would flash. Rename the storage key per product.

```html
<script>
  (function () {
    try {
      var stored = localStorage.getItem('strokeai-theme')
      if (stored !== 'light' && stored !== 'dark' && stored !== 'system') stored = 'system'
      var isDark =
        stored === 'dark' ||
        (stored === 'system' &&
          window.matchMedia('(prefers-color-scheme: dark)').matches)
      if (isDark) document.documentElement.classList.add('dark')
      var meta = document.querySelector('meta[name="theme-color"]')
      if (meta) meta.setAttribute('content', isDark ? '#14181F' : '#E8EDF4')
    } catch (e) {
      /* Blocked storage — light theme is the correct fallback. */
    }
  })()
</script>
```

### 6.2 ThemeProvider behaviour

- **State:** `theme: 'light' | 'dark' | 'system'` (default `system`), stored in `localStorage['strokeai-theme']`. `resolvedTheme` is `light | dark`.
- **`applyToDocument(resolved)`** runs `document.documentElement.classList.toggle('dark', resolved === 'dark')` and sets `<meta name="theme-color">` to `#14181F` (dark) or `#E8EDF4` (light).
- **While `theme === 'system'`**, it listens to `matchMedia('(prefers-color-scheme: dark)')` `change` events.
- **`setTheme(next)`** writes localStorage and, when signed in, saves `preferences.appearance.theme` to the account (best effort; failures are silent). The account value is adopted once per distinct value at sign-in.
- **`toggleTheme()`** flips to the opposite of the *resolved* theme.
- **Sign-out does not reset the theme.**
- **The theme flip** is a 200ms colour cross-fade on `body`: `transition: background-color .2s var(--ease-smooth), color .2s var(--ease-smooth)`. Reduced motion cancels it.
- **Browser widgets:** `:root { color-scheme: light }`, and `color-scheme: dark` inside `:root.dark`, so scrollbars and native controls follow.

```tsx
const { profile, isAuthenticated } = useAuth()
const [theme, setThemeState] = useState<Theme>(readStored)
const resolved = useMemo(() => resolve(theme), [theme])
useEffect(() => { applyToDocument(resolved) }, [resolved])
useEffect(() => {                               // follow the OS only in "system"
  if (theme !== 'system') return undefined
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const onChange = () => applyToDocument(resolve('system'))
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}, [theme])
const toggleTheme = useCallback(() => {
  setTheme(resolve(theme) === 'dark' ? 'light' : 'dark')
}, [theme, setTheme])
```

### 6.3 Header theme toggle (the sun/moon switch)

This is a two-state switch (light ↔ dark). The three-way picker lives in Settings (§6.4).

```tsx
<button type="button" role="switch" aria-checked={isDark} aria-label="Dark mode"
  title={isDark ? 'Switch to light mode' : 'Switch to dark mode'} onClick={toggleTheme}
  className="focus-ring tap-target group relative inline-flex items-center rounded-full
             border border-border bg-surface-2 transition-colors hover:border-border-strong">
  {/* 56×32 track inside the 44px tap target */}
  <span aria-hidden="true" className="relative m-1 flex h-8 w-14 items-center rounded-full">
    <span className={`absolute z-10 flex h-6 w-6 items-center justify-center rounded-full
                      bg-surface-1 shadow-card transition-transform duration-200 ease-out
                      ${isDark ? 'translate-x-7' : 'translate-x-1'}`}>
      {isDark ? <Moon size={13} className="text-primary-500" strokeWidth={2.5} />
              : <Sun size={13} className="text-warning-fg" strokeWidth={2.5} />}
    </span>
    <Sun  size={12} className={`absolute left-1.5 transition-opacity ${isDark ? 'opacity-40' : 'opacity-0'} text-ink-subtle`} />
    <Moon size={12} className={`absolute right-1.5 transition-opacity ${isDark ? 'opacity-0' : 'opacity-40'} text-ink-subtle`} />
  </span>
</button>
```

### 6.4 Settings appearance picker

- **Layout:** three buttons in `grid grid-cols-3 gap-3`: Light (`Sun`), Dark (`Moon`) and System (`Monitor`), each with `aria-pressed`.
- **Selected:** `bg-primary-50 border-primary-600`.
- **Unselected:** `bg-surface-2 border-border-soft hover:border-border-strong`.

### 6.5 Accessibility modes (attributes on `<html>`)

| Setting | Attribute | Effect |
|---|---|---|
| Large text | `data-large-text="true"` | Re-defines the whole type ramp and row heights (§3.3) |
| High contrast | `data-high-contrast="true"` | Darker ink and borders (§4.6) |
| Reduce motion | `data-reduce-motion="true"` | Clamps every animation and transition to 0.01ms. The OS `prefers-reduced-motion` does the same. |

Each attribute is set to `"true"` when on and removed when off. They are saved to the user's account preferences and cleared on sign-out.

---

## 7. Layout & responsiveness

### 7.1 Rules that make the site never break

- **Supported width 320px to 1920px** with **no horizontal scroll**: `html, body { min-width: 320px }` and `body { overflow-x: clip }`. Test at 320, 360, 375, 390, 768, 820, 1024, 1280, 1440 and 1920.
- **`min-w-0` down every flex chain** that holds text, and `truncate` on names, so long labels shrink instead of widening the page.
- **Every control is at least 44px.** Below 768px, inputs are `min-height: 44px` and 16px text.
- **`html { scrollbar-gutter: stable }`**, so a modal's scroll lock never shifts the page sideways.
- **Safe areas:** fixed bottom bars use `.safe-bottom` (adds `env(safe-area-inset-bottom)` to the bottom padding); fixed toasts use `.safe-inset-b`.
- **Data tables become stacked cards below `md`** (§10.9). Don't use horizontal-scroll tables on phones.
- **Only the header's nav strip may scroll horizontally** (`scrollbar-hide overflow-x-auto`).

### 7.2 Breakpoint behaviour of the shell

| Width | Navigation | Page padding | Floating UI |
|---|---|---|---|
| < 640 | Hamburger + drawer, **bottom bar** (portal for the public), brand mark only | `px-4 py-5`, `pb-28` above the bottom bar | Launcher above the bottom bar |
| 640–767 | Same, wordmark and portal label visible | `sm:px-6 sm:py-6` | same |
| 768–1023 | Hamburger + drawer, bottom bar hidden (`md:hidden`) | same, `md:pb-6` | Launcher bottom-right |
| ≥ 1024 | **Horizontal nav strip** under the top row, hamburger hidden (`lg:hidden`) | same | The AI chat docks as a right column (§13) |

### 7.3 Layout-aware breakpoints: `main-md / main-lg / main-xl / main-2xl`

The AI chat can dock beside the page (§13). While it is docked, the content column is narrower than the screen, so page grids use these variants instead of `md: / lg: / xl:`.

- **Chat not docked:** each variant is identical to the screen breakpoint.
- **Chat docked:** each variant becomes a **container query** on the content column.

```css
@custom-variant main-lg {
  @media (width >= 64rem)       { :root:not([data-chat-docked='true']) & { @slot; } }
  @container main (width >= 61rem) { :root[data-chat-docked='true'] & { @slot; } }
}
/* main-md: 48rem / 45rem · main-xl: 80rem / 77rem · main-2xl: 96rem / 77rem (column cap) */
```

- Convert **every** breakpoint class for a given property on an element together (`main-md:` … `main-xl:`), because `main-*` wins on specificity over plain `lg:`.
- The container is applied to `.app-content` **only while docked**. Containment re-anchors `position: fixed` children, which is why overlays are portalled to `<body>`.
- **No docked side panel in your portal?** Plain `md:/lg:/xl:` is fine.

---

## 8. App shell & navbar

### 8.1 Anatomy

```
┌─────────────────────────── <header> sticky top-0 z-30, bg-surface-1/95 + backdrop-blur, border-b ─────────────────────────┐
│ [☰ lg:hidden] [Mark] SHRI HEALTH / Patient Portal                 [🚨 lg:hidden] [☀︎◯ theme] [🔔 badge] [Avatar Name ▾] │  ← h-16
│ [🏠 Home] [📅 Appointments] [💊 Medicines] [📁 My Health] …                                      (lg+ only, scrolls-x)    │  ← nav strip, pb-2
│ (optional sticky strips: Offline · warnings · context banner)                                                           │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
<main id="main-content">  └─ .app-content  mx-auto max-w-7xl px-4 py-5 sm:px-6 sm:py-6   ← your page
[phone bottom bar md:hidden]   [AI launcher / docked chat]   [toasts]   [idle warning]
```

Landmarks are semantic (`<header>`, `<nav aria-label="Main navigation">`, `<main id="main-content" tabIndex={-1}>`). A **skip link** comes first in the DOM.

### 8.2 Header code (class strings verbatim)

```tsx
<div className="min-h-screen bg-bg text-ink" data-density={isStaff ? 'compact' : 'comfortable'}>
  <a href="#main-content" className="skip-link">Skip to main content</a>

  <header className="sticky top-0 z-30 border-b border-border-soft bg-surface-1/95 backdrop-blur">
    <div className="flex h-16 items-center gap-1.5 px-4 min-[360px]:gap-2.5 sm:px-6">
      <button aria-label="Open navigation menu" aria-expanded={drawerOpen}
        className="focus-ring tap-target -ml-1 rounded-lg text-ink-muted hover:bg-surface-2 lg:hidden">
        <Menu size={21} aria-hidden="true" />
      </button>
      <BrandMark size={16} />
      <span className="hidden whitespace-nowrap text-[15px] font-bold tracking-[0.06em] text-ink sm:inline">SHRI HEALTH</span>
      <span aria-hidden="true" className="hidden text-ink-subtle sm:inline">/</span>
      <span className="hidden whitespace-nowrap text-sm font-medium text-ink-subtle sm:inline">{portal.label}</span>

      <div className="ml-auto flex min-w-0 items-center gap-0.5 min-[360px]:gap-1.5">
        {/* critical destination always one tap away on small screens */}
        <NavLink to="/app/emergency" aria-label="Emergency"
          className="focus-ring tap-target rounded-lg text-critical-fg transition-colors hover:bg-critical-bg lg:hidden">
          <Siren size={20} aria-hidden="true" />
        </NavLink>
        <ThemeToggle /> <NotificationBell /> <AccountMenu />
      </div>
    </div>

    <nav aria-label="Main navigation" className="scrollbar-hide relative hidden overflow-x-auto px-4 pb-2 sm:px-6 lg:block">
      <ul className="flex gap-1">{/* items */}</ul>
    </nav>
    {/* sticky strips go here, inside <header>, so they stay visible */}
  </header>

  <main id="main-content" tabIndex={-1} className="overflow-x-hidden">
    <div className="app-content mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 sm:py-6 pb-28 md:pb-6">
      <Outlet />
    </div>
  </main>
</div>
```

### 8.3 Nav item states

```ts
function navItemClass(isActive: boolean, tone?: 'emergency') {
  const base = 'focus-ring inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors'
  if (tone === 'emergency')
    return `${base} ${isActive ? 'bg-critical-bg text-critical-fg' : 'text-critical-fg hover:bg-critical-bg'}`
  return `${base} ${isActive ? 'bg-primary-50 text-primary-700' : 'text-ink-muted hover:bg-surface-2 hover:text-ink'}`
}
// icon inside: <item.icon size={17} strokeWidth={isActive ? 2.2 : 1.8} style={{ color: TONE_HEX[item.hue] }} />
// active item also gets <span className="sr-only">(current page)</span>
```

The glyph is **tinted** in the destination hue, but the item itself isn't tiled, so the strip stays light.

### 8.4 Navigation data model (role-based portals)

The shell never hard-codes menus. Each role gets a descriptor:

```ts
interface NavItem { label: string; path: string; icon: ComponentType<LucideProps>; end?: boolean;
                    description?: string; tone?: 'emergency'; hue?: IconTone }
interface AccountNavItem { label: string; path: string; icon: ComponentType<LucideProps>; hue?: IconTone }
interface PortalDescriptor { label: string; home: string; items: NavItem[]; account: AccountNavItem[] }
// e.g. { label: 'Appointments', path: '/app/appointments', icon: Calendar,
//        description: 'Visits and video consultations', hue: 'orange' }
```

- `portalForRole(role)` returns the descriptor.
- The document title is `${pageTitle} · SHRI HEALTH`, using a longest-prefix route → title map.
- A module the user can't enter is **absent, not disabled**.

### 8.5 Mobile nav drawer (slide-over)

- **Wrapper:** `fixed inset-0 z-50 lg:hidden`.
- **Scrim:** a `motion.button` with `absolute inset-0 bg-scrim` that fades opacity 0→1 over 0.15s. Clicking it closes the drawer.
- **Panel:** `motion.div role="dialog" aria-modal="true"` with `absolute left-0 top-0 flex h-full w-[86vw] max-w-[300px] flex-col border-r border-border-soft bg-surface-1`.
  - Motion: `initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}`.
- **Header row:** `flex h-16 items-center gap-2.5 border-b border-border-soft px-4`, holding the brand and a close X.
- **Section label:** `px-3 pb-2 text-xs font-semibold uppercase tracking-wider text-ink-subtle`.
- **Item:** `navItemClass + w-full !items-start px-3 py-2.5`, with a solid `IconTile size="sm"` in the hue, the label, and a description line `block truncate text-xs font-normal text-ink-subtle`.
- **Footer:** `border-t border-border-soft px-4 py-3 text-xs text-ink-subtle`, reading "Signed in as {role}".
- **Behaviour:** focus trap (Tab cycles), Esc closes, body scroll lock, and focus returns to the hamburger. It closes on route change.

### 8.6 Account menu

- **Trigger:** `focus-ring flex min-h-11 min-w-0 max-w-full items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2`, containing:
  - an avatar: a photo, or initials `h-8 w-8 rounded-full bg-primary-50 text-xs font-bold text-primary-700`;
  - the name, `hidden min-w-0 max-w-[160px] truncate text-sm font-medium text-ink sm:block`;
  - a `ChevronDown size={15}`.
  - Its label is `aria-label="Account menu, {name}"`.
- **Panel:** `absolute right-0 top-[calc(100%+6px)] z-40 w-56 overflow-hidden rounded-xl border border-border-soft bg-surface-1 shadow-card-lg`, with `role="menu"`.
  - Identity block: `border-b border-border-soft px-3.5 py-3`, the name in `text-sm font-semibold`, the email in `text-xs text-ink-subtle`.
  - Items: `focus-ring flex min-h-11 w-full items-center gap-2.5 px-3.5 text-sm text-ink-muted transition-colors hover:bg-surface-2`.
  - Sign out: `… font-medium text-critical-fg hover:bg-critical-bg`.
- It closes on outside click and on Esc, returning focus to the trigger.

### 8.7 Notification bell

- **Trigger:** `focus-ring tap-target relative rounded-lg text-ink-muted hover:bg-surface-2` with `Bell size={19}`.
  - Badge: `absolute right-1.5 top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-2xs font-semibold leading-none tabular-nums text-on-primary`, capped at "9+".
- **Panel:** `absolute right-0 top-[calc(100%+6px)] z-30 w-[calc(100vw-2rem)] max-w-sm overflow-hidden rounded-xl border border-border-soft bg-surface-1 shadow-card-lg`, with a list `max-h-96 overflow-y-auto`.
  - Row: `flex w-full items-start gap-2.5 border-b border-border-soft px-3.5 py-3 text-left hover:bg-surface-2`, plus `bg-primary-50/40` when unread.
  - "New" pill: `rounded-full bg-primary-100 px-1.5 py-0.5 text-2xs font-semibold text-primary-700`.
  - Footer link: `block border-t border-border-soft px-3.5 py-2.5 text-center text-sm font-medium text-primary-700 hover:bg-surface-2`.
- **Polling:** every 60s.

### 8.8 Phone bottom bar (for public/occasional-user portals)

```tsx
<nav aria-label="Quick navigation"
  className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-border-soft bg-surface-1/95 backdrop-blur md:hidden">
  <ul className="mx-auto flex max-w-md items-stretch gap-1 px-2 pt-1">
    {/* tab: */}
    <li className="flex flex-1"><NavLink className={({isActive}) =>
      `focus-ring flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg text-[11px] font-medium transition-colors ${
        isActive ? 'text-primary-700' : 'text-ink-subtle hover:text-ink'}`}>
      <Home size={20} aria-hidden="true" /> Home</NavLink></li>
    {/* centre FAB (the most frequent action; here "record a health note"): */}
    <li className="flex flex-1 justify-center"><NavLink aria-label="Record a health note"
      className="focus-ring -mt-5 flex h-14 w-14 flex-col items-center justify-center rounded-full bg-primary-600 text-on-primary shadow-card-lg transition-colors hover:bg-primary-700">
      <Mic size={22} aria-hidden="true" /></NavLink></li>
    {/* … Visits, Medicines, Menu (opens the drawer) */}
  </ul>
</nav>
```

Five items: 4 tabs plus the centre FAB. Labels stay fixed at 11px so five fit side by side at 320px. For procurement, the centre FAB could be "Scan item" or "New request".

### 8.9 Sticky strips inside the header

- **Offline:** `flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-warning-fg/30 bg-warning-bg px-4 py-2 text-xs text-warning-fg sm:px-6` with `CloudOff size={14}` and `role="status"`. It can't be dismissed.
- **Warning banner:** `border-b border-warning-fg/40 bg-warning-bg px-4 py-2 sm:px-6`, with inner `mx-auto flex w-full max-w-7xl items-start gap-2.5`.
- **Context banner** (the record you're acting on, e.g. patient, supplier or PO):
  - Strip: `border-b border-border-soft bg-surface-2 px-4 py-2 sm:px-6`.
  - Row: `mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-3 gap-y-1`.
  - ID chip: `rounded bg-surface-3 px-1.5 py-0.5 font-mono text-2xs text-ink-muted`.
  - Alert chip: `rounded bg-critical-bg px-2 py-0.5 text-xs font-semibold text-critical-fg`.

---

## 9. Dashboards: the bento grid and friends

### 9.1 The Home bento grid

The grid uses **auto-placement only**: no `col-start`, `order-*` or `grid-flow-dense`. So **source order = visual order = tab order** at every width.

```ts
const GRID = 'grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 main-md:grid-cols-4 main-xl:grid-cols-6 main-xl:auto-rows-[minmax(8rem,auto)]'
const CELLS = [
  { key: 'snapshot',    span: 'sm:col-span-2 main-md:col-span-4 main-xl:col-span-2 main-xl:row-span-2', skeleton: 'h-56' },
  { key: 'appointment', span: 'sm:col-span-2 main-md:col-span-4 main-xl:col-span-4 main-xl:row-span-2', skeleton: 'h-56' },
  { key: 'trends',      span: 'sm:col-span-2 main-md:col-span-4 main-xl:col-span-6',                    skeleton: 'h-80' },
  { key: 'activity',    span: 'sm:col-span-2 main-md:col-span-2 main-md:row-span-2 main-xl:col-span-4 main-xl:row-span-2', skeleton: 'h-64' },
  { key: 'careteam',    span: 'sm:col-span-1 main-md:col-span-2 main-xl:col-span-2', skeleton: 'h-40' },
  { key: 'meds',        span: 'sm:col-span-1 main-md:col-span-2 main-xl:col-span-2', skeleton: 'h-40' },
  { key: 'links',       span: 'sm:col-span-2 main-md:col-span-4 main-xl:col-span-4', skeleton: 'h-28' },
  { key: 'emergency',   span: 'sm:col-span-2 main-md:col-span-4 main-xl:col-span-2', skeleton: 'h-28' },
]
```

The skeleton grid is rendered from the **same** `CELLS`, so nothing jumps when data arrives:

```tsx
<div className={GRID}>{CELLS.map((c) => <div key={c.key} className={c.span}><Skeleton className={`w-full ${c.skeleton}`} rounded="rounded-xl" /></div>)}</div>
```

Layout by width (6 columns at xl):

```
xl (≥1280)                          md–lg (768–1279, 4 cols)        sm (640–767, 2 cols)   <640 (1 col)
┌──────────┬────────────────────┐   ┌──────────────────────────┐    ┌──────────────┐       stacked in
│ snapshot │ appointment+calendar│   │ snapshot (4 tiles in row)│    │ snapshot     │       source order
│ 2×2 tiles│      (4 cols)       │   ├──────────────────────────┤    ├──────────────┤
├──────────┴────────────────────┤   │ appointment + calendar   │    │ appointment  │
│ readings over time (6 cols)   │   ├──────────────────────────┤    ├──────────────┤
├────────────────────┬──────────┤   │ trends                   │    │ trends       │
│ recent activity    │ doctors  │   ├─────────────┬────────────┤    ├──────┬───────┤
│   (4 cols, 2 rows) ├──────────┤   │ activity    │ doctors    │    │doctors│ meds │
│                    │ meds     │   │ (2 rows)    ├────────────┤    ├──────┴───────┤
├────────────────────┼──────────┤   │             │ meds       │    │ go to        │
│ go to (5 tiles)    │ emergency│   ├─────────────┴────────────┤    │ emergency    │
└────────────────────┴──────────┘   │ go to · emergency        │    └──────────────┘
```

Page top, above the grid:
- a greeting `h1` and a one-line description that states *what the page contains*. It is never motivational ("Here is your care, your records and what is coming up.");
- on the right, a secondary action pill.

### 9.2 Cell anatomy and `SectionHeading`

Every cell is `<section aria-labelledby=… className="flex h-full flex-col">`, then a heading row, then the card body `mt-3.5 flex-1 rounded-xl border border-border bg-surface-1 p-4 shadow-card sm:p-5`.

```tsx
// The heading row is ALWAYS min-h-11 (44px), the same height as a row that carries a "View all →" link,
// so cards side by side start level.
export default function SectionHeading({ id, icon, tone, children, className = 'text-ink' }) {
  return (
    <h2 id={id} className={`flex min-h-11 min-w-0 items-center gap-2 text-sm font-semibold ${className}`}>
      <SoftIconTile icon={icon} tone={tone} size="sm" />
      <span className="min-w-0">{children}</span>
    </h2>
  )
}
// With a link:
<div className="flex items-center justify-between gap-3">
  <SectionHeading id="next-heading" icon={Calendar} tone="orange">Your next appointment</SectionHeading>
  <Link to="/app/appointments" className="focus-ring inline-flex min-h-11 items-center gap-1 rounded-lg px-1 text-sm font-semibold text-primary-700 hover:underline">
    All appointments <ArrowRight size={14} aria-hidden="true" />
  </Link>
</div>
```

### 9.3 Cell recipes

**KPI snapshot tiles (solid, 2×2 at xl, 4 in a row at md).**
- Grid: `mt-3.5 grid flex-1 grid-cols-2 gap-3 main-md:grid-cols-4 main-xl:grid-cols-2`.
- Tile, a link to its page: `focus-ring group flex min-h-11 flex-col gap-2.5 rounded-xl border border-transparent bg-tile-teal p-4 shadow-card transition-transform hover:-translate-y-0.5 hover:shadow-card-md`.
- Icon chip: `flex h-9 w-9 items-center justify-center rounded-lg bg-white/15`, holding the icon at size 17.
- Value: `text-2xl font-semibold leading-none tracking-tight text-tile-teal-fg`, followed by the label `text-sm opacity-90`.
- Hint: `text-xs leading-relaxed opacity-75`.
- Caption under the grid: `mt-2 text-sm text-ink-subtle` ("Counted from your records. Tap any item to see the detail.").
- Every number is *counted* from real records. Nothing is scored or predicted.

**"Next item" card with a calendar** (next appointment, or for procurement: next delivery).
- Body: `… flex flex-col gap-5 … main-lg:flex-row main-lg:items-start`.
- Date block: `flex h-16 w-16 flex-shrink-0 flex-col items-center justify-center rounded-xl bg-tile-blue shadow-card`.
  - Month: `text-2xs font-semibold uppercase tracking-wide text-tile-blue-fg/85`.
  - Day: `text-2xl font-semibold leading-none text-tile-blue-fg`.
- Person or party: `Avatar size="lg"` + name `text-base font-semibold text-ink` + a relative chip `rounded-md bg-primary-50 px-2 py-0.5 text-xs font-semibold text-primary-700` ("In 3 days").
- Mini calendar pane: `border-t border-border-soft pt-4 main-lg:w-64 main-lg:flex-shrink-0 main-lg:border-l main-lg:border-t-0 main-lg:pl-5 main-lg:pt-0`.
  - Today is ringed; marked days carry dots (● confirmed, ○ awaiting).
- Empty version: an icon well `h-11 w-11 rounded-xl bg-surface-2`, a sentence and a primary CTA.

**Line-chart card**, "Your readings over time".
- Metric radio chips: `focus-ring min-h-11 rounded-full border px-3.5 text-sm font-medium transition-colors`.
  - On: `border-primary-600 bg-primary-600 text-on-primary shadow-card`.
  - Off: `border-border-soft text-ink-muted hover:border-border-strong hover:text-ink`.
- A "Show table" toggle, a caption, a legend, the chart, and a footnote.
- The chart itself is hand-written SVG with a real time axis:
  - the line breaks for gaps longer than 21 days;
  - a crosshair and tooltip on hover, tap and ← → Home End keys;
  - an `aria-live` reading and a table twin.

**Activity timeline panel (solid).**
- Panel: `mt-3.5 flex-1 rounded-xl bg-tile-blue p-4 shadow-card`.
- Markers: `flex h-8 w-8 items-center justify-center rounded-full bg-white/15 text-white`, joined by a `w-px flex-1 bg-white/20` line.
- Text: `text-white` for titles, `text-white/75` for bodies.
- "New" pill: `rounded bg-white px-1.5 py-0.5 text-2xs font-semibold text-tile-blue`.

**List cards (tinted).**
- Card: `mt-3.5 flex-1 rounded-xl border bg-surface-1 p-4 shadow-card`, with `style={tintedSurface('green', 0.045)}`.
- Content: portrait + name + role rows.
- Chips: `rounded-full px-2.5 py-1 text-xs font-medium bg-accent-teal text-accent-teal-fg`; overflow shows as "+N".

**"Go to" tiles** (quick links in each destination's hue).

```tsx
<ul className="mt-3.5 grid flex-1 grid-cols-2 gap-3 sm:grid-cols-3 main-md:grid-cols-5">
  <li className="aspect-square">
    <Link to={to} style={tintedSurface(hue, 0.045)}
      className="focus-ring group flex h-full w-full flex-col items-center justify-center gap-2 rounded-xl border bg-surface-1 p-3 text-center shadow-card transition-all hover:-translate-y-0.5 hover:shadow-card-md">
      <span className="transition-transform group-hover:scale-105"><SoftIconTile icon={icon} tone={hue} size="lg" /></span>
      <span className="min-w-0 text-sm font-semibold text-ink">{label}</span>
      <ArrowRight size={13} aria-hidden="true" style={{ color: TONE_HEX[hue] }}
        className="hidden -translate-y-0.5 opacity-0 transition-all group-hover:translate-y-0 group-hover:opacity-100 sm:block" />
    </Link>
  </li>
</ul>
```

**Critical action strip** (our "Think you are having a stroke? Call 108"; for procurement, e.g. a stock-out escalation).
- Card: `mt-3.5 flex flex-1 flex-col justify-center gap-3 rounded-xl border border-critical-fg/30 bg-critical-bg p-4`.
- Primary action: `focus-ring inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-danger px-4 text-sm font-semibold text-on-danger transition-opacity hover:opacity-90`.
- Secondary action: `… border border-critical-fg/40 bg-surface-1 text-critical-fg hover:bg-critical-bg`.
- Keep it **short and last**. It is never sticky and never animated.

**Cell error.** The cell keeps its span, with a heading row plus an error `Banner` and a Retry link, so one failed request never reflows the dashboard.

### 9.4 Dense staff dashboard ("My Day" pattern)

For expert daily-use portals, e.g. a procurement officer's worklist.

- **Header row:** `flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between`. Actions such as Refresh use `focus-ring tap-target inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-1 px-3 text-xs font-medium text-ink-muted hover:bg-surface-2`, with a key hint `<kbd className="ml-0.5 rounded border border-border-soft bg-surface-2 px-1 font-mono text-2xs">r</kbd>`.
- **Main + rail:** `grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]`. The left column is `min-w-0 space-y-4`.
- **Section card:**
  - card `rounded-xl border border-border-soft bg-surface-1` (flat, no shadow);
  - header strip `flex items-center justify-between gap-3 border-b border-border-soft px-4 py-2.5` with title `text-sm font-semibold text-ink`;
  - list `divide-y divide-border-soft`, rows `clinical-row flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2`;
  - initials dot `flex h-7 w-7 items-center justify-center rounded-full bg-primary-50 text-2xs font-bold text-primary-700`.
- **KPI tiles:** `grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4`.
  - Tile: `flex flex-col rounded-xl border border-border-soft bg-surface-1 p-4`.
  - Label: `text-xs font-medium text-ink-subtle`.
  - Icon chip: `h-7 w-7 rounded-lg bg-surface-2`, holding a size-14 `text-primary-700` icon.
  - Value: `mt-2 text-2xl font-semibold leading-none tracking-tight tabular-nums`.
  - Sub-line: `mt-1 text-xs text-ink-subtle`.
  - Action: `mt-3 inline-flex items-center gap-1 self-start rounded text-xs font-semibold text-primary-700 hover:underline`.
- **Context rail:** `grid grid-cols-1 divide-y divide-border-soft rounded-xl border border-border-soft bg-surface-1 sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-1 xl:divide-x-0 xl:divide-y`, with `p-5` panes.
- **"Not available yet" card:** `border-l-2 border-l-info-fg/50` inner, with an info icon well. It states honestly what isn't built.

### 9.5 Admin dashboard pattern

- **Stat grid:** `grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4`.
  - StatCard: `<Card padding="lg">`, with an icon disc `flex h-10 w-10 items-center justify-center rounded-full bg-primary-50 text-primary-700` (icon size 18).
  - Value: `text-2xl font-bold tracking-tight text-ink`. Label: `text-xs text-ink-subtle`.
- **Bar rows:** track `h-2 flex-1 overflow-hidden rounded-full bg-surface-3`, fill `h-full rounded-full bg-primary-600`.
- **Mini column chart:** `mt-4 flex h-24 items-end gap-1`, bars `flex-1 rounded-t bg-primary-600/80`.
- **List page:** `<Card padding="none">` wrapping `<ul className="divide-y divide-border-soft">`.
  - Rows: `flex flex-col gap-1 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between`.
  - Empty and loading: `p-5 text-sm text-ink-muted`.

---

## 10. Components

### 10.1 Button

```tsx
const VARIANTS = {
  primary:   'bg-primary-600 text-on-primary border-transparent hover:bg-primary-700 shadow-[0_1px_3px_0_rgba(37,99,235,0.3)] hover:shadow-[0_4px_16px_0_rgba(37,99,235,0.35)]',
  secondary: 'bg-primary-50 text-primary-700 border-primary-200 hover:bg-primary-100 hover:border-primary-300',
  ghost:     'bg-transparent text-ink-subtle border-transparent hover:bg-surface-2 hover:text-ink',
  danger:    'bg-danger text-on-primary border-transparent hover:bg-danger-fg shadow-[0_1px_3px_0_rgba(220,38,38,0.3)] hover:shadow-[0_4px_16px_0_rgba(220,38,38,0.3)]',
  outline:   'bg-surface-1 text-ink border-border-soft hover:bg-surface-2 hover:border-border-strong',
  success:   'bg-success-fg text-on-primary border-transparent hover:bg-success-fg shadow-[0_1px_3px_0_rgba(22,163,74,0.3)] hover:shadow-[0_4px_16px_0_rgba(22,163,74,0.3)]',
}
// Every size has a MIN HEIGHT (padding alone does not guarantee 44px). xs (36px) only inside dense rows.
const SIZES = {
  xs: 'min-h-9 px-3 py-1.5 text-xs rounded-lg gap-1.5',
  sm: 'min-h-11 px-3.5 py-2 text-xs rounded-lg gap-1.5',
  md: 'min-h-11 px-4 py-2 text-sm rounded-lg gap-2',
  lg: 'min-h-12 px-5 py-2.5 text-sm rounded-xl gap-2',
  xl: 'min-h-14 px-8 py-4 text-base rounded-2xl gap-3',
}
<motion.button whileTap={disabled ? {} : { scale: 0.97 }}
  className={`inline-flex items-center justify-center font-semibold border transition-all duration-200
    focus:outline-none focus:ring-4 focus:ring-primary-600/15 disabled:opacity-50 disabled:cursor-not-allowed
    ${VARIANTS[variant]} ${SIZES[size]} ${fullWidth ? 'w-full' : ''}`}>
  {loading ? <Loader2 size={14} className="animate-spin flex-shrink-0" /> : icon}
  <span>{children}</span>{iconRight}
</motion.button>
```

Common hand-rolled equivalents:

| Kind | Classes |
|---|---|
| Primary link-button | `focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-semibold text-on-primary transition-colors hover:bg-primary-700` |
| Full-width form submit | `focus-ring mt-6 flex min-h-12 w-full items-center justify-center rounded-xl bg-primary-600 px-5 text-sm font-semibold text-on-primary transition-colors hover:bg-primary-700 disabled:opacity-60` |
| Text action ("View all →") | `focus-ring inline-flex min-h-11 items-center gap-1 rounded-lg px-1 text-sm font-semibold text-primary-700 hover:underline` + `<ArrowRight size={14}/>` |
| Secondary pill | `focus-ring tap-target inline-flex items-center gap-2 rounded-lg border border-border-soft bg-surface-1 pl-1.5 pr-3 text-sm font-medium text-ink hover:bg-surface-2` + a leading `SoftIconTile size="sm"` |
| Icon button | `focus-ring tap-target rounded-lg text-ink-muted hover:bg-surface-2`, icon 16–21 |

**One primary button per view.** Destructive actions go through a confirm dialog.

### 10.2 Form fields

**Standard field:**
- Label: `mb-1.5 flex items-center gap-1 text-sm font-medium text-ink-muted`. A required mark is `<span className="text-critical-fg">*</span>`; an optional note is `<span className="text-xs font-normal text-ink-subtle">(optional)</span>`.
- Input: `w-full rounded-lg border bg-surface-1 px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-subtle transition-colors duration-150 focus:outline-none focus:ring-2 focus:border-transparent`.
  - Normal: `border-border-soft focus:ring-primary-700/30`.
  - Error: `border-critical-fg/40 focus:ring-critical-fg/35`.
- Hint: `mt-1 text-xs text-ink-subtle`.
- Error message: `mt-1 text-xs text-critical-fg`, with `role="alert"`.

**Field with leading icon:**
- Wrapper: `relative group`.
- Icon: `absolute left-3 sm:left-3.5 top-1/2 -translate-y-1/2 text-ink-subtle transition-colors group-focus-within:text-primary-700 pointer-events-none`, size 16.
- Input: `min-h-11 w-full border border-border-soft bg-surface-1 rounded-lg pl-9 sm:pl-10 pr-4 py-2 sm:py-2.5 text-sm text-ink placeholder:text-ink-subtle focus:outline-none focus:ring-2 focus:ring-primary-700/35 focus:border-transparent transition-all duration-200 hover:border-border`.

**Search:** `w-full bg-surface-1 border border-border-soft text-ink placeholder-ink-subtle rounded-xl px-4 py-2.5 pl-9 text-sm transition-all duration-200 focus:outline-none focus:border-primary-600 focus:ring-4 focus:ring-primary-600/10 hover:border-border-strong`. The search icon is at `left-3`.

**Select:**
- Standard: `focus-ring min-h-11 w-full rounded-lg border border-border bg-surface-1 px-3 text-sm text-ink`.
- Compact: `focus-ring appearance-none rounded-lg border border-border bg-surface-1 py-1.5 pl-2.5 pr-7 text-xs font-medium text-ink`, plus an absolute `ChevronDown size={13}`.

**OTP / code cell:** `h-14 w-full min-w-0 rounded-xl border bg-surface-1 text-center text-xl font-semibold tabular-nums text-ink transition-all focus:border-transparent focus:outline-none focus:ring-2`.

**Auth input** (on the dot-grid sign-in background): `.auth-input` is `w-full rounded-xl border border-border bg-surface-1/80 py-3 pl-10 pr-3 text-sm text-ink … focus:border-primary-500 focus:bg-surface-1 focus:ring-4`, with the ring at `focus` 22%.

### 10.3 Toggle switch (settings)

```tsx
<button role="switch" aria-checked={enabled} onClick={onToggle} style={{ height: '1.5rem' }}
  className={`focus-ring tap-target relative w-11 rounded-full transition-colors duration-300 flex-shrink-0 ${enabled ? 'bg-primary-600' : 'bg-surface-3'}`}>
  <motion.span className="absolute top-1 w-4 h-4 bg-surface-1 rounded-full shadow-sm"
    animate={{ x: enabled ? 20 : 2 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }} />
</button>
```

Settings rows use `flex items-center justify-between gap-4 border-b border-border-soft py-4 last:border-0`. Each row has an icon well `flex h-9 w-9 items-center justify-center rounded-lg` in one of these tone pairs: `bg-primary-50 text-primary-700`, `bg-success-bg text-success-fg`, `bg-warning-bg text-warning-fg` or `bg-surface-2 text-ink-subtle`. The label is followed by a sub-line.

### 10.4 Segmented control, radio chips, tabs

**Segmented control:** a `role="radiogroup"` in `inline-flex gap-1 rounded-xl border border-border-soft bg-surface-2 p-1`.
- Segment: `focus-ring min-h-10 rounded-lg px-4 text-sm font-medium`.
- Selected: `bg-surface-1 text-ink shadow-card`.
- Unselected: `text-ink-muted hover:text-ink`.

**Radio chips:** see the chart metric chips in §9.3. Use them with arrow-key roving `tabIndex`.

**Tabs:**
- List: `role="tablist"` in `scrollbar-hide flex gap-1 overflow-x-auto border-b border-border-soft`.
- Tab: `focus-ring clinical-row -mb-px flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors`.
  - Active: `border-primary-600 text-primary-700`.
  - Inactive: `border-transparent text-ink-subtle hover:text-ink`.
- Count pill: `rounded-full px-1.5 text-2xs font-semibold tabular-nums`, `bg-primary-100 text-primary-700` when active.
- Keyboard: ← → wrap, Home and End, and number keys 1–9 jump.

**Vertical settings navigation:** `focus-ring group flex w-full min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors duration-200`.
- Active: `bg-primary-50 text-primary-700`, plus a `ChevronRight size={13}`.
- Inactive: `text-ink-subtle hover:bg-surface-2 hover:text-ink`.
- Each item has a solid `IconTile size="sm"`.
- Layout: a `flex flex-col main-lg:flex-row gap-6` page with a `main-lg:w-64` sidebar.

### 10.5 Card

The de-facto card (use this):

- Home and dashboard: `rounded-xl border border-border bg-surface-1 p-4 shadow-card sm:p-5`.
- Flat staff card: `rounded-xl border border-border-soft bg-surface-1`.

The `<Card>` component's variants:

| Variant | Classes |
|---|---|
| default | `bg-surface-1/95 border border-border-soft shadow-[0_1px_2px_0_rgba(15,23,42,0.03),0_8px_24px_rgba(15,23,42,0.04)]` |
| elevated | `bg-surface-1/95 border border-border-soft shadow-[0_18px_45px_0_rgba(15,23,42,0.08)]` |
| ghost | `bg-surface-2 border border-border-soft` (quiet info notes) |
| bordered | `bg-surface-1 border-2 border-border-soft` |
| gradient | `border border-border-soft` + `background: linear-gradient(160deg, var(--color-surface-1) 0%, var(--color-primary-50) 100%)` |
| primary | `border border-primary-200` + gradient `primary-50 → primary-100` |

Card props:
- **Padding:** `p-3`, `p-4`, `p-5` (default) or `p-6`.
- **Radius:** `rounded-xl` (default), `rounded-2xl` or `rounded-3xl`.
- **`hover`** adds `.card-hover` (lift 2px, stronger shadow, 0.25s premium).
- **`animate`** enters with `initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, delay, ease: [0.16,1,0.3,1] }}`.

Glass surfaces (sign-in pages):
- `.glass`: surface at 72% with `backdrop-filter: blur(12px)`.
- `.page-card`: surface at 88% with `blur(18px)`, plus `shadow-card-lg`.

### 10.6 Badges, chips, pills

**StatusBadge.** Base: `inline-flex items-center font-semibold border whitespace-nowrap select-none`.

| Variant | Classes |
|---|---|
| success | `bg-success-bg text-success-fg border-success-fg/25` |
| danger | `bg-critical-bg text-critical-fg border-critical-fg/25` |
| warning | `bg-warning-bg text-warning-fg border-warning-fg/25` |
| info | `bg-info-bg text-info-fg border-info-fg/25` |
| primary | `bg-primary-50 text-primary-700 border-primary-200` |
| muted | `bg-surface-2 text-ink-subtle border-border-soft` |
| purple | `bg-therapy-bg text-therapy-fg border-therapy-fg/25` |
| dark | `bg-ink text-ink-inverse border-transparent` |

| Size | Classes |
|---|---|
| xs | `px-2 py-0.5 text-2xs rounded-md gap-1` |
| sm | `px-2.5 py-1 text-xs rounded-lg gap-1.5` |
| md | `px-3 py-1.5 text-xs rounded-xl gap-1.5` |

An optional dot is `w-1.5 h-1.5 rounded-full`, with `animate-pulse` only for live states.

Other chips:
- **Compact status chip:** `inline-flex rounded px-1.5 py-0.5 text-2xs font-semibold` + a tone pair.
- **Source badge** (who wrote a record):
  - Staff-authored: `inline-flex items-center gap-1 rounded-md border border-border-soft bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-muted`.
  - User-authored: `… border-accent-sand-fg/30 bg-accent-sand text-accent-sand-fg`.
  - Rule: user-entered data must never look staff-authored.
- **Count / "New" pill:** `rounded-full bg-primary-100 px-1.5 py-0.5 text-2xs font-semibold text-primary-700`.
- **Key hint:** `rounded border border-border-soft bg-surface-2 px-1 font-mono text-2xs`.

### 10.7 Avatar

- **Sizes:** `xs h-6 w-6` · `sm h-8 w-8` · `md h-10 w-10` · `lg h-12 w-12` · `xl h-16 w-16` · `2xl h-20 w-20` · `3xl h-24 w-24`.
- **Image:** `rounded-full object-cover bg-surface-2 ring-1 ring-border-soft`, `loading="lazy"`, `alt=""` when the name is written beside it.
- **Initials fallback:** white bold text on `bg-tile-blue`, `bg-tile-teal` or `bg-tile-violet`, chosen by a hash of the full name. Honorifics (Dr., Prof., Shri…) are skipped. A broken image falls back to initials.
- **Status dot:** `absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-surface-1`.
- **Portraits** are head-and-shoulders crops (not tight on the face), 320×320 WebP, self-hosted. Only a server-validated key such as `doctors/<slug>.webp` becomes a URL.
- **Placement:** portraits sit beside names in lists, cards and pickers, never inside chips.

### 10.8 Overlays

Every overlay (Modal, Drawer, BottomSheet) shares this behaviour:
- portalled to `document.body`;
- focus trap, body scroll lock and focus restore on close;
- Esc closes, and only the top-most overlay closes.

**Modal:**
- Wrapper: `fixed inset-0 z-50 flex items-center justify-center p-4`.
- Backdrop: `absolute inset-0 bg-scrim` + `backdropFilter: blur(4px)`, fading opacity over 0.2s.
- Panel: `focus-ring relative z-10 w-full bg-surface-1 rounded-xl border border-border-soft overflow-hidden shadow-[0_20px_60px_0_rgba(15,23,42,0.18)]`.
  - Motion: `initial={{ opacity: 0, scale: 0.95, y: 16 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={{ duration: 0.25, ease: [0.16,1,0.3,1] }}`.
  - Sizes: `max-w-sm`, `md`, `lg`, `2xl`, `3xl` or `5xl`.
- Header: `flex items-start justify-between px-6 pt-6`. The title uses `text-base font-semibold text-ink leading-snug tracking-tight`; the close button is a `tap-target` X at size 16.
- Body: `px-6 py-6`.
- Footer: `px-6 pb-6 pt-4 mt-2 flex items-center justify-end gap-3 border-t border-border-soft`.
- **Confirm dialog:** a small modal. Body `text-sm leading-relaxed text-ink-muted`; outline Cancel button, then a primary or danger confirm button.

**Drawer (side panel):**
- Wrapper: `fixed inset-0 z-50 flex`.
- Panel: `relative flex h-full w-full max-w-md flex-col border-l border-border-soft bg-surface-1 shadow-card-lg`.
- Motion: x `'100%'` → 0 over 0.2s with the premium easing; the scrim fades over 0.15s.
- Header: `flex flex-shrink-0 items-center justify-between gap-3 border-b border-border-soft px-4 py-3`, title `truncate text-sm font-semibold text-ink`.
- Body: `min-h-0 flex-1 overflow-y-auto p-4`.
- Footer: `border-t px-4 py-3`.

**Bottom sheet (phones):**
- Panel: `absolute inset-x-0 bottom-0 flex max-h-[85vh] flex-col rounded-t-2xl border-t border-border-soft bg-surface-1`.
- Motion: y `'100%'` → 0 over 0.2s with the premium easing.
- Grab handle: `mx-auto mt-2 h-1 w-9 rounded-full bg-border`.
- Body: `min-h-0 flex-1 overflow-y-auto px-4 pb-6`.

**Toasts:**
- Region: `toast-region safe-inset-b pointer-events-none fixed right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2`, with `role="status" aria-live="polite"`. It never takes focus.
- Toast: `pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 shadow-card-lg`.
  - Tones: success `border-success-fg/30 bg-success-bg text-success-fg`, error `border-critical-fg/30 bg-critical-bg text-critical-fg`, info `border-info-fg/30 bg-info-bg text-info-fg`.
  - Motion: y 8→0 over 0.18s with the premium easing.
  - Auto-dismisses after 5s.

**Idle / session warning:**
- Wrapper: `fixed inset-x-0 bottom-0 z-50 px-4 sm:left-auto sm:right-6 sm:bottom-6 sm:px-0`.
- Card: `mx-auto w-full max-w-sm rounded-xl border border-border-soft bg-surface-1 p-4 shadow-lg`, with `role="alertdialog"`.

### 10.9 Data table (sort, keyboard, stacked on phones)

**`md` and up:**
- Wrapper: `hidden overflow-x-auto rounded-xl border border-border-soft bg-surface-1 md:block`.
- Table: `w-full border-collapse text-left`.
- Head: `sticky top-0 z-10 bg-surface-2`. Each `th` is `border-b border-border-soft px-3 py-2 text-xs font-semibold text-ink-muted`.
  - Sort icons: `ChevronUp` / `ChevronDown` / `ChevronsUpDown` at size 13, the last at `opacity-40`. Clicking cycles asc → desc → off.
- Row: `clinical-row focus-ring border-b border-border-soft last:border-0`, with `hover:bg-surface-2`, and `bg-primary-50` when selected.
- Cell: `px-3 py-1.5 text-xs text-ink`. Right-aligned numeric cells get `tabular-nums`.
- Footer: `border-t border-border-soft px-3 py-1.5 text-2xs text-ink-subtle` ("24 rows · sorted by Date").
- Keyboard: ↑ ↓ Home End move between rows, Enter opens, Space previews.

**Below `md`, stacked cards:**
- List: `space-y-2`.
- Card: `focus-ring rounded-xl border border-border-soft bg-surface-1 p-3`, with `ring-1 ring-primary-600` when selected.
- Title: `text-sm font-semibold text-ink`. Subtitle: `mt-0.5 text-xs text-ink-muted`.
- Meta pairs: `dt` in `text-2xs text-ink-subtle`, `dd` in `text-xs text-ink`.

### 10.10 Feedback states

| State | Recipe |
|---|---|
| Spinner | `inline-block animate-spin rounded-full border-[2.5px] border-border-soft border-t-primary-600` (20px) |
| Loading | `flex flex-col items-center justify-center gap-3 px-6 py-12 text-center`, a 26px spinner and the label `text-sm font-medium text-ink-muted` |
| Skeleton | `.skeleton`: a shimmer gradient `surface-2 → surface-3 → surface-2`, `background-size: 200% 100%`, 1.8s loop, radius 0.75rem. Text lines are `h-3.5 rounded` in `space-y-2.5`. **Skeletons mirror the real layout.** |
| Empty | `flex flex-col items-center justify-center px-6 py-14 text-center`. Icon well `mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-surface-2` (22px `text-ink-subtle` icon); title `text-base font-semibold text-ink`; description `mt-1.5 max-w-sm text-sm leading-relaxed text-ink-muted`; action `mt-5`. |
| Error | The same layout, with the well in `bg-critical-bg` and an `AlertTriangle` in `text-critical-fg`. Retry is `focus-ring mt-5 inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-surface-1 px-4 text-sm font-semibold text-ink-muted hover:bg-surface-2`, followed by a reference id `text-xs text-ink-subtle`. |
| Banner | `flex items-start gap-2.5 rounded-lg px-3.5 py-3` + a tone pair, a 16px icon, text `min-w-0 text-sm leading-relaxed`, title `font-semibold`. Error banners use `aria-live="assertive"`, others `polite`. |

---

## 11. Motion & animation

### 11.1 Tokens

```css
--ease-premium: cubic-bezier(0.16, 1, 0.3, 1);   /* everything that moves in/out */
--ease-smooth:  cubic-bezier(0.4, 0, 0.2, 1);    /* colour cross-fades (theme flip) */
@keyframes fadeIn  { from { opacity: 0 } to { opacity: 1 } }
@keyframes slideUp { from { opacity: 0; transform: translateY(16px) } to { opacity: 1; transform: translateY(0) } }
@keyframes scaleIn { from { opacity: 0; transform: scale(0.95) } to { opacity: 1; transform: scale(1) } }
@keyframes shimmer { 0% { background-position: -200% 0 } 100% { background-position: 200% 0 } }
@keyframes dockIn  { from { opacity: 0; transform: translateX(1rem) } to { opacity: 1; transform: none } }
```

In framer-motion, the premium easing is written `ease: [0.16, 1, 0.3, 1]`.

### 11.2 Catalogue

| Element | Motion |
|---|---|
| Button press | `whileTap={{ scale: 0.97 }}` |
| Floating round buttons | `transition-transform hover:scale-105 active:scale-95` |
| Tiles and cards (hover) | `hover:-translate-y-0.5 hover:shadow-card-md`; `.card-hover` lifts 2px over 0.25s premium |
| Icon inside a tile | `group-hover:scale-105` |
| "→" arrow reveal | `opacity-0 -translate-y-0.5 → group-hover:opacity-100 group-hover:translate-y-0`, or `group-hover:translate-x-0.5` |
| Card enter | y 16 → 0 + fade, 0.45s premium, with an optional stagger `delay` |
| Modal | scale 0.95 + y 16 → rest, 0.25s premium; backdrop 0.2s |
| Drawer / nav drawer | x ±100% → 0, 0.2s premium; scrim 0.15s |
| Bottom sheet | y 100% → 0, 0.2s premium |
| Toast | y 8 → 0, 0.18s premium |
| Settings section swap | `AnimatePresence mode="wait"`: y 12 → 0 → −12, 0.3s premium |
| Page-level panel enter | y 14–16 → 0, 0.4–0.5s premium |
| Toggle knob | spring `stiffness: 500, damping: 30` |
| Theme toggle knob | CSS `transition-transform duration-200 ease-out` |
| Theme flip | body background and colour, 0.2s smooth |
| Progress ring | `strokeDashoffset` from full, 1.2s premium, delay 0.2 |
| Entry cards (sign-in doors) | `initial={{ opacity: 0, y: 8 }}`, `duration: 0.25, delay: i * 0.05` |
| Sign-in form fields | y 8 → 0, 0.4s `[0.22, 1, 0.36, 1]`, stagger 0.08–0.1s |
| Success check icon | spring `stiffness: 200, damping: 15, delay: 0.1` |
| Docked chat | `motion-safe:animate-[dockIn_200ms_var(--ease-premium)]`; scrim `motion-safe:animate-[fadeIn_150ms_ease-out]` |
| Insight bubble | `motion-safe:animate-[slideUp_220ms_var(--ease-premium)]` |
| Sign-in background blobs | scale `[1,1.08,1]`, x `[0,10,0]`, y `[0,-6,0]`, 9s / 10s / 7s, `repeat: Infinity, ease: 'easeInOut'`. Off under reduced motion. |

### 11.3 Rules

- There are **no route or page transitions**: pages render immediately.
- UI motion lasts 150–250ms, entrances up to 450ms. Nothing inside the app loops, except loaders and the sign-in background.
- Animate transform and opacity only, never layout properties.
- **Reduced motion:** both `prefers-reduced-motion` and `html[data-reduce-motion='true']` clamp every animation and transition to 0.01ms. framer-motion follows via `MotionConfig reducedMotion="user"`. Use `motion-safe:` for CSS animations.

---

## 12. Icons, logo & SVG assets

### 12.1 Icons (lucide-react)

| Context | Size | Stroke |
|---|---|---|
| Header controls | 19–21 | 2 |
| Nav strip | 17 | 2.2 active / 1.8 inactive, glyph tinted with `TONE_HEX[hue]` |
| Drawer, bottom bar | 19–20 | 2 |
| Inline with text, chips, buttons | 12–16 | 2 |
| Empty-state wells | 22 | 2 |
| Sign-in door cards | 20 | 1.75 |

Decorative icons always get `aria-hidden="true"`. The accessible name comes from the text or the `aria-label` of the control.

**IconTile** (solid, for the nav drawer, settings nav and account menu):
- Classes: `inline-flex flex-shrink-0 items-center justify-center text-white shadow-[inset_0_-1px_0_rgba(0,0,0,0.12)]`, with `style={{ backgroundColor: TONE_HEX[tone] }}` and glyph `strokeWidth={2.2}`.
- Sizes: `sm h-7 w-7 rounded-[8px]` (glyph 15), `md h-9 w-9 rounded-[10px]` (glyph 18), `lg h-12 w-12 rounded-[14px]` (glyph 24).

**SoftIconTile** (quiet, for dashboard headings, "Go to" tiles and inline pills):

```tsx
<span aria-hidden="true" style={{ '--tone': TONE_HEX[tone] } as CSSProperties}
  className={`inline-flex flex-shrink-0 items-center justify-center
    bg-[color-mix(in_oklab,var(--tone)_12%,transparent)] text-[color-mix(in_oklab,var(--tone)_72%,black)]
    dark:bg-[color-mix(in_oklab,var(--tone)_18%,transparent)] dark:text-[var(--tone)] ${box}`}>
  <Icon size={glyph} strokeWidth={2} />
</span>
// sm: h-7 w-7 rounded-[8px] / 15 · md: h-9 w-9 rounded-[10px] / 18 · lg: h-11 w-11 rounded-xl / 20
```

### 12.2 Logo (BrandMark)

- A raster mark: `<img src="/brand/shri-health-mark-64.webp" srcSet="/brand/shri-health-mark-64.webp 64w, /brand/shri-health-mark-128.webp 128w" alt="" className="block select-none object-contain">`.
- The box is `size + 14` px (the header uses `size={16}`, giving a 30px box). An optional `tile` variant sits on `rounded-xl bg-white shadow-sm`.
- It is always paired with the uppercase wordmark (`text-[15px] font-bold tracking-[0.06em]`). Below 640px the mark appears alone.
- Favicon `/brand/favicon-32.png`, touch icon `/brand/apple-touch-icon.png`.
- Swap in your own mark, but keep the sizes and pairing.

### 12.3 Assistant mark (robot with a speech bubble)

- A minimal **one-colour** 32×32 SVG that draws in `currentColor`: white on the blue launcher, blue on white, themed in dark mode.
- The eyes, smile and dots are **cut out with masks**, and a gap separates the bubble from the head, so it stays crisp on any background.
- It comes in two forms that must stay identical: an image file (`public/robot-chat-icon.svg`) and a React component (`AssistantMark`). Mask ids come from `useId()`, so several copies can share a page.
- Full source in **Appendix B**.
- Sizes: 30 on the launcher; 20 in the chat header inside `flex h-8 w-8 items-center justify-center rounded-lg bg-accent-sky text-accent-sky-fg`; 18 beside AI replies.

### 12.4 Other marks

- **AI glyph:** `◆` in `inline-block text-[12px] leading-none text-ai`. It sits before AI-written blocks, with an "AI" badge.
- **Dot-grid background** (sign-in): a 24×24 SVG pattern, `<circle cx="1.5" cy="1.5" r="1.2" fill="currentColor" fillOpacity="0.35" />`, inside a wrapper coloured `text-border-strong`.

```tsx
<svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full text-border-strong">
  <defs><pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse">
    <circle cx="1.5" cy="1.5" r="1.2" fill="currentColor" fillOpacity="0.35" /></pattern></defs>
  <rect width="100%" height="100%" fill="url(#dots)" />
</svg>
```

---

## 13. AI assistant surfaces (docked chat & insight bubbles)

Reuse this pattern for any side assistant or helper panel.

### 13.1 Launcher

```tsx
<button aria-label="Open AI chat" aria-expanded={open}
  className={`focus-ring fixed bottom-24 right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full border border-border bg-surface-1 text-primary-700 shadow-card-lg transition-transform hover:scale-105 active:scale-95 md:bottom-6 md:right-6 md:border-transparent md:bg-primary-600 md:text-on-primary ${open ? 'invisible' : ''}`}>
  <AssistantMark size={30} />
</button>
```

On phones it is white, sitting above the bottom bar (`bottom-24`) so it doesn't compete with the bar's FAB. From 768px it is solid blue in the corner. It stays mounted while the panel is open, so focus can return to it.

### 13.2 The docked, full-height panel

**Placement by width:**
- **≥ 1024px:** the panel is `<aside>`, a full-height column on the right **below the header**, and the page narrows beside it. Nothing sits underneath the panel.
- **640–1023px:** a 420px sheet over a dimmed page.
- **< 640px:** full width under the header, with the bottom bar hidden.

**Header height.** The shell measures its header and writes it to a CSS variable:

```ts
new ResizeObserver(() => root.style.setProperty('--app-header-h', `${header.getBoundingClientRect().height}px`)).observe(header)
```

**CSS** (from Appendix A):

```css
:root { --chat-dock-w: clamp(20rem, 30vw, 25rem); --app-header-h: 4.0625rem; }
@media (width >= 64rem) {
  :root[data-chat-docked='true'] #main-content { padding-right: var(--chat-dock-w); }
  :root[data-chat-docked='true'] .app-content  { container: main / inline-size; }
  :root[data-chat-docked='true'] .toast-region,
  :root[data-chat-docked='true'] .idle-warning { right: calc(var(--chat-dock-w) + 1rem); }
}
:root[data-chat-open='true'] .patient-bottom-nav { display: none; }
```

**Panel classes:**
- Shared: `fixed bottom-0 right-0 top-[var(--app-header-h)] z-20 flex flex-col bg-surface-1`.
- Docked: `+ w-[var(--chat-dock-w)] border-l border-border-soft motion-safe:animate-[dockIn_200ms_var(--ease-premium)]`.
- Covering: `+ w-full sm:w-[26.25rem] sm:border-l sm:border-border-soft sm:shadow-card-lg`, with a `bg-scrim` button behind it at `sm+`.
- Why z-20: the header's own menus (z-30) open over the panel, and modals (z-50) sit above both.

**Attributes on `<html>`:** `data-chat-docked="true"` while docked and `data-chat-open="true"` while open. Both are removed on close and on unmount.

**Behaviour:**
- Esc closes the panel only when focus is inside it.
- When docked, links inside the panel change the page beside it and the panel stays open. When covering, links close it.

**Anatomy:**
- Header strip `px-4 py-3 border-b`, holding the mark tile, a title and the sub-line "From your record · not a doctor".
- Transcript: `role="log" aria-live="polite"`.
- Starter suggestions: `min-h-11 rounded-lg border border-border-soft bg-surface-2 px-3 py-2 text-left text-sm`.
- Composer: `rounded-xl border bg-surface-2 p-1.5`, containing an auto-growing textarea (max 128px) and a 44px send button `bg-primary-600`.
- Disclaimer: `text-2xs text-ink-subtle`.

### 13.3 Insight bubble (notification-style tip by the launcher)

- **Position:** `fixed bottom-[10.25rem] right-4 z-30 w-[min(20rem,calc(100vw-2rem))] md:bottom-[5.75rem] md:right-6`, with `slideUp 220ms`.
- **Bubble:** `relative rounded-2xl border border-accent-sky-fg/20 bg-accent-sky shadow-card-lg`.
- **Tail:** a `h-3.5 w-3.5 rotate-45` square with the same background and border, at `-bottom-[7px] right-[1.3rem]`.
- **Content:** a white mark tile, the label "FROM YOUR RECORD" (`text-2xs font-semibold uppercase tracking-wide text-accent-sky-fg`), the text in `text-sm leading-snug text-ink`, and "Ask about this →" in `text-xs font-semibold text-accent-sky-fg`.
- **Close:** a 44px ✕.
- **Pacing:**
  - The first bubble appears after about 4s.
  - A bubble never auto-hides; the next one replaces it after about 45s, unless it's being hovered or focused.
  - At most 5 per session. ✕ stops them for the session.
  - Hidden while the panel is open, while a dialog is up, and on critical pages.
- **Screen readers:** a polite live region.
- **Content:** template-written from real data, never model-written.

---

## 14. Sign-in screens

- **Shell:** `relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-bg p-3 sm:p-4 lg:p-6`.
  - Layers: the dot grid (§12.4), three blurred blobs, and the theme toggle at `absolute right-3 top-3 z-20 sm:right-5 sm:top-5`.
  - Blobs: `pointer-events-none absolute rounded-full blur-3xl`, each a radial gradient of accent tokens:
    - sky → primary-50, `w-64 h-64 sm:w-80 sm:h-80 lg:w-[420px] lg:h-[420px] -top-20 -left-20 opacity-50`;
    - teal → sage, `w-52 h-52 … lg:w-[340px] lg:h-[340px] -bottom-14 -right-14 opacity-50`;
    - clay → sand, `w-36 h-36 … lg:w-64 lg:h-64 top-1/2 -right-8 opacity-40`.
- **Entry ("which door?") page:**
  - Column: `mx-auto flex min-h-dvh w-full max-w-4xl flex-col justify-center px-4 py-10 sm:px-6`.
  - Brand row, then H1 `text-2xl font-semibold tracking-tight text-ink sm:text-3xl`, then lede `mt-2 max-w-xl text-sm leading-relaxed text-ink-muted sm:text-base`.
  - Card grid: `mt-8 grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4`.
  - Door card: `focus-ring group flex w-full items-start gap-4 rounded-xl border border-border-soft bg-surface-1 p-5 shadow-card transition-colors hover:border-primary-600/50 md:flex-col md:gap-5 md:p-6`.
    - Icon well: `flex h-10 w-10 items-center justify-center rounded-lg bg-primary-600/10 text-primary-700`.
    - Title `text-base font-semibold text-ink`, blurb `mt-1 text-sm leading-relaxed text-ink-muted`.
    - CTA: `mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-primary-700 md:mt-auto md:pt-5` ("Sign in →").
- **Form page:**
  - Column: `max-w-md px-5 py-10`. The form sits on the ground directly, with no card.
  - A back link: `-mt-3 mb-2 inline-flex min-h-11 items-center gap-1.5 text-sm text-ink-muted hover:text-ink`.
  - H1 `text-2xl font-semibold tracking-tight`, description `mb-6 mt-1 text-sm text-ink-muted`.
  - Full-width submit button (§10.1).
  - Info note: `mt-6 flex items-start gap-2.5 rounded-lg border border-border-soft bg-surface-2 px-3.5 py-3 text-xs leading-relaxed text-ink-muted`.

---

## 15. Accessibility & print

- **Focus ring:** `.focus-ring:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; box-shadow: 0 0 0 3px color-mix(in oklab, var(--color-focus) 22%, transparent); }`. The outline survives Windows High Contrast. Every interactive element also gets the global `:focus-visible` outline.
- **Targets:**
  - `.tap-target` sets min 44×44 and centres the content.
  - `.tap-reach` adds an invisible 44px `::after` hit area around a visually small control. On grids, size it to the cell pitch.
- **Skip link:** `.skip-link` sits off-screen at `top: -3rem` and slides to `0.5rem` on focus, in primary-600 with white text.
- **Landmarks:** `header`, `nav[aria-label]`, `main`, `aside` for side panels. Sections use `aria-labelledby` pointing at their `h2`.
- **Live regions:** toasts and bubbles are `polite`, error banners `assertive`, chart readings `polite`. Nothing steals focus.
- **Keyboard:**
  - radio groups and tabs use roving `tabIndex` with arrow keys;
  - dialogs trap focus and restore it on close;
  - Esc closes the top-most layer only;
  - tables support ↑ ↓ and Enter.
- **Screen-reader-only text:** `.sr-only`, e.g. "(current page)" on the active nav item.
- **Print:**
  - `@page { margin: 14mm }`, a white page, and `header`, `nav`, `aside` and `[data-print='hide']` are hidden.
  - A page that should print cleanly marks its sheet `data-print-root`, and only that sheet prints.
  - `[data-print-block]` avoids page breaks inside it.
  - Floating UI (launcher, chat, bubbles) carries `data-print="hide"`.

---

## 16. New-screen checklist

1. Put the page inside the shell container. Don't add extra max-width.
2. Page title recipe (§3.4) plus a one-line description of what the page contains.
3. Build with tokens only: no raw hex, no `text-[13px]`, no `bg-white` (use `bg-surface-1`).
4. Cards: `rounded-xl border bg-surface-1 shadow-card p-4 sm:p-5`. Headings go in the 44px `SectionHeading` row.
5. Give colour through the destination hue, as soft tints. Solid tiles only for KPIs.
6. Every control at least 44px; one primary button; destructive actions confirmed.
7. Design the loading (a skeleton that mirrors the layout), empty, error (retry plus ref id) and success states.
8. Make it responsive: 1 → 2 → 4 → 6 columns, tables → cards below md, no sideways scroll at 320px. Use `main-*` variants if you have a docked side panel.
9. Dark mode: check it. It should work for free if you used tokens.
10. Large text and high contrast: check nothing clips.
11. Keyboard walk-through: visible focus, a logical tab order (= source order), Esc behaviour.
12. Motion: only from the catalogue (§11), and `motion-safe:` for CSS keyframes.

---

## 17. Known gaps to fix when you reuse this

- `shadow-card-sm` is referenced by a few components but never defined, so it renders without a shadow. Either define `--shadow-card-sm` or use `shadow-card`. (§10.4 uses `shadow-card`.)
- The `<Card variant="glass">` background is a hard-coded `rgba(255,255,255,0.72)`, which is not dark-aware. Use `.glass` instead.
- The `success` Button's hover colour equals its resting colour. Add a darker hover if you use it.
- The `scaleIn` and `pulseSoft` keyframes are defined but unused.
- Rename the theme storage key (`strokeai-theme`) and the `.patient-bottom-nav` hook class for your product.
- Portraits in our demo are AI-generated people. Real products must use real photos taken with consent.

---

## Appendix A: the complete stylesheet (`index.css`)

This is the whole global stylesheet, verbatim. The healthcare-specific comments are kept for context. Paste it as your `src/index.css`, then rename product-specific hooks (§17).

```css
/* ─────────────────────────────────────────────────────────────────────
   One typeface — Plus Jakarta Sans, self-hosted as a variable font.

   Variable 200–800, so every weight the UI asks for is the real cut, not a
   browser-synthesised one (the old CDN link shipped only 300–500, so every
   semibold heading rendered as medium). Self-hosted: no third-party request
   on a health portal, and the CSP stays 'self'.

   The four Noto Sans families are unicode-range fallbacks for the app's
   Indian-language text: each downloads only when a page actually contains
   that script, and they share Jakarta's proportions closely enough that a
   mixed-language line reads as one voice.
──────────────────────────────────────────────────────────────────── */
@import '@fontsource-variable/plus-jakarta-sans';
@import '@fontsource-variable/noto-sans-kannada';
@import '@fontsource-variable/noto-sans-devanagari';
@import '@fontsource-variable/noto-sans-tamil';
@import '@fontsource-variable/noto-sans-malayalam';

@import "tailwindcss";

@theme static {
  /* ═══════════════════════════════════════════════════════════════════════
     STROKE AI — DESIGN TOKENS (single source of truth)

     `static` (not plain `@theme`): Tailwind 4 tree-shakes theme variables no
     generated utility references, which would silently drop the accent and
     on-* tokens that are read from JS and from `color-mix()` below. `static`
     emits all of them.

     NEVER `@theme inline` — that substitutes literal values into utilities and
     would defeat the `.dark` redefinition this whole file depends on.

     Light is the source of truth here; `:root.dark` further down redefines the
     same names. Because non-inline `@theme` emits `var()` references, every
     `bg-surface-1` / `text-ink` / `border-border` in the app flips with it,
     with no `dark:` variant at the call site.
  ═══════════════════════════════════════════════════════════════════════ */

  /* ── Type family ───────────────────────────────────────────────────────
     One. Plus Jakarta Sans carries the entire application; the Noto
     families only ever render characters Jakarta does not have. */
  --font-sans:   'Plus Jakarta Sans Variable', 'Noto Sans Kannada Variable',
                 'Noto Sans Devanagari Variable', 'Noto Sans Tamil Variable',
                 'Noto Sans Malayalam Variable', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-display: var(--font-sans);


  /* ── Grounds & surfaces ────────────────────────────────────────────────
     `bg` is the page ground; `surface-1` is the card sitting on it. They are
     deliberately distinct (1.18:1) so a container reads as a container, and
     every card also carries a `border` — a tint delta alone is not a crisp
     edge, which is what the brief asked for.

       surface-1  card / panel / input
       surface-2  a fill INSIDE a card (chip, row, input rest)
       surface-3  sunken — track, hover well
  */
  --color-bg:        #E8EDF4;
  --color-surface-1: #FFFFFF;
  --color-surface-2: #F4F7FA;
  --color-surface-3: #E4EAF2;

  /* Modal / drawer scrim. A token, because an ink-tinted scrim is nearly
     invisible over a dark ground and needs its own dark value. */
  --color-scrim: rgba(15, 23, 42, 0.45);

  /* ── Ink scale ─────────────────────────────────────────────────────────
     Measured on the card (#FFFFFF) and on the ground (#E8EDF4):
       ink        17.85 / 15.18  AAA
       ink-muted   8.46 /  7.19  AAA   ← body copy
       ink-subtle  5.77 /  4.91  AA    ← metadata, never below 14px

     ink-muted and ink-subtle were DARKENED from #475569 / #64748B. The old
     ink-subtle measures 4.20:1 on this tinted ground — it fails AA the moment
     the ground stops being near-white, so keeping it would have shipped a
     real regression across ~60 call sites. */
  --color-ink:         #0F172A;
  --color-ink-muted:   #3F4E63;
  --color-ink-subtle:  #57677C;
  --color-ink-inverse: #FFFFFF;

  /* Non-text only. Never apply to text.
       border-soft    a rule INSIDE a card
       border         the card's own edge (1.60:1 on the card)
       border-strong  an interactive edge — 3.47:1, clears WCAG 1.4.11 */
  --color-border-soft:   #D9E1EA;
  --color-border:        #C2CEDB;
  --color-border-strong: #7C8BA0;

  /* ── Primary (actions, links, navigation) ─────────────────────────────── */
  --color-primary-50:  #EFF6FF;
  --color-primary-100: #DBEAFE;
  --color-primary-200: #BFDBFE;
  --color-primary-300: #93C5FD;
  --color-primary-400: #60A5FA;
  --color-primary-500: #3B82F6;
  --color-primary-600: #2563EB;  /* the action colour */
  --color-primary-700: #1D4ED8;
  --color-primary-800: #1E40AF;
  --color-primary-900: #1E3A8A;

  /* Text/icon colour ON a filled action. Distinct from surface white so it
     does NOT flip in dark mode — a filled blue button keeps light text. */
  --color-on-primary: #FFFFFF;
  --color-on-danger:  #FFFFFF;

  /* The focus indicator. Its own token because primary-600 is a fill colour:
     in dark it sits at #2F5FBF, too dark to read as a ring against the
     ground. Dark redefines this to the light primary-500 instead. */
  --color-focus: #2563EB;

  /* ── Semantic status ───────────────────────────────────────────────────
     Muted on purpose. Each `-fg` clears 4.5:1 on its own `-bg`.

     `danger` is RESERVED FOR EMERGENCY. Ordinary validation errors use
     `critical`, which reads as serious without competing with the emergency
     affordance on a product whose premise is that a stroke is time-critical. */
  --color-success-bg: #E6F0EE;
  --color-success-fg: #2F6B5E;
  --color-warning-bg: #FBF0E2;
  --color-warning-fg: #8A5A1B;
  --color-critical-bg: #FBEAE7;
  --color-critical-fg: #A33A28;
  --color-info-bg:    #E8EFF6;
  --color-info-fg:    #33608A;
  --color-therapy-bg: #EDEAF4;
  --color-therapy-fg: #574B7D;

  /* ── Clinic analytics accent ───────────────────────────────────────────
     SCOPED TO ONE REGION: the calendar and week chart in `Z6` on My Day.
     Nothing else may use it. The portal theme is `primary-*` blue and this
     does not change it.

     ⚠️ It is a SEPARATE family from `success` deliberately. `success-fg` is
     the desaturated sea-green that means "this went well" on banners and
     chips across the whole product; brightening that token to suit one chart
     would repaint every success state in the app.

     ⚠️ TWO STRENGTHS, AND THE DIFFERENCE MATTERS. `-accent` is 3.3:1 on
     white — ample for a bar or a dot, which are large shapes carrying no
     text, and below AA for anything with letters in it. Text uses
     `-accent-strong` (5.0:1 on white, 4.6:1 on `-accent-soft`). Do not use
     `-accent` for text. */
  --color-clinic-accent:        #16A34A;
  --color-clinic-accent-strong: #15803D;
  --color-clinic-accent-soft:   #DCFCE7;

  /* ── AI ────────────────────────────────────────────────────────────────
     §5.3's separation rule: brand, clinical semantics and AI are three
     independent palettes that never borrow from each other. A blue that
     means "brand" in Z1 and "normal result" in Z5 is an error waiting to
     happen — and an AI suggestion tinted with the primary blue would read as
     a product affordance rather than a model output.

     ⚠️ Indigo is reserved for AI and for nothing else, including the `◆`
     glyph (§5.5, 12px). Contrast of #4F46E5 on white is 7.0:1 — AA for text
     as well as for marks, so unlike `clinic-accent` this needs no second
     strength. */
  --color-ai:      #4F46E5;
  --color-ai-soft: #EEF0FD;

  /* Emergency only. Not a status colour. */
  --color-danger:    #DC2626;
  --color-danger-fg: #B91C1C;

  /* ── Pastel accents ────────────────────────────────────────────────────
     For category colour-coding (a tile, a chip, an icon well) — never for
     state, which `success`/`warning`/`critical`/`info` already own. Derived
     from the landing page's TINT set so the two surfaces share a family.
     Every `-fg` clears 4.9:1 on its own `-bg` in light, 7.4:1 in dark. */
  --color-accent-sky:     #E8EFF6;
  --color-accent-sky-fg:  #3A6288;
  --color-accent-teal:    #E6F0EE;
  --color-accent-teal-fg: #3C6B63;
  --color-accent-sand:    #F4EDE0;
  --color-accent-sand-fg: #7E6128;
  --color-accent-clay:    #F6E9E4;
  --color-accent-clay-fg: #8B5544;
  --color-accent-sage:    #E9F0E6;
  --color-accent-sage-fg: #4C6B46;

  /* ── Solid tiles ───────────────────────────────────────────────────────
     Muted-solid fills paired with a FIXED white foreground — deliberately
     theme-invariant, same precedent as `on-primary`/`on-danger` above, so
     these never get a `.dark` redefinition. Reserved for the handful of
     dashboard containers meant to read as bold and distinct at a glance
     (the health-snapshot stat tiles, the recent-activity panel) rather than
     the app's usual quiet pastel `accent-*` family. Deliberately desaturated
     from a first pass that read as too bright/neon — each hue is blended
     toward neutral so it stays calm rather than loud. Each `-fg` is plain
     white and clears WCAG AA (>=4.5:1, computed) against its own `-bg`. */
  --color-tile-blue:      #2F5AA8;  --color-tile-blue-fg:   #FFFFFF; /* appointments / logistics — 6.7:1 */
  --color-tile-teal:      #22685F;  --color-tile-teal-fg:   #FFFFFF; /* medicines — 6.5:1 */
  --color-tile-violet:    #6A4E9E;  --color-tile-violet-fg: #FFFFFF; /* care team / people — 6.6:1 */
  --color-tile-amber:     #8F5F32;  --color-tile-amber-fg:  #FFFFFF; /* allergy / attention — 5.5:1 */

  /* ── Chart lines ───────────────────────────────────────────────────────
     Two series at most (blood pressure's two numbers). Validated as a pair
     with the dataviz palette checker — colour-blind separation, chroma,
     lightness band and ≥3:1 against the surface — in BOTH themes; the dark
     steps are their own values, not an automatic flip. Identity never rests
     on colour alone: every chart also has a legend, end labels and a table. */
  --color-chart-1: #2563EB;
  --color-chart-2: #EB6834;

  /* ── Type scale ────────────────────────────────────────────────────────
     One step larger than a typical consumer app. The stroke population
     includes visual-field loss and post-stroke fatigue; 12px secondary text
     is not a neutral choice here. 14px is the floor for anything a patient
     must read. */
  --text-2xs:   0.75rem;   /* 12px — non-essential glyph labels ONLY */
  --text-xs:    0.8125rem; /* 13px — dense metadata */
  --text-sm:    0.875rem;  /* 14px — secondary text floor */
  --text-base:  1rem;      /* 16px — body */
  --text-lg:    1.125rem;  /* 18px */
  --text-xl:    1.25rem;   /* 20px — card headings */
  --text-2xl:   1.5rem;    /* 24px — section headings */
  --text-3xl:   1.875rem;  /* 30px — page titles */
  --text-4xl:   2.25rem;   /* 36px */

  /* ── Radius ──────────────────────────────────────────────────────────── */
  --radius-sm:   0.25rem;
  --radius-md:   0.5rem;
  --radius-lg:   0.75rem;
  --radius-xl:   1rem;
  --radius-2xl:  1.25rem;
  --radius-3xl:  1.5rem;

  /* ── Elevation — three tiers, deliberately shallow ────────────────────── */
  --shadow-card:    0 1px 2px 0 rgba(15,23,42,0.04), 0 1px 3px 0 rgba(15,23,42,0.06);
  --shadow-card-md: 0 2px 8px 0 rgba(15,23,42,0.06), 0 1px 3px 0 rgba(15,23,42,0.04);
  --shadow-card-lg: 0 4px 16px 0 rgba(15,23,42,0.08), 0 2px 6px 0 rgba(15,23,42,0.04);
  --shadow-glow:    0 0 0 3px rgba(37,99,235,0.12);

  /* ── Touch target floor ────────────────────────────────────────────────
     44px per WCAG 2.2 AA (2.5.8). Applied via .tap-target. */
  --tap-min: 2.75rem;

  /* ── Clinical density (UI_ATLAS §3.3) ───────────────────────────────────
     Three densities are specified; two are used here. Compact (32px rows,
     13px type) is the CLINICIAN default — a consultant scanning a 20-patient
     clinic needs rows on screen, not air. Comfortable (40px, 14px) stays the
     default everywhere else and is what the patient portal uses.

     ⚠️ These are ROW heights, not tap-target heights. A 32px row may contain
     a 44px-tall control; the row is the rhythm, --tap-min is the floor for
     anything a gloved hand at a ward tablet has to hit (§3.3, WCAG 2.5.8).
     Density must never be allowed to shrink a touch target. */
  --row-h-compact: 2rem;
  --row-h-comfortable: 2.5rem;

  /* ── Motion ────────────────────────────────────────────────────────────── */
  --ease-premium: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-smooth:  cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes fadeIn    { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp   { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
@keyframes scaleIn   { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
@keyframes shimmer   { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
@keyframes pulseSoft { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

@variant dark (&:where(.dark, .dark *));

/* ═════════════════════════════════════════════════════════════════════════
   THEME OVERRIDES — deliberately UNLAYERED.

   `@theme` emits into `@layer theme`, and `@variant dark` resolves through
   `:where()`, which contributes zero specificity. An unlayered rule beats
   every layer unconditionally, so this is the one placement that cannot be
   accidentally out-specified later.

   Order matters: high-contrast comes AFTER dark, or dark wins the tie.
═════════════════════════════════════════════════════════════════════════ */

:root { color-scheme: light; }

:root.dark {
  color-scheme: dark;

  /* Ground is #14181F, never #000 — pure black raises halation for readers
     with astigmatism and removes any room for a sunken surface below it. */
  --color-bg:        #14181F;
  --color-surface-1: #1D232D;
  --color-surface-2: #262E39;
  --color-surface-3: #303945;

  /* An ink-tinted scrim vanishes over a dark ground; this one is near-black. */
  --color-scrim: rgba(0, 0, 0, 0.66);

  /* Measured on the card (#1D232D) / on the ground (#14181F):
       ink        13.30 / 14.99  AAA
       ink-muted   8.39 /  9.46  AAA
       ink-subtle  5.58 /  6.29  AA
     ink is #E7ECF3, not #FFF: full-white body text on a dark ground is the
     other half of the halation problem. */
  --color-ink:         #E7ECF3;
  --color-ink-muted:   #B3BECD;
  --color-ink-subtle:  #8D9BAD;
  --color-ink-inverse: #14181F;

  --color-border-soft:   #2B333E;
  --color-border:        #3A4450;  /* 1.60:1 on the card — same crispness as light */
  --color-border-strong: #6E7A8C;  /* 3.63:1 — clears WCAG 1.4.11 */

  /* The ramp inverts: a "50" tint is a deep wash in dark, and hover goes
     lighter rather than darker. */
  --color-primary-50:  #1E2A3D;
  --color-primary-100: #24344B;
  --color-primary-500: #7FA9F0;  /* primary-as-text, and the focus ring */
  --color-primary-600: #2F5FBF;  /* fill */
  --color-primary-700: #3A6ACC;  /* hover — lighter, not darker */
  --color-on-primary:  #F2F6FF;
  --color-focus:       #7FA9F0;

  --color-danger:    #C0322D;
  --color-danger-fg: #FF9A8F;
  --color-on-danger: #FFFFFF;

  --color-success-bg: #1A2B29;  --color-success-fg: #93C6BC;
  --color-warning-bg: #2A2519;  --color-warning-fg: #D7BE86;
  --color-critical-bg:#33201C;  --color-critical-fg:#F0A99A;
  --color-info-bg:    #1E2A38;  --color-info-fg:    #9CC0E8;
  --color-therapy-bg: #262238;  --color-therapy-fg: #BCB0E0;

  /* Scoped clinic analytics accent — see the light-mode block. */
  --color-clinic-accent:        #3FB973;
  --color-clinic-accent-strong: #7FD9A4;
  --color-clinic-accent-soft:   #17301F;

  /* AI — the third palette. See the light-mode block. */
  --color-ai:      #A5A0F5;
  --color-ai-soft: #22203A;

  --color-accent-sky:     #1E2A38;  --color-accent-sky-fg:  #9CC0E8;
  --color-accent-teal:    #1A2B29;  --color-accent-teal-fg: #93C6BC;
  --color-accent-sand:    #2A2519;  --color-accent-sand-fg: #D7BE86;
  --color-accent-clay:    #2E211C;  --color-accent-clay-fg: #DBA895;
  --color-accent-sage:    #1F2A1D;  --color-accent-sage-fg: #A9C79F;

  --color-chart-1: #5B8FE8;
  --color-chart-2: #D95926;

  /* Non-optional. The light shadows are rgba(15,23,42,0.04) — over #1D232D
     that is literally invisible, which would leave cards with no separation
     from the ground beyond the 1.13:1 tint. */
  --shadow-card:    0 1px 2px 0 rgba(0,0,0,0.40), 0 1px 3px 0 rgba(0,0,0,0.30);
  --shadow-card-md: 0 2px 8px 0 rgba(0,0,0,0.45), 0 1px 3px 0 rgba(0,0,0,0.30);
  --shadow-card-lg: 0 4px 16px 0 rgba(0,0,0,0.50), 0 2px 6px 0 rgba(0,0,0,0.35);
  --shadow-glow:    0 0 0 3px rgba(127,169,240,0.22);
}

/* ── High contrast ──────────────────────────────────────────────────────
   Driven by the account preference AccessibilityContext writes onto <html>.

   This used to target the literal escaped utility selectors the app happened
   to be written with (`.text-\[\#475569\]` and five siblings). Those classes
   no longer exist now that the app uses tokens, so the old block would have
   kept parsing and silently done nothing. Overriding the tokens instead is
   both durable and strictly wider: it reaches inline styles and `color-mix`
   surfaces too, and needs no `!important`. */
html[data-high-contrast='true'] {
  --color-ink:           #000000;
  --color-ink-muted:     #1E293B;
  --color-ink-subtle:    #1E293B;
  --color-border-soft:   #475569;
  --color-border:        #475569;
  --color-border-strong: #334155;
}

html[data-high-contrast='true']:root.dark {
  --color-ink:           #FFFFFF;
  --color-ink-muted:     #E2E8F0;
  --color-ink-subtle:    #CBD5E1;
  --color-border-soft:   #8D9BAD;
  --color-border:        #8D9BAD;
  --color-border-strong: #B3BECD;
}

@layer base {




  html {
    min-width: 320px;
    scroll-behavior: smooth;
  }

  body {
    min-width: 320px;
    /* ⚠️ `100dvh`, with `100vh` first as the fallback for engines that lack it.
       On mobile `100vh` is the LARGE viewport — it includes the space the URL
       bar occupies — so a page sized to it is always slightly taller than what
       is actually visible, and the bottom of every screen sits under browser
       chrome until the user scrolls. `dvh` tracks the viewport as it changes. */
    min-height: 100vh;
    min-height: 100dvh;
    /* `clip`, not `hidden`: `hidden` makes body a scroll container in some
       engines, which breaks `position: sticky` descendants (the pinned hero). */
    overflow-x: clip;
    background: var(--color-bg);
    color: var(--color-ink);
    /* Softens the theme flip. The reduce-motion blocks below already clamp
       every transition to 0.01ms, so this is opt-out by default for anyone
       who asked for less motion. */
    transition: background-color 0.2s var(--ease-smooth), color 0.2s var(--ease-smooth);
    /* Plus Jakarta Sans throughout. Weight 400, not 300: hairline weights
       on clinical text are a legibility cost with no compensating benefit. */
    font-family: var(--font-sans);
    font-weight: 400;
    letter-spacing: 0.01em;
    /* Prevent browser from synthesising heavier strokes */
    font-synthesis: none;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-rendering: optimizeLegibility;
  }

  /* Global headings → Plus Jakarta Sans (matches reference) */
  h1, h2, h3, h4, h5, h6 {
    font-family: var(--font-sans);
    font-weight: 600;
    font-synthesis: none;
    letter-spacing: -0.02em;
    line-height: 1.05;
  }


  button, a {
    -webkit-tap-highlight-color: transparent;
  }

  @media (max-width: 767px) {
    input, select, textarea {
      /* 16px minimum stops iOS Safari zooming the viewport on focus. */
      font-size: max(16px, 1em);
    }

    /* A finger needs ~44px. Padding alone did not deliver it: a measured
       sweep at 320px and 390px found selects and text inputs rendering at
       42px across My Health, Settings, Appointments and the auth forms.
       Setting it here fixes all of them at once rather than touching 23
       call sites, and `min-height` cannot shrink a control that is already
       taller. Checkboxes and radios are excluded — they are sized
       deliberately, and the visible label is their real touch target. */
    input:not([type='checkbox']):not([type='radio']),
    select,
    textarea {
      min-height: 44px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      scroll-behavior: auto !important;
      transition-duration: 0.01ms !important;
    }
  }

  /* ── Accessibility preferences ──────────────────────────────────────────
     Driven by data-* attributes that AccessibilityContext sets on <html>
     from the patient's saved settings. Until Phase 5 these three switches
     saved correctly and changed nothing on screen; these rules are what
     make them true.

     Note the OS-level `prefers-reduced-motion` block above still applies
     independently — an explicit account setting adds to the system
     preference, it does not replace or override it.
  ─────────────────────────────────────────────────────────────────────── */

  /* Large text: scales the type ramp itself rather than zooming the page,
     so line-height, spacing and layout stay in proportion. The 2xs step is
     lifted disproportionately — at 12px it is the hardest size to read, and
     someone who asked for larger text should not be left with it. */
  html[data-large-text='true'] {
    --text-2xs:  0.875rem;  /* 12 → 14 */
    --text-xs:   0.9375rem; /* 13 → 15 */
    --text-sm:   1rem;      /* 14 → 16 */
    --text-base: 1.125rem;  /* 16 → 18 */
    --text-lg:   1.25rem;   /* 18 → 20 */
    --text-xl:   1.375rem;  /* 20 → 22 */
    --text-2xl:  1.625rem;  /* 24 → 26 */
    --text-3xl:  2rem;      /* 30 → 32 */
    --text-4xl:  2.375rem;  /* 36 → 38 */

    /* ⚠️ Rows scale with the type ramp. Leaving these fixed would clip
       15px text inside a 32px row the moment a clinician turns large text
       on — the accessibility setting has to win over the density setting,
       always. This is also why nothing may hard-code `text-[13px]`. */
    --row-h-compact: 2.375rem;
    --row-h-comfortable: 2.875rem;
  }

  /* High contrast now works by overriding the colour tokens themselves —
     see the unlayered block above. All that is left here is the form-control
     edge, which is not otherwise token-driven. */
  html[data-high-contrast='true'] :is(input, select, textarea) {
    border-color: var(--color-border-strong);
  }

  /* Reduce motion: same treatment as the OS preference, applied to anyone
     who asked for it in Settings regardless of their device setting. */
  html[data-reduce-motion='true'] *,
  html[data-reduce-motion='true'] *::before,
  html[data-reduce-motion='true'] *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
  }

  html[data-reduce-motion='true'] {
    scroll-behavior: auto;
  }
}

@layer components {
  /* Was written against the built-in palette (`border-slate-200 bg-white/80
     text-slate-900 focus:ring-blue-100`), which is invisible to any grep over
     the JSX and would never have themed. */
  .auth-input {
    @apply w-full rounded-xl border border-border bg-surface-1/80 py-3 pl-10 pr-3 text-sm text-ink outline-none transition placeholder:text-ink-subtle focus:border-primary-500 focus:bg-surface-1 focus:ring-4;
    --tw-ring-color: color-mix(in oklab, var(--color-focus) 22%, transparent);
  }

  /* ── Material hierarchy: Level 3 (selective glass/elevated surfaces) ──
     Used deliberately, not as a default container — see Card's `glass` variant. */
  .glass {
    background: color-mix(in oklab, var(--color-surface-1) 72%, transparent);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid color-mix(in oklab, var(--color-border-soft) 80%, transparent);
  }

  .page-card {
    background: color-mix(in oklab, var(--color-surface-1) 88%, transparent);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    border: 1px solid color-mix(in oklab, var(--color-border) 75%, transparent);
    box-shadow: var(--shadow-card-lg);
  }

  .card-hover {
    transition: transform 0.25s var(--ease-premium), box-shadow 0.25s var(--ease-premium);
    will-change: transform;
  }
  .card-hover:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow-card-lg);
  }

  .skeleton {
    background: linear-gradient(
      90deg,
      var(--color-surface-2) 25%,
      var(--color-surface-3) 50%,
      var(--color-surface-2) 75%
    );
    background-size: 200% 100%;
    animation: shimmer 1.8s ease-in-out infinite;
    border-radius: 0.75rem;
  }

  /* ── Focus ─────────────────────────────────────────────────────────────
     A visible ring PLUS a real outline. The outline is what survives Windows
     High Contrast Mode, where box-shadow is discarded entirely — a
     box-shadow-only focus style leaves those users with no focus indicator
     at all. */
  .focus-ring:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 2px;
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--color-focus) 22%, transparent);
  }

  /* Global baseline: anything interactive gets a visible focus state even if
     the author forgot. :focus-visible means pointer users never see it. */
  a:focus-visible,
  button:focus-visible,
  input:focus-visible,
  select:focus-visible,
  textarea:focus-visible,
  [tabindex]:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 2px;
  }

  /* ── Touch target floor (WCAG 2.2 AA 2.5.8) ────────────────────────────
     Phase 1 found controls as small as 22×22 — including the location editor
     inside the emergency flow. Padding is deliberately NOT added: that would
     shift layouts. The element grows to 44px around its existing content. */
  /* ── Clinical density scope ─────────────────────────────────────────────
     Applied by the clinician shell only, so the patient portal keeps its
     comfortable defaults and its 14px floor. `--row-h` is what dense
     components read; it resolves differently inside the scope. */
  [data-density='compact'] {
    --row-h: var(--row-h-compact);
  }

  [data-density='comfortable'],
  :root {
    --row-h: var(--row-h-comfortable);
  }

  /* A dense table/list row. Height is a MINIMUM, so a wrapping cell grows
     rather than clipping — a clipped clinical value is a safety problem, and
     "it fitted on my screen" is not a defence. */
  .clinical-row {
    min-height: var(--row-h);
  }

  .tap-target {
    min-width: var(--tap-min);
    min-height: var(--tap-min);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  /**
   * A 44px touch target WITHOUT a 44px box.
   *
   * ⚠️ `.tap-target` grows the element itself, which is right for a standalone
   * control and wrong for a dense one: applying it to the Z6 calendar's
   * month-nav would put two 44px hover slabs beside a 12px month label, and
   * applying it to the day grid would push the grid wider than a 375px phone.
   *
   * This instead centres an invisible 44px pseudo-element over the control.
   * Pointer events hit it, so the reachable target is 44px while the drawn
   * control keeps its size. The month-nav chevrons measured 22×22 on every
   * phone width — under the Atlas's ≥44px rule and under WCAG 2.5.8's floor
   * too — while `--tap-min` sat in this file claiming the bar was enforced.
   *
   * ⚠️ On a grid, size the hit area to the PITCH (cell + gap) so neighbouring
   * targets tile exactly rather than overlapping. Overlapping hit areas on a
   * date picker turn a mis-tap into the wrong day.
   */
  .tap-reach {
    position: relative;
  }
  .tap-reach::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    width: var(--tap-min);
    height: var(--tap-min);
    transform: translate(-50%, -50%);
  }

  /* Screen-reader-only, but focusable (skip links). */
  .sr-only {
    position: absolute;
    width: 1px; height: 1px;
    padding: 0; margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border-width: 0;
  }

  .skip-link {
    position: absolute;
    left: 0.5rem;
    top: -3rem;
    z-index: 100;
    padding: 0.625rem 1rem;
    border-radius: var(--radius-md);
    background: var(--color-primary-600);
    color: var(--color-on-primary);
    font-size: var(--text-sm);
    font-weight: 600;
    transition: top 0.15s var(--ease-smooth);
  }
  .skip-link:focus {
    top: 0.5rem;
  }

  /**
   * ⚠️ SAFE AREA. On a notched or gesture-bar phone the bottom ~34px of the
   * viewport belongs to the home indicator. Anything `fixed bottom-0` sits
   * underneath it — which was true of `S-06-08`'s sticky action bar and
   * `S-06-07`'s basket trigger, both of which carry a primary action.
   *
   * `env()` resolves to 0 on every device without an inset, and to 0 in any
   * browser that does not support it, so these are safe to apply
   * unconditionally. They require `viewport-fit=cover` in the viewport meta —
   * without it the insets are never exposed and these silently do nothing.
   *
   * `.safe-bottom`  — adds the inset to existing bottom padding (full-width bars)
   * `.safe-inset-b` — lifts a floating element clear of the indicator
   */
  .safe-bottom {
    padding-bottom: calc(var(--safe-bottom-base, 0.75rem) + env(safe-area-inset-bottom, 0px));
  }
  .safe-inset-b {
    bottom: calc(var(--safe-inset-base, 1rem) + env(safe-area-inset-bottom, 0px));
  }

  .scrollbar-hide {
    -ms-overflow-style: none;
    scrollbar-width: none;
  }
  .scrollbar-hide::-webkit-scrollbar {
    display: none;
  }

}

/* ═══════════════════════════════════════════════════════════════════════════
   PRINT
   ───────────────────────────────────────────────────────────────────────────
   ⚠️ Deliberately UNLAYERED, and it must stay that way. Every rule below has
   to beat a Tailwind utility sitting in `@layer utilities`, and unlayered
   styles outrank layered ones regardless of specificity. Moving this into a
   layer would silently stop it working.

   The product prints exactly one artefact today — S-06-08's patient
   instruction sheet — and the Atlas is blunt about why it matters: "A
   discharge instruction the patient cannot read is not an instruction" (A6).
   The screen already called `window.print()`; what came out was the clinician
   application, dark theme and navigation included, on A4.

   A page that wants to print declares its sheet with `data-print-root`.
   Everything outside it is hidden. A page that declares nothing still prints
   sensibly — chrome removed, ink on paper — rather than printing blank.
   ═══════════════════════════════════════════════════════════════════════════ */

@media print {
  @page {
    margin: 14mm;
  }

  /* Ink on paper. The app's dark theme on a printer is unreadable and wastes
     most of a cartridge, so the sheet is forced light regardless of the
     viewer's theme — `color-scheme` alone does not override our own tokens.
     ⚠️ The shell paints its own background on a wrapper div (AppShell's
     `min-h-screen bg-bg`), so clearing it on `body` alone leaves the page
     tinted; `#root` and its descendants have to be cleared too. */
  html,
  body,
  #root,
  #root > * {
    background: #fff !important;
    color: #000 !important;
    min-height: 0 !important;
  }

  /* `overflow-x: clip` on body and `overflow-x: hidden` on <main> both truncate
     a printed document at the viewport width instead of paginating it. */
  body,
  main {
    overflow: visible !important;
  }

  /* Z1 app bar, Z2 nav, Z6 rail, Z7 sticky bars and the assistant bubble are
     screen furniture, not document content. */
  header,
  nav,
  aside,
  [data-print='hide'] {
    display: none !important;
  }

  /* ⚠️ …but a printed document has its own masthead, and it is a <header>.
     Hiding every <header> on the page took the patient's name, ID, visit and
     print date off the sheet — the four things that make a loose piece of paper
     attributable to a person. Scoped back in by higher specificity. */
  [data-print-root] header,
  [data-print-root] nav,
  [data-print-root] aside {
    display: revert !important;
  }

  /* Sticky and fixed elements repeat on every printed page in most engines. */
  .sticky,
  .fixed {
    position: static !important;
  }

  /* ── The declared sheet ───────────────────────────────────────────────────
     `visibility` rather than `display`, because a print root is nested several
     layouts deep and CSS cannot hide an ancestor without hiding its
     descendants. Hidden ancestors still occupy layout, so the root is lifted
     to the page origin. */
  body:has([data-print-root]) * {
    visibility: hidden;
  }
  body:has([data-print-root]) [data-print-root],
  body:has([data-print-root]) [data-print-root] * {
    visibility: visible;
  }
  body:has([data-print-root]) [data-print-root] {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    margin: 0;
    padding: 0;
  }

  /* One instruction is one unit. Splitting a patient's "come back immediately
     if…" list across a page break is exactly where a reader stops reading. */
  [data-print-block] {
    break-inside: avoid;
    page-break-inside: avoid;
  }

  /* Cards on paper are boxes-within-boxes; the sheet supplies its own rules. */
  [data-print-root] [class*='shadow'] {
    box-shadow: none !important;
  }

  /* A patient handout is not a web page. Printing every href as a URL — the
     common `a[href]::after` trick — is noise here. */
  a[href]::after {
    content: none !important;
  }

  /* Forced light tokens for anything inside the sheet that still reads them. */
  [data-print-root] {
    --color-ink: #000;
    --color-ink-muted: #333;
    --color-ink-subtle: #555;
    --color-bg: #fff;
    --color-surface-1: #fff;
    --color-surface-2: #fff;
    --color-border-soft: #999;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   DOCKED AI CHAT
   ───────────────────────────────────────────────────────────────────────────
   From 64rem (1024px) the patient's AI chat opens as a full-height column on
   the right, below the header, and the page makes room for it — nothing sits
   underneath (ChatLauncher sets `data-chat-docked` on <html> while it is
   docked). Deliberately UNLAYERED, like PRINT above: these must beat the
   Tailwind utilities they adjust.
   ═══════════════════════════════════════════════════════════════════════════ */

/* `main-md` / `main-lg` / `main-xl` — the page-layout breakpoints.
   UNDOCKED they ARE the screen breakpoints (md 48rem, lg 64rem, xl 80rem), so
   the layout is exactly what it always was. DOCKED they ask the content column
   instead (the `main` container, which exists only then), at the width that
   column has on those screens today: the screen less its 3rem of padding —
   45rem, 61rem, 77rem. So a page reflows to the space it actually has. */
@custom-variant main-md {
  @media (width >= 48rem) {
    :root:not([data-chat-docked='true']) & { @slot; }
  }
  @container main (width >= 45rem) {
    :root[data-chat-docked='true'] & { @slot; }
  }
}
@custom-variant main-lg {
  @media (width >= 64rem) {
    :root:not([data-chat-docked='true']) & { @slot; }
  }
  @container main (width >= 61rem) {
    :root[data-chat-docked='true'] & { @slot; }
  }
}
@custom-variant main-xl {
  @media (width >= 80rem) {
    :root:not([data-chat-docked='true']) & { @slot; }
  }
  @container main (width >= 77rem) {
    :root[data-chat-docked='true'] & { @slot; }
  }
}
/* From 80rem the column is at its 1280px cap (77rem inside the padding), so a
   96rem screen gives it no more room than an 80rem one: docked, 2xl is the cap. */
@custom-variant main-2xl {
  @media (width >= 96rem) {
    :root:not([data-chat-docked='true']) & { @slot; }
  }
  @container main (width >= 77rem) {
    :root[data-chat-docked='true'] & { @slot; }
  }
}

:root {
  --chat-dock-w: clamp(20rem, 30vw, 25rem);
  /* Replaced by the header's measured height (AppShell); this is its size
     below 1024px, so nothing is ever positioned against an unset value. */
  --app-header-h: 4.0625rem;
}

/* A modal's scroll lock removes the scrollbar; without a reserved gutter the
   page and the docked column would jump sideways every time one opens. */
html {
  scrollbar-gutter: stable;
}

@media (width >= 64rem) {
  :root[data-chat-docked='true'] #main-content {
    padding-right: var(--chat-dock-w);
  }
  /* The container exists ONLY while docked: containment re-anchors `fixed`
     descendants, so it is never applied when it is not needed (and page
     overlays are portalled to <body> for the same reason). */
  :root[data-chat-docked='true'] .app-content {
    container: main / inline-size;
  }
  /* …except while something in the page fills the screen itself (the scan
     viewer's full screen, where the browser has no native one): a container
     would hold it inside the column. */
  :root[data-chat-docked='true'] .app-content:has([data-fullscreen='true']) {
    container: none;
  }
  /* Bottom-right messages move left of the column instead of covering its
     question box. */
  :root[data-chat-docked='true'] .toast-region,
  :root[data-chat-docked='true'] .idle-warning {
    right: calc(var(--chat-dock-w) + 1rem);
  }
}

/* While the chat is open on a phone it reaches the bottom of the screen, and
   the patient's quick bar would sit on its question box. */
:root[data-chat-open='true'] .patient-bottom-nav {
  display: none;
}

@keyframes dockIn {
  from { opacity: 0; transform: translateX(1rem); }
  to   { opacity: 1; transform: none; }
}

@media print {
  :root[data-chat-docked='true'] #main-content {
    padding-right: 0 !important;
  }
}
```

---

## Appendix B: the assistant mark SVG

`public/robot-chat-icon.svg`, to use as an image:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" color="#2563EB" fill="none" role="img" aria-label="AI assistant">
  <!--
    SHRI HEALTH assistant mark — minimal, one colour (currentColor; primary-600 when used as an image).
    The eyes, smile and dots are cut out, and a gap separates the bubble from the head,
    so it stays crisp on any background. The same drawing, themed, lives in
    src/components/aiChat/AssistantMark.tsx — change both together.
  -->
  <defs>
    <mask id="rb-gap" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
      <rect width="32" height="32" fill="#fff"/>
      <path d="M23 19h3a4.75 4.75 0 0 1 0 9.5h-2.9l-4.6 2.8 1-3.3A4.75 4.75 0 0 1 23 19z" fill="#000" stroke="#000" stroke-width="3.2" stroke-linejoin="round"/>
    </mask>
    <mask id="rb-face" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
      <rect width="32" height="32" fill="#fff"/>
      <path d="M8.9 15.1q1.2-1.65 2.4 0M14.7 15.1q1.2-1.65 2.4 0M11.5 17.4q1.5 1.05 3 0" stroke="#000" stroke-width="1.75" stroke-linecap="round"/>
    </mask>
    <mask id="rb-dots" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
      <rect width="32" height="32" fill="#fff"/>
      <circle cx="21.6" cy="23.75" r="1.1" fill="#000"/>
      <circle cx="24.75" cy="23.75" r="1.1" fill="#000"/>
      <circle cx="27.9" cy="23.75" r="1.1" fill="#000"/>
    </mask>
  </defs>
  <g fill="currentColor" mask="url(#rb-gap)">
    <circle cx="13" cy="3.4" r="1.6"/>
    <rect x="12.25" y="4.5" width="1.5" height="3.2" rx="0.4"/>
    <rect x="0.9" y="11.75" width="2.6" height="5.5" rx="1.3"/>
    <rect x="22.5" y="11.75" width="2.6" height="5.5" rx="1.3"/>
    <rect x="3.5" y="7.6" width="19" height="15" rx="7.5" fill="none" stroke="currentColor" stroke-width="2.1"/>
    <rect x="6.7" y="10.8" width="12.6" height="8.6" rx="4.3" mask="url(#rb-face)"/>
  </g>
  <path d="M23 19h3a4.75 4.75 0 0 1 0 9.5h-2.9l-4.6 2.8 1-3.3A4.75 4.75 0 0 1 23 19z" fill="currentColor" mask="url(#rb-dots)"/>
</svg>
```

`AssistantMark.tsx`, the themed inline component (the same drawing):

```tsx
import { useId } from 'react'

/**
 * The assistant's mark: a small robot with a speech bubble.
 *
 * Minimal and one colour — it draws in `currentColor`, so it takes whatever
 * text colour its container gives it: white on the blue corner button, blue
 * on white, and the matching tones in dark mode. The eyes, smile and dots
 * are cut out, and a thin gap separates the bubble from the head, so the
 * mark stays crisp on any background rather than relying on a fill colour.
 *
 * The same drawing is `public/robot-chat-icon.svg` (for use as an image) —
 * change both together.
 *
 * Decorative by default; the button or heading beside it carries the name.
 */
const BUBBLE = 'M23 19h3a4.75 4.75 0 0 1 0 9.5h-2.9l-4.6 2.8 1-3.3A4.75 4.75 0 0 1 23 19z'

export default function AssistantMark({ size = 24, className }: { size?: number; className?: string }) {
  // Mask ids must be unique per instance: the mark can appear several times
  // on one page, and a reference into a hidden copy may not paint.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const gap = `am-gap-${uid}`
  const face = `am-face-${uid}`
  const dots = `am-dots-${uid}`

  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <defs>
        <mask id={gap} maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
          <rect width="32" height="32" fill="#fff" />
          <path d={BUBBLE} fill="#000" stroke="#000" strokeWidth="3.2" strokeLinejoin="round" />
        </mask>
        <mask id={face} maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
          <rect width="32" height="32" fill="#fff" />
          <path
            d="M8.9 15.1q1.2-1.65 2.4 0M14.7 15.1q1.2-1.65 2.4 0M11.5 17.4q1.5 1.05 3 0"
            stroke="#000"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </mask>
        <mask id={dots} maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
          <rect width="32" height="32" fill="#fff" />
          <circle cx="21.6" cy="23.75" r="1.1" fill="#000" />
          <circle cx="24.75" cy="23.75" r="1.1" fill="#000" />
          <circle cx="27.9" cy="23.75" r="1.1" fill="#000" />
        </mask>
      </defs>
      <g fill="currentColor" mask={`url(#${gap})`}>
        <circle cx="13" cy="3.4" r="1.6" />
        <rect x="12.25" y="4.5" width="1.5" height="3.2" rx="0.4" />
        <rect x="0.9" y="11.75" width="2.6" height="5.5" rx="1.3" />
        <rect x="22.5" y="11.75" width="2.6" height="5.5" rx="1.3" />
        <rect x="3.5" y="7.6" width="19" height="15" rx="7.5" fill="none" stroke="currentColor" strokeWidth="2.1" />
        <rect x="6.7" y="10.8" width="12.6" height="8.6" rx="4.3" mask={`url(#${face})`} />
      </g>
      <path d={BUBBLE} fill="currentColor" mask={`url(#${dots})`} />
    </svg>
  )
}
```
