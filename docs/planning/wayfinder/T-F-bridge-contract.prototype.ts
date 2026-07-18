/**
 * T-F · Control-plane ↔ tenant HTTP bridge contract — PROTOTYPE STUB (react to this, don't build it)
 * =================================================================================================
 *
 * The map's ticket #171. A concrete stub of the thin HTTP surface between the root control plane
 * (`apps/api`) and each tenant container. Grounded in the surfaces that already exist:
 *
 *   - The tenant already runs a Hono app; extra routes mount via `composeSpeaker`'s `routes`
 *     seam exactly like `installSmokeRoute` — apps/runtime/src/app.ts:103-109.
 *   - `/health` already exists and is UNAUTHENTICATED — probed at http://127.0.0.1:<port>/health
 *     by `probeAmbientRuntimeHealth` (runtime-health.ts:54-88) and (in SaaS) by the Dokploy
 *     healthcheck. Returns { ok, installationId, runtime: { state, whatsapp: { phase } } }
 *     (app.ts:94-102).
 *   - Auth is already solved: HMAC over the tenant's `webhookSecret`, custom header,
 *     `timingSafeEqual`, nonce replay-guard — smoke-route.ts:16-54, runtime-health.ts:22-35.
 *     The control plane MINTS each tenant's webhookSecret at provision time, so it already
 *     holds the key needed to authenticate to the bridge. No new secret, no new mechanism.
 *   - The QR is currently stdout-only — whatsapp-runtime.ts:247-253 calls `renderQr(pairing.qr)`.
 *     `PairingProgress = { method: "qr"|"pairing_code"; qr?; code?; expiresAt }` (whatsapp-account.ts:30).
 *
 * The whole contract is therefore SMALL: it extends an authenticated HTTP surface that is
 * already there. It has three live facets + one deferred facet:
 *
 *   1. Pairing render + pairing/health poll   → GET /health (unauth), GET /pairing (authed)
 *   2. Control-plane-written config           → NOT an HTTP endpoint (see FORK 1)
 *   3. Health status poll                     → folded into GET /health
 *   4. Routed GitHub delivery (T-C, #168)     → POST /deliveries — CONDITIONAL, only if T-C picks "push"
 *
 * ── RATIFIED 2026-07-18 (Aaron) ──────────────────────────────────────────────────────────────
 *   FORK 1 → A: config is NOT a bridge endpoint. Provisioner writes config.json (and creds,
 *              incl. BYO model OAuth) into the tenant volume before boot; reconfig = rewrite +
 *              Dokploy restart (creds persist, no re-pair). Live hot-reload stays deferred as #179.
 *   FORK 2 → A: /health stays UNAUTHENTICATED + QR-free; a separate HMAC-authed GET /pairing
 *              carries the QR. Trust levels split; the local probe (runtime-health.ts:54) is untouched.
 *   NOTE 3 → apply: rename the health token to `runtimeId`; reserve `githubInstallationId` for the
 *              GitHub install id that routes deliveries (T-C). Two ids, two names.
 *
 *  So the tenant HTTP bridge is EXACTLY: GET /health (unauth) + GET /pairing (authed)
 *  + [POST /deliveries — only if T-C #168 picks "push"]. Nothing else.
 */

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SHARED CONTRACT — the only thing both planes import. Lives in a package both can reach
// (e.g. packages/installation/src/bridge-contract.ts), imported by the tenant route AND the
// control-plane client, so the wire shape can never drift between them.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Coarse liveness — UNAUTHENTICATED. Dokploy healthcheck + the dashboard's "is it up?" dot. */
export interface BridgeHealth {
  readonly ok: boolean;
  /** Runtime correlation token = runtimeInstallationId(webhookSecret). NOT the GitHub install id. See NOTE 3. */
  readonly runtimeId: string;
  readonly state: "stopped" | "starting" | "healthy" | "failed";
  /** `pairing` is a NEW phase (see the whatsapp-runtime patch sketch): creds absent, QR is live. */
  readonly whatsapp: "disabled" | "starting" | "pairing" | "online" | "failed" | "stopped";
}

/** The QR/pairing payload — AUTHENTICATED, because a leaked QR is account takeover (§3, below). */
export type BridgePairing =
  | { readonly status: "pairing"; readonly method: "qr" | "pairing_code"; readonly qr?: string; readonly code?: string; readonly expiresAt: number }
  | { readonly status: "paired" }            // creds already present → nothing to scan
  | { readonly status: "not_pairing" };      // runtime not in a pairing window (starting/online/stopped)

