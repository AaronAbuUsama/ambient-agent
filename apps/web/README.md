# apps/web — the operator console

A React + Vite single-page application, styled with shadcn/ui. It is served by the control plane in
`apps/cli/src/control-plane.ts` and reaches the runtime **only over HTTP**, through `/api/`. It
imports nothing from `@ambient-agent/*`, and `tests/speaker/hard-cut.test.ts` enforces that.

## What a screen node builds into

Two things are defined here for the six screen nodes (#377–#382) to consume. Use them; do not
reinvent either.

### `apiFetch` — the token-authenticated fetch client (`src/lib/api.ts`)

```tsx
import { apiFetch, UnauthorizedError } from "@/lib/api"

const status = await apiFetch<ControlPlaneStatus>("/api/status")
```

It attaches the bearer token, parses JSON, and — the part that matters — on a `401` clears the
stored token and announces it, which returns the whole shell to its sign-in state. A screen never
handles "the token went bad"; it only handles its own data. `UnauthorizedError` is thrown so a
caller can stop, not so it can render an error.

### The route shell (`src/App.tsx`, `src/routes.tsx`)

`App` is the two-state shell: signed out renders `SignIn`, signed in renders the sidebar, the
header, and the active route's element. `ROUTES` in `src/routes.tsx` is the single list of the
seven destinations — path, label, icon, element. **A screen node replaces exactly one `element`**
and touches nothing else. `routeFor` does longest-prefix matching, so a screen that wants
`/chats/<id>` reads the remainder off `usePathname()` from `src/lib/router.ts` itself.

Routing is the History API (`src/lib/router.ts`): `usePathname()` to read, `navigate()` to move.
Deep links work because the control plane falls back to `index.html` for any path without a file
extension.

## Styling

shadcn/ui primitives are **installed through the CLI**, never hand-authored:

```bash
pnpm --filter web exec shadcn add <component>
```

Colour and radius come from the semantic tokens (`background/foreground`, `card/…`, `primary/…`,
`muted/…`, `destructive`, `border`, `input`, `ring`, `sidebar-*`, `--radius`) consumed as Tailwind
utilities. No hex values, no inline `style=`, no second stylesheet — `tests/web/console.test.ts`
fails if any of those appear in the source this project authors. `src/components/ui/` and
`src/assets/` are generator output and are exempt.

## Building

The console is built as part of the published package, not separately:

```bash
pnpm run build        # runtime, then CLI, then the console into dist/web
```

`VITE_BUILD_NONCE` is baked into `index.html` and rendered on every placeholder route, so a served
page can be tied back to the artifact it was built from.
