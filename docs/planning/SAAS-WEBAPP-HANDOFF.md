# Handoff — SaaS control-plane web app: scope the whole diagonal

> **SUPERSEDED — 2026-07-20.** The active plan is
> [`ONE-BOX-PLAN-2026-07-20.md`](ONE-BOX-PLAN-2026-07-20.md). This document is kept for its
> measured findings only; **its stages, gates and stage vocabulary are dead** and any `S`/`M`-stage
> reference inside it points at work that is no longer scheduled. Findings accumulate; plans are
> singular.

**Date:** 2026-07-18 · **Branch:** `saas` · **Repo:** `AaronAbuUsama/ambient-agent`

You are picking up a `/wayfinder` effort mid-flight. The prior session charted a map that
covers the multi-tenant *runtime plumbing* but **not the control-plane web app as a
product** — what it must have, and how it integrates with everything else. That is your job.
Do not narrow this to "add a ticket." Map the whole thing.

## The goal

Turn `ambient-agent` (a self-hosted WhatsApp+GitHub ambient agent) into a multi-tenant SaaS:
users sign up, pay, install a GitHub App, pair a WhatsApp number, pick chats, bring their own
model creds — "hire a coworker," not self-host a bot. Two planes, **never merged / separate
deployables** (`docs/planning/SAAS-MVP-PLAN.md:14,46-50`):

- **Data plane** = `ambient-agent` (this repo), one container per tenant. Mostly unchanged.
- **Control plane** = the root `apps/web` SaaS app + `apps/api` provisioner.

## The gap you must close (this is the actual ask)

The map scoped six runtime/infra *decisions* but never scoped the **control-plane web app
itself** or reconciled the two conflicting web-app visions in the repo:

1. **`docs/planning/WEB-APP-IA.md`** (ratified 2026-07-17) — a **local, single-installation
   supervisor app**: `npx ambient-agent` serves a wizard + operate UI, thin skin over CLI
   commands, drives a **local child process**. It *explicitly excludes* multi-tenant / hosted
   / auth (`:134`) and GitHub App install (`:133`).
2. **`docs/planning/SAAS-MVP-PLAN.md`** (2026-07-18) — the **hosted, multi-tenant control
   plane**: auth (better-auth) + billing (Polar) + provisioning, driving **remote per-tenant
   containers** via the Dokploy API. This is the root control plane.

They need the **same screens** (model auth, WhatsApp QR pairing, managed-chat pick, GitHub
setup, health/operate) but differ in tenancy (local-single vs hosted-multi) and in what they
drive (local child process vs remote container over an HTTP bridge). **Nobody has decided
whether the SaaS dashboard reuses/extends the supervisor app or is a fresh build.** The imported
Next.js+better-auth+Polar scaffold implies "fresh build," but that is
unratified and is the load-bearing fork.

### What "the whole diagonal" means — scope all of this end to end

For the control-plane web app, produce the full picture: what it must **have**, and every seam
by which it **integrates**:

- **Auth + billing** — better-auth signup/login; Polar checkout/portal; `subscription.active`
  webhook → provision; subscription state in the UI.
- **Onboarding wizard (per tenant)** — model auth (BYO ChatGPT OAuth *or* API key), WhatsApp
  pairing (QR **over HTTP**, not stdout), managed-chat selection, GitHub **App** install +
  repo pick. (Mirrors `WEB-APP-IA.md` Mode 1, but hosted + multi-tenant + App-based.)
- **Operate dashboard (per tenant)** — overview/health, chats, GitHub, model, re-pair,
  subscription. (Mirrors `WEB-APP-IA.md` Mode 2, but reads a remote container, not a local
  child.)
- **Provisioner + single-owner lease** — `tenant`/`agent_instances`/lease schema; oRPC route
  → Dokploy start/stop; exactly one live container per tenant creds-store.
- **Central GitHub webhook router** — one App = one webhook URL; route by `installation.id`
  to the right tenant container.
- **The control-plane↔tenant HTTP bridge** — QR/pairing/health/config (and delivery if push).
- **Turso control-plane store** — where tenant/lease/install-registry rows live.
- **Data-plane integration seams** (`SAAS-MVP-PLAN.md:143-154`) — data-root env override; QR +
  model-OAuth capture over HTTP; WhatsApp creds via `libsqlStore` (per-tenant); control-plane-
  written config; consume routed GitHub deliveries.