/** Routed GitHub delivery (T-C #168, "push" branch only). Mirrors the raw webhook front door
 *  that `handleGitHubDelivery` (ingress-runtime.ts:34) consumes — same headers, plus routing. */
export interface BridgeDelivery {
  readonly githubEvent: string;           // X-GitHub-Event
  readonly githubDelivery: string;        // X-GitHub-Delivery (idempotency key)
  readonly githubInstallationId: number;  // the routing key the control plane matched on
  readonly payload: unknown;              // the raw delivery body, verified by the control plane
}

/** The bridge's authenticated methods and their purpose-bound HMAC label (reuses the smoke pattern,
 *  but purpose-bound + replay-safe rather than nonce-once, because these are polled). */
export const BRIDGE_AUTH_HEADER = "x-ambient-agent-bridge";
export type BridgePurpose = "pairing-read" | "delivery-push";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// TENANT SIDE — a Hono sub-app, mounted the same way installSmokeRoute is (app.ts:104).
//   routes: (routes) => { installSmokeRoute(...); installBridgeRoute(routes, { ... }); }
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { Hono } from "hono";
// import { runtimeBridgeAuthorizationMatches } from "@ambient-agent/installation/runtime-health.ts"; // NEW sibling of runtimeSmokeAuthorization

export interface BridgeRouteOptions {
  readonly webhookSecret: string;
  readonly runtimeId: string;
  /** Reads the live pairing/health snapshot the runtime captures (see whatsapp-runtime patch below). */
  readonly snapshot: () => { readonly health: BridgeHealth; readonly pairing: BridgePairing };
  /** T-C "push" only: hand a verified delivery to handleGitHubDelivery. Omit if T-C picks "pull". */
  readonly onDelivery?: (delivery: BridgeDelivery) => Promise<void>;
}

export const installBridgeRoute = (app: Hono, options: BridgeRouteOptions): void => {
  // FORK 2 (recommended): /health stays UNAUTHENTICATED and QR-free — it is the Dokploy
  // healthcheck and the coarse dashboard dot. Anyone on the Dokploy network may read liveness;
  // nobody reads the QR without the secret.
  app.get("/health", (c) => c.json(options.snapshot().health));

  // AUTHENTICATED. Purpose-bound HMAC (not nonce-once — the dashboard polls this every ~2s while
  // the QR is on screen). A leaked QR lets an attacker pair THEIR session, which trips
  // 440 connection_replaced → logged_out → the tenant's creds store is WIPED (§3). So it must be
  // behind the secret even though /health is not.
  app.get("/pairing", (c) => {
    // if (!runtimeBridgeAuthorizationMatches(c.req.header(BRIDGE_AUTH_HEADER), options.webhookSecret, "pairing-read"))
    //   return c.json({ error: "bridge authorization rejected" }, 403);
    return c.json(options.snapshot().pairing);
  });

  // T-C #168, "push" branch ONLY. Deferred: this handler exists iff T-C decides push. If T-C
  // picks pull, delete this block — deliveries arrive via libsql/queue, not this surface.
  if (options.onDelivery) {
    app.post("/deliveries", async (c) => {
      // if (!runtimeBridgeAuthorizationMatches(c.req.header(BRIDGE_AUTH_HEADER), options.webhookSecret, "delivery-push"))
      //   return c.json({ error: "bridge authorization rejected" }, 403);
      const body = (await c.req.json().catch(() => undefined)) as BridgeDelivery | undefined;
      if (!body?.githubDelivery) return c.json({ error: "invalid delivery" }, 400);
      await options.onDelivery!(body);           // idempotent on githubDelivery
      return c.json({ accepted: true }, 202);
    });
  }
};

