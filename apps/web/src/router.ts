import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()

function subscribe(callback: () => void): () => void {
  listeners.add(callback)
  window.addEventListener('popstate', callback)
  return () => {
    listeners.delete(callback)
    window.removeEventListener('popstate', callback)
  }
}

export function usePathname(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.pathname,
    () => '/',
  )
}

export function navigate(to: string): void {
  window.history.pushState(null, '', to)
  for (const listener of listeners) listener()
}
