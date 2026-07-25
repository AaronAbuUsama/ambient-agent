/**
 * SPIKE #370 — throwaway. Not production code.
 *
 * QUESTION
 * Can WhatsApp QR pairing and the ChatGPT device-authorization flow be driven through a browser,
 * and what shape must the server-side contract have?
 *
 * The existing callback seams (`PairingCallbacks.onPairing`, `DeviceCodeCallbacks.onDeviceCode`)
 * are already transport-agnostic — they take plain data, not terminal handles. The coupling to a
 * terminal lives in the *implementations*: `apps/cli/src/prompts.ts` and, more importantly,
 * `apps/runtime/src/host/whatsapp-runtime.ts:479-485`, which calls `renderQr()` directly from the
 * process that is meant to become the control plane.
 *
 * So the seam is not the hard part. The hard part is that those callbacks are PUSH-ONLY and
 * fire-and-forget. A browser page is not a terminal: it can connect late, and it can be closed and
 * reopened halfway through pairing. A push-only callback has nothing to give a late subscriber —
 * the QR was emitted to nobody and the page renders a blank screen against a live pairing session.
 *
 * This module therefore models the flow as RETAINED STATE + SUBSCRIPTION, not as an event stream:
 * every observer gets `snapshot()` on connect, then deltas. That is the same shape #373 landed on
 * for liveness (read the live getter, keep one long-lived subscription) — see the nest note in the
 * README.
 *
 * The reducer below is the part worth keeping. The TUI in `tui.ts` is throwaway.
 */

export type PairingState =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | { readonly kind: "awaiting_scan"; readonly qr: string; readonly expiresAt: number; readonly rotations: number }
  | { readonly kind: "paired"; readonly jid: string }
  | { readonly kind: "failed"; readonly reason: string };

export type DeviceState =
  | { readonly kind: "idle" }
  | { readonly kind: "awaiting_authorization"; readonly userCode: string; readonly verificationUri: string; readonly expiresAt: number }
  | { readonly kind: "complete" }
  | { readonly kind: "failed"; readonly reason: string };

export interface SetupState {
  readonly pairing: PairingState;
  readonly device: DeviceState;
  /** Observers currently attached. The flow must be correct at zero. */
  readonly observers: number;
  /** Monotonic revision — an observer that reconnects sends its last seen revision. */
  readonly revision: number;
  readonly now: number;
}

export type SetupAction =
  | { readonly type: "start_pairing" }
  | { readonly type: "qr_issued"; readonly qr: string; readonly ttlMs: number }
  | { readonly type: "paired"; readonly jid: string }
  | { readonly type: "pair_failed"; readonly reason: string }
  | { readonly type: "start_device" }
  | { readonly type: "device_code"; readonly userCode: string; readonly verificationUri: string; readonly ttlMs: number }
  | { readonly type: "device_authorized" }
  | { readonly type: "device_failed"; readonly reason: string }
  | { readonly type: "observer_attached" }
  | { readonly type: "observer_detached" }
  | { readonly type: "tick"; readonly ms: number };

export const initialState: SetupState = {
  pairing: { kind: "idle" },
  device: { kind: "idle" },
  observers: 0,
  revision: 0,
  now: 0,
};

const expire = (state: SetupState): SetupState => {
  let pairing = state.pairing;
  let device = state.device;
  // An expired QR is NOT a failure: the client rotates it. Expiry with no rotation means the
  // transport died, which is a different thing and must be visible as such.
  if (pairing.kind === "awaiting_scan" && state.now > pairing.expiresAt) {
    pairing = { kind: "failed", reason: "qr expired without rotation — client is not producing codes" };
  }
  if (device.kind === "awaiting_authorization" && state.now > device.expiresAt) {
    device = { kind: "failed", reason: "device code expired" };
  }
  return pairing === state.pairing && device === state.device ? state : { ...state, pairing, device };
};

export const reduce = (state: SetupState, action: SetupAction): SetupState => {
  const bump = (next: Partial<SetupState>): SetupState => ({ ...state, ...next, revision: state.revision + 1 });

  switch (action.type) {
    case "start_pairing":
      return state.pairing.kind === "paired" ? state : bump({ pairing: { kind: "starting" } });

    case "qr_issued": {
      // Rotation must not reset the flow — the page swaps the image in place.
      const rotations = state.pairing.kind === "awaiting_scan" ? state.pairing.rotations + 1 : 0;
      return bump({
        pairing: { kind: "awaiting_scan", qr: action.qr, expiresAt: state.now + action.ttlMs, rotations },
      });
    }

    case "paired":
      return bump({ pairing: { kind: "paired", jid: action.jid } });

    case "pair_failed":
      return bump({ pairing: { kind: "failed", reason: action.reason } });

    case "start_device":
      return state.device.kind === "complete" ? state : bump({ device: { kind: "idle" } });

    case "device_code":
      return bump({
        device: {
          kind: "awaiting_authorization",
          userCode: action.userCode,
          verificationUri: action.verificationUri,
          expiresAt: state.now + action.ttlMs,
        },
      });

    case "device_authorized":
      return bump({ device: { kind: "complete" } });

    case "device_failed":
      return bump({ device: { kind: "failed", reason: action.reason } });

    // Observer churn does NOT advance revision: the flow is indifferent to who is watching.
    // This is the property the spike exists to check — closing the page must not abort pairing.
    case "observer_attached":
      return { ...state, observers: state.observers + 1 };

    case "observer_detached":
      return { ...state, observers: Math.max(0, state.observers - 1) };

    case "tick":
      return expire({ ...state, now: state.now + action.ms });
  }
};

/** What a page receives on connect. Proves a late joiner needs no replay of past events. */
export const snapshot = (state: SetupState): SetupState => state;

/** True when the server still has work in flight that a closed page must not cancel. */
export const hasWorkInFlight = (state: SetupState): boolean =>
  state.pairing.kind === "starting" ||
  state.pairing.kind === "awaiting_scan" ||
  state.device.kind === "awaiting_authorization";