Then **reconcile with `WEB-APP-IA.md`** (share screens/components? shared package? or fully
separate?) and **expand the wayfinder map** so it covers the web-app product + integration —
not just the six runtime decisions.

## Where things stand right now

- **Wayfinder map:** [`Map: Ambient-Agent → SaaS MVP` (#165)](https://github.com/AaronAbuUsama/ambient-agent/issues/165), label `wayfinder:map`.
  Destination: resolve every open SaaS decision **and** file a single "SaaS MVP" milestone of
  build tickets spanning both planes. Read the map body — it has the ratified constraints,
  the fog (build backlog), and out-of-scope.
- **Six decision tickets (children of #165):**
  - Frontier (open, unblocked): **T-A #166** Dokploy reality spike (`task`) · **T-B #167**
    Turso topology · **T-E #170** managedChats UX · **T-F #171** control↔tenant HTTP bridge
    contract (`prototype`).
  - Blocked: **T-C #168** webhook delivery push-vs-pull (← T-A) · **T-D #169** provisioner +
    single-owner lease (← T-A, T-B).
  - Aaron has kicked off **T-A/B/E/F in parallel windows** — expect concurrent edits to the
    tracker. Do not resolve those; your job is scoping, not racing them.
- **`apps/web` + `apps/api`** — the tracked root control-plane scaffold: Next.js, Hono/oRPC,
  better-auth, and Polar. It was imported from the temporary donor at commit `00918f0` by
  PR #189; that donor was transitional and is no longer a workspace or product boundary.
  The control plane remains a **separate deployable** (own build/Dockerfile), never fused into
  the agent runtime.

## Ratified — do not relitigate

- Two planes, never merged; separate deployables; no code merge (`SAAS-MVP-PLAN.md:14,46-50`).
- The nine ratified SaaS decisions (`:54-137`): process-per-tenant; single-owner lease
  invariant; libsql/SQLite everywhere (no Postgres); per-tenant data-plane DBs stay LOCAL;
  memory/state graph stays in per-tenant `application.sqlite`; BYO model creds per user; BYO
  WhatsApp number for MVP; control plane owns GitHub install lifecycle + webhook routing.
- Out of scope (separate future wayfinders): managed-number provisioning; pooled/in-process
  multi-tenant runtime (`:186-189`).
- Stale paths: the plan predates the monorepo split (#117). Live paths — `paths.ts` →
  `packages/installation/src/paths.ts`; `ingress-runtime.ts` →
  `packages/engine/src/github/ingress-runtime.ts`; `graph/store.ts` →
  `packages/engine/src/graph/store.ts`; `whatsapp-runtime.ts` →
  `apps/runtime/src/host/whatsapp-runtime.ts`; `github-app-client.ts` →
  `packages/installation/src/github-app-client.ts`.

## Method (wayfinder + how Aaron wants decisions put to him)

- The map lives on GitHub (`gh`); child tickets are sub-issues with native `blocked_by` edges;
  frontier = open + unblocked + unassigned children. Skills: `/grilling`, `/domain-modeling`,
  `/prototype`.
- **Present every HITL decision the #91 way:** the problem in real code (`file:line` + real
  snippets), the blast radius, options as concrete diff sketches, graded on floor-first /
  reversibility / blast radius / correctness / parallelizability / fit, with a recommendation —
  via `AskUserQuestion`. Never ask in the abstract.
- Charting/scoping is planning; the build backlog gets **filed** (per the destination), not
  built, by these sessions.

## Traps the last session hit (don't repeat)

- Do **not** treat the temporary donor as a product boundary. The root control plane is
  `apps/web` + `apps/api`.
- Do **not** answer narrowly (one ticket) when the ask is the whole web-app scope + integration.
- `WEB-APP-IA.md` is a **different (local, single-tenant) app** — reconcile it with the SaaS
  control plane; do not assume it already is the SaaS dashboard.

## First moves

1. Read: `SAAS-MVP-PLAN.md`, `WEB-APP-IA.md`, `MEMORY-STATE-SPEC.md`, the #165 map body, and
   skim `apps/web` + `apps/api`.
2. Produce the whole-diagonal scope of the control-plane web app + integration seams, and the
   supervisor-app-vs-SaaS-app reconciliation, as concrete options for Aaron.
3. Expand map #165 with the missing tickets (web-app product scope, app-home/workspace
   integration, auth+billing, onboarding wizard, operate dashboard, webhook router, …), wired
   with blocking edges — then stop and let Aaron drive the frontier.