/* whatsapp-runtime.ts PATCH SKETCH — capture the pairing payload instead of only rendering it.
 *
 *   onPairing: (pairing) => {
 *     setRuntimeStatus({ phase: "pairing", chatTarget: gate.describe(), pairing });  // NEW: carry it
 *     renderQr(pairing.qr);   // keep stdout for the self-hosted CLI path; SaaS reads it over HTTP
 *   },
 *
 * `WhatsAppRuntimeStatus` (runtime-health.ts:5) gains an optional `pairing?: PairingProgress`, and
 * the phase union gains "pairing". `snapshot()` maps that singleton → { health, pairing }. Blast
 * radius: one new phase + one optional field on an existing status object; `/health`'s public
 * shape only gains "pairing" to its enum. The unauthenticated local probe keeps working.
 */

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CONTROL-PLANE SIDE — how the provisioner (oRPC route) and dashboard CALL the bridge.
// The control plane holds tenant.webhookSecret + tenant.baseUrl (Dokploy-assigned). One client.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface TenantBridgeClient {
  readonly baseUrl: string;       // e.g. http://tenant-abc123.dokploy.internal:PORT (addressability = T-A)
  readonly webhookSecret: string; // minted at provision time; the bridge auth key
}

export const tenantBridge = (t: TenantBridgeClient) => ({
  // Dashboard "is my coworker up?" — no auth needed.
  health: async (): Promise<BridgeHealth> =>
    (await fetch(`${t.baseUrl}/health`)).json() as Promise<BridgeHealth>,

  // Dashboard pairing screen: poll until status flips pairing → paired, rendering `qr` each tick.
  pairing: async (): Promise<BridgePairing> =>
    (await fetch(`${t.baseUrl}/pairing`, {
      headers: { [BRIDGE_AUTH_HEADER]: /* runtimeBridgeAuthorization(t.webhookSecret, "pairing-read") */ "" },
    })).json() as Promise<BridgePairing>,

  // T-C "push" only. The central webhook router calls this after matching githubInstallationId → tenant.
  deliver: async (d: BridgeDelivery): Promise<void> => {
    await fetch(`${t.baseUrl}/deliveries`, {
      method: "POST",
      headers: { "content-type": "application/json", [BRIDGE_AUTH_HEADER]: /* ...(secret, "delivery-push") */ "" },
      body: JSON.stringify(d),
    });
  },
});

/* ── FORK 1 — Is config a bridge endpoint, or a file written before boot? ────────────────────────
 *
 * The ticket lists "control-plane-written config (managedChats, githubInstallationId, repos)" as a
 * bridge facet. But config is ALREADY file-based and read ONCE at boot:
 *   readManagedConfig(path) / atomicWriteManagedConfig(path, value)  — configuration.ts:37-43
 *   getManagedRuntimeDependencies() reads it once                    — runtime-dependencies.ts:27
 *   makeManagedChatGate(options.managedChats) bakes it in at start   — whatsapp-runtime.ts:219
 *
 *   OPTION A (recommended) — config is NOT on the bridge.
 *     Provisioner writes config.json into the tenant volume via the Dokploy API BEFORE start
 *     (reuse atomicWriteManagedConfig). Reconfig (new managedChats / repos) = rewrite + Dokploy
 *     restart. Restart is cheap and SAFE: creds persist, no re-pair (§2/#63) — straight back to online.
 *     · floor-first: ships the real thing with zero new tenant code.
 *     · blast radius: none inside the tenant; lives entirely in the provisioner (T-D).
 *     · reversibility: trivial — it's a file.
 *     · cost: a chat-approval (T-E) triggers a ~seconds restart. Acceptable at single-container MVP scale.
 *
 *   OPTION B — POST /config on the bridge, live reconfig without restart.
 *     · needs the runtime to re-read config AND re-wire the managed-chat gate, which is baked in at
 *       boot (whatsapp-runtime.ts:219). New mutable-state path, new failure modes.
 *     · blast radius: large — touches the gate, the inbox, the ingress settings, all live.
 *     · only earns its keep if per-chat reconfig-without-restart is an MVP requirement. It isn't.
 *
 *   → RECOMMEND A. The HTTP bridge shrinks to pairing + health (+ conditional delivery). Config
 *     rides the same channel the provisioner already uses to write creds (§4, "already file-based").
 *
 * ── NOTE 3 — the "installationId" collision (name it apart before T-C builds the router) ────────
 *
 *   /health today returns `installationId = runtimeInstallationId(webhookSecret)` (app.ts:60,98) —
 *   a hash of the webhook secret, a RUNTIME correlation token. But SAAS-MVP-PLAN §9 routes GitHub
 *   deliveries by the GITHUB `installation.id`. Two different ids, same word. This stub renames the
 *   health one to `runtimeId` and the delivery/config one to `githubInstallationId` so T-C's router
 *   (#168) and the config write (FORK 1) can't confuse them. Not a fork — just a rename to lock in now.
 */
