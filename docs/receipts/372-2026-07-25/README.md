# Receipt — #372, the console shell

**Node:** #372 — the operator console's shell: design system, sidebar, routing, authenticated fetch,
and the built assets shipping inside the published package.
**Surface:** ui. **Captured:** 2026-07-25, from a **packed tarball installed into a clean
location**, not the working tree.

## The artifact under test

```
npm pack  →  ambient-agent-0.4.0.tgz  (shasum eb348d0d9d8febb583ab295c2006805f8b35f87e)
           →  installed with `npm install` into /tmp/372-live
           →  started: node node_modules/ambient-agent/dist/cli/main.js --data-dir … --control-port 4757
```

**Nonce:** `372-20260725T151923Z-73f5f1bd`, minted at pack time, baked in as `VITE_BUILD_NONCE`,
rendered into every placeholder route *and* into `index.html`, and read back off the served
response of the installed tarball (`artifacts/tier4-readback.txt`).

## Tier table

| tier | what it proves | evidence |
|---|---|---|
| 1 mechanical | `pnpm run typecheck && pnpm test` green; the no-custom-styling criterion is enforced by a check | `tests/web/console.test.ts` (2 tests), `tests/speaker/hard-cut.test.ts`, `tests/managed/control-plane.test.ts` (11 tests). Suite: 85 files, 846 passed |
| 2 integrated | N/A | N/A |
| 3 live (branch) | every route visited in Chrome in both colour schemes, from the installed tarball, plus a deep link and a browser reload | `screenshots/{light,dark}-{overview,chats,repositories,agents,runtime,secrets,logs}.jpg`, `screenshots/dark-sign-in.jpg`, `screenshots/navigation.gif` |
| 4 readback | the tarball's file list contains the built assets; the served bytes are the built bytes | `artifacts/tarball-filelist.txt`, `artifacts/tier4-readback.txt` |
| 5 observed | N/A | N/A |

## Acceptance criteria, against the evidence

| criterion | evidence |
|---|---|
| shadcn/ui installed via its CLI; components added, never hand-authored | `apps/web/components.json` + `src/components/ui/` are generator output; the one edit is a dead `import * as React` the registry emits that the scaffold's `noUnusedLocals` rejects, commented in place. `tests/web/console.test.ts` exempts that directory and forbids hand styling everywhere else |
| the official sidebar primitive, all seven destinations | `src/components/app-sidebar.tsx` imports from `@/components/ui/sidebar`; all 14 route screenshots show the seven items |
| routing works, deep links and back/forward | `navigation.gif` — six client-side clicks, two `back`s, one `forward`, then a hard reload of `/secrets`. Server-side deep links: `tier4-readback.txt` (all seven routes 200 `text/html`) |
| every data request carries the bearer token; a 401 returns the user to a sign-in state | `src/lib/api.ts`. Live: a 401 taken on `/secrets` flipped the shell to the sign-in card without rendering a broken screen (status `401`, body then `"ambient-agent / Paste the control-plane bearer token…"`). A wrong token at sign-in is refused and never stored: body showed *"The control plane refused that token."*, `localStorage` still `null` |
| the production build emits assets into the published output, the server serves them, with a deep-link fallback | `package.json` `build:dist` ends in `build:web`; `apps/cli/src/control-plane.ts` serves `dist/web`; `tier4-readback.txt` |
| the published package contains the built assets — from a packed tarball | `tarball-filelist.txt` — `package/dist/web/index.html`, `package/dist/web/assets/*` |
| light and dark both render correctly | 7 light + 7 dark screenshots |
| **negative:** no hex colour, no inline `style=`, no bespoke stylesheet in the application source | `tests/web/console.test.ts`, first test. Verified to fail on a planted `style={{ color: "#ff0000" }}` |

## The #364 amendment, proved both ways

`GET /` and the asset paths are served **without** a token. Everything under `/api/` keeps #364's
gate exactly as merged, including gate-before-routing:

```
GET /api/status   no token  -> 401
GET /api/unknown  no token  -> 401     ← gate before routing, unchanged
GET /api/status   token     -> 200
GET /api/unknown  token     -> 404
GET /  /chats  /repositories  /agents  /runtime  /secrets  /logs  -> 200 text/html
GET /assets/missing.js -> 404          ← a named file that misses is a real 404
GET /../../etc/passwd.js -> 404        ← and the encoded form too
```

## Workspace re-inclusion

`pnpm-workspace.yaml` no longer excludes `apps/web`; `apps/web` takes `typescript` and `vite` from
the root catalog. Result: **exactly one** `@flue/runtime` snapshot in `pnpm-lock.yaml`
(`artifacts/flue-runtime-snapshots.txt` — one bare entry, one peer-keyed snapshot),
`pnpm install --frozen-lockfile` clean, `tests/speaker/braintrust.test.ts` green, and
`pnpm run lint` runs at all again (3 pre-existing warnings, no errors).

## Reproducing

```bash
NONCE="372-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)"
VITE_BUILD_NONCE="$NONCE" npm pack --pack-destination /tmp
mkdir -p /tmp/372-live && cd /tmp/372-live && npm init -y && npm install /tmp/ambient-agent-0.4.0.tgz
mkdir -p /tmp/372-data/credentials
printf '{"schemaVersion":1,"kind":"control-plane","token":"live-proof-token-372"}' \
  > /tmp/372-data/credentials/control-plane.json
node node_modules/ambient-agent/dist/cli/main.js --data-dir /tmp/372-data --control-port 4757 &
ORIGIN=http://127.0.0.1:4757 TOKEN=live-proof-token-372 \
  INSTALLED=/tmp/372-live/node_modules/ambient-agent bash artifacts/probe.sh
```

## What this receipt does not cover

The live run used a seeded credential and a data directory that is otherwise empty, so the runtime
reported `not-configured` — deliberate: this node's surface is the shell, and the shell renders the
same either way. Screen content is #377–#382.
