/**
 * The route shell (#372) — what every console screen (#377–#382) renders inside.
 *
 * Two states, and the whole app is one or the other: signed out (no usable token) shows
 * {@link SignIn}; signed in shows the sidebar, the header, and the active route's element. A `401`
 * from `apiFetch` clears the token and announces it, which returns the shell to the first state
 * rather than leaving a screen to render a failure it cannot fix.
 */
import * as React from "react"

import { AppSidebar } from "@/components/app-sidebar"
import { SignIn } from "@/components/sign-in"
import { Separator } from "@/components/ui/separator"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { AUTH_CHANGED_EVENT, controlPlaneToken } from "@/lib/api"
import { usePathname } from "@/lib/router"
import { routeFor } from "@/routes"

const subscribeToAuth = (onChange: () => void): (() => void) => {
  window.addEventListener(AUTH_CHANGED_EVENT, onChange)
  // Another tab signing in or out is the same event as far as this one is concerned.
  window.addEventListener("storage", onChange)
  return () => {
    window.removeEventListener(AUTH_CHANGED_EVENT, onChange)
    window.removeEventListener("storage", onChange)
  }
}

/** The stored bearer token, as a subscription: sign-in, sign-out and a 401 all land here. */
export const useControlPlaneToken = (): string | null =>
  React.useSyncExternalStore(subscribeToAuth, controlPlaneToken)

function Console() {
  const route = routeFor(usePathname())
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <h1 className="text-sm font-medium">{route.label}</h1>
        </header>
        <main className="flex flex-1 flex-col p-4">{route.element}</main>
      </SidebarInset>
    </SidebarProvider>
  )
}

export function App() {
  return useControlPlaneToken() === null ? <SignIn /> : <Console />
}

export default App
