import { LogOut, Moon, Sun } from "lucide-react"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { useTheme } from "@/components/theme-provider"
import { forgetControlPlaneToken } from "@/lib/api"
import { navigate, usePathname } from "@/lib/router"
import { ROUTES, routeFor } from "@/routes"

/** Left click, no modifier, main button — the navigations a client-side router should intercept. */
const isPlainClick = (event: React.MouseEvent): boolean =>
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey

export function AppSidebar() {
  const active = routeFor(usePathname())
  const { theme, setTheme } = useTheme()

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="px-2 py-1 text-sm font-medium group-data-[collapsible=icon]:hidden">
          ambient-agent
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {ROUTES.map((route) => (
                <SidebarMenuItem key={route.path}>
                  <SidebarMenuButton
                    isActive={route.path === active.path}
                    tooltip={route.label}
                    render={<a href={route.path} />}
                    onClick={(event) => {
                      // A real anchor, so middle-click and cmd-click still open a new tab and the
                      // deep link is copyable; only the plain click is taken client-side.
                      if (!isPlainClick(event)) return
                      event.preventDefault()
                      navigate(route.path)
                    }}
                  >
                    <route.icon />
                    <span>{route.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Toggle theme"
              data-testid="toggle-theme"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <Sun /> : <Moon />}
              <span>{theme === "dark" ? "Light" : "Dark"}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Sign out"
              onClick={forgetControlPlaneToken}
            >
              <LogOut />
              <span>Sign out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
