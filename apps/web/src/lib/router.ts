/**
 * The console's routing, on the History API.
 *
 * Seven flat destinations with no parameters and no nesting do not need a routing library; the
 * platform already has one. `usePathname` re-renders on `popstate` (browser back/forward) and on
 * `navigate`, and the server's deep-link fallback makes a cold load of any path work.
 *
 * ponytail: flat prefix matching, no route parameters. If a screen needs `/chats/:id` it reads the
 * remainder off `usePathname()` itself; adopt a router library only when several screens need it.
 */
import { useSyncExternalStore } from "react"

const subscribe = (onChange: () => void): (() => void) => {
  window.addEventListener("popstate", onChange)
  return () => window.removeEventListener("popstate", onChange)
}

export const usePathname = (): string =>
  useSyncExternalStore(subscribe, () => window.location.pathname)

/** Push a destination and tell the subscribers. `popstate` is the one signal both paths share. */
export const navigate = (to: string): void => {
  if (to === window.location.pathname) return
  window.history.pushState(null, "", to)
  window.dispatchEvent(new PopStateEvent("popstate"))
}
