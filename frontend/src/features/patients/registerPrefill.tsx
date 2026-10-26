import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react'

/** What the register form starts with when the search found nobody. */
export interface RegisterPrefill {
  family?: string
  given?: string
  birthDate?: string
}

interface Handoff {
  /** Called by search just before it opens the register form. */
  set: (prefill: RegisterPrefill) => void
  /** Read by the register form when it opens; `clear` after reading, so it is used once. */
  peek: () => RegisterPrefill
  clear: () => void
}

const HandoffContext = createContext<Handoff | null>(null)

/**
 * Hands the typed name and date of birth from search to registration in memory only: never in the
 * URL (D13) and never in router state, which the browser keeps in `history.state` for the tab after
 * sign-out (Thulasi and Vimal, PR #41). Mount it inside `SessionProvider`, which unmounts its
 * children when the session ends, so sign-out or expiry drops whatever is held here.
 */
export function RegisterPrefillProvider({ children }: { children: ReactNode }) {
  const held = useRef<RegisterPrefill>({})
  const value = useMemo<Handoff>(
    () => ({
      set: (prefill) => {
        held.current = prefill
      },
      peek: () => held.current,
      clear: () => {
        held.current = {}
      },
    }),
    [],
  )
  return <HandoffContext.Provider value={value}>{children}</HandoffContext.Provider>
}

export function useRegisterPrefill(): Handoff {
  const value = useContext(HandoffContext)
  if (!value) throw new Error('useRegisterPrefill must be used inside <RegisterPrefillProvider>')
  return value
}
