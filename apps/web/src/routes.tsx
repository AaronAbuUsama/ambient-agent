/**
 * The seven destinations of the console, and the placeholder each one renders until its own node
 * lands. A screen node replaces exactly one `element` here and touches nothing else.
 */
import type { LucideIcon } from "lucide-react"
import {
  Activity,
  Bot,
  GitBranch,
  KeyRound,
  LayoutDashboard,
  MessageSquare,
  ScrollText,
} from "lucide-react"

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

export interface ConsoleRoute {
  /** The pathname this destination owns; sub-paths under it route here too. */
  readonly path: string
  readonly label: string
  readonly icon: LucideIcon
  readonly element: React.ReactNode
}

/**
 * The build this bundle came from. Injected at build time (`VITE_BUILD_NONCE`) so a served page
 * can be tied back to the artifact it was built from — the proof this shell shipped end to end.
 */
export const buildNonce: string = import.meta.env.VITE_BUILD_NONCE ?? "dev"

function Placeholder({
  icon: Icon,
  label,
}: {
  icon: LucideIcon
  label: string
}) {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{label}</EmptyTitle>
        <EmptyDescription>
          This screen has not been built yet. The shell, the sidebar, routing
          and the authenticated fetch client are in place.
        </EmptyDescription>
      </EmptyHeader>
      <p
        className="font-mono text-xs text-muted-foreground"
        data-testid="build-nonce"
      >
        build {buildNonce}
      </p>
    </Empty>
  )
}

const placeholder = (icon: LucideIcon, label: string) => (
  <Placeholder icon={icon} label={label} />
)

export const ROUTES: readonly ConsoleRoute[] = [
  {
    path: "/",
    label: "Overview",
    icon: LayoutDashboard,
    element: placeholder(LayoutDashboard, "Overview"),
  },
  {
    path: "/chats",
    label: "Chats",
    icon: MessageSquare,
    element: placeholder(MessageSquare, "Chats"),
  },
  {
    path: "/repositories",
    label: "Repositories",
    icon: GitBranch,
    element: placeholder(GitBranch, "Repositories"),
  },
  {
    path: "/agents",
    label: "Agents",
    icon: Bot,
    element: placeholder(Bot, "Agents"),
  },
  {
    path: "/runtime",
    label: "Runtime",
    icon: Activity,
    element: placeholder(Activity, "Runtime"),
  },
  {
    path: "/secrets",
    label: "Secrets",
    icon: KeyRound,
    element: placeholder(KeyRound, "Secrets"),
  },
  {
    path: "/logs",
    label: "Logs",
    icon: ScrollText,
    element: placeholder(ScrollText, "Logs"),
  },
]

/** Longest-prefix match, with Overview as the root and the answer for anything unrecognised. */
export const routeFor = (pathname: string): ConsoleRoute =>
  ROUTES.find(
    (route) =>
      route.path !== "/" &&
      (pathname === route.path || pathname.startsWith(`${route.path}/`))
  ) ?? ROUTES[0]
