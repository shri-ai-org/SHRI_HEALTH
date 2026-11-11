import { useCallback, useEffect, useState } from 'react'

// The desk's quick to-do notes. No backend: kept in this browser's
// localStorage so they survive a refresh. Anything stored that isn't a to-do
// is skipped on read rather than breaking the dashboard.

export interface Todo {
  id: string
  text: string
  done: boolean
  /** When the text was last saved. */
  savedAt: number
}

const STORAGE_KEY = 'care-entry.todos.v1'

function readTodos(): Todo[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (t): t is Todo =>
        Boolean(t) &&
        typeof t === 'object' &&
        typeof (t as Todo).id === 'string' &&
        typeof (t as Todo).text === 'string' &&
        (t as Todo).text.trim().length > 0 &&
        typeof (t as Todo).done === 'boolean' &&
        typeof (t as Todo).savedAt === 'number',
    )
  } catch {
    return []
  }
}

export function useTodos() {
  const [todos, setTodos] = useState<Todo[]>(readTodos)

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(todos))
    } catch {
      // Storage blocked or full — the list still works for this visit.
    }
  }, [todos])

  // Another tab changed the list: follow it.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setTodos(readTodos())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const add = useCallback((text: string) => {
    const clean = text.trim()
    if (!clean) return
    const todo: Todo = { id: `todo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, text: clean, done: false, savedAt: Date.now() }
    setTodos((current) => [todo, ...current])
  }, [])

  const edit = useCallback((id: string, text: string) => {
    const clean = text.trim()
    setTodos((current) => (clean ? current.map((t) => (t.id === id && t.text !== clean ? { ...t, text: clean, savedAt: Date.now() } : t)) : current.filter((t) => t.id !== id)))
  }, [])

  const toggle = useCallback((id: string) => {
    setTodos((current) => current.map((t) => (t.id === id ? { ...t, done: !t.done } : t)))
  }, [])

  const remove = useCallback((id: string) => {
    setTodos((current) => current.filter((t) => t.id !== id))
  }, [])

  return { todos, add, edit, toggle, remove }
}
