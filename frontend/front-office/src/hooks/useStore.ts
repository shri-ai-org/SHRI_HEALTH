import { useSyncExternalStore } from 'react'
import { getState, subscribe } from '../domain/store'
import type { AppState } from '../types/store'

// One cache entry per (state reference, selector function, args) so
// useSyncExternalStore's getSnapshot returns a STABLE reference between
// store updates — selectors in domain/selectors.ts build fresh arrays/
// objects on every call, and without this cache that would look like "a new
// value on every render" to React and either thrash or throw the
// "getSnapshot should be cached" warning. The cache is a WeakMap keyed by
// the state object itself, so it's automatically dropped the moment a new
// state replaces it (see domain/store.ts's setState).
//
// The cache holds selectors of many different argument shapes at once, so
// its key type can't preserve each selector's own tuple — TypeScript has no
// existential type for "some function with its own (state, ...args)
// signature". This is the one place that settles for `any` rather than
// widening every selector's public signature to match.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySelector = (state: AppState, ...args: any[]) => unknown
const cache = new WeakMap<AppState, Map<AnySelector, Map<string, unknown>>>()

// Selectors that take a clock (`now`) get a new argument on every tick of
// useNow, and the state object — the only thing that drops the cache — can
// stay the same for a long idle stretch. Each selector's entries are kept in
// least-recently-used order (a hit moves its key to the end) and the coldest
// is dropped past this size, so stale clock ticks age out while every value a
// mounted component is still reading stays put.
const MAX_ARG_SETS_PER_SELECTOR = 256

function selectCached<TArgs extends unknown[], TResult>(
  state: AppState,
  selector: (state: AppState, ...args: TArgs) => TResult,
  args: TArgs,
): TResult {
  let bySelector = cache.get(state)
  if (!bySelector) {
    bySelector = new Map()
    cache.set(state, bySelector)
  }
  const key = selector as unknown as AnySelector
  let byArgs = bySelector.get(key)
  if (!byArgs) {
    byArgs = new Map()
    bySelector.set(key, byArgs)
  }
  const argsKey = JSON.stringify(args)
  if (byArgs.has(argsKey)) {
    const hit = byArgs.get(argsKey) as TResult
    byArgs.delete(argsKey)
    byArgs.set(argsKey, hit)
    return hit
  }
  if (byArgs.size >= MAX_ARG_SETS_PER_SELECTOR) {
    const coldest = byArgs.keys().next().value
    if (coldest !== undefined) byArgs.delete(coldest)
  }
  const value = selector(state, ...args)
  byArgs.set(argsKey, value)
  return value
}

/** Subscribes a component to the operational store and returns
 * `selector(state, ...args)`, recomputed only when the store actually
 * changes (or `args` change). This is the only way screens read state. */
export function useStoreValue<TArgs extends unknown[], TResult>(
  selector: (state: AppState, ...args: TArgs) => TResult,
  ...args: TArgs
): TResult {
  return useSyncExternalStore(subscribe, () => selectCached(getState(), selector, args))
}
