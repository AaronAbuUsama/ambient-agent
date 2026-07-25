# Spike #370 — browser-driven WhatsApp pairing and ChatGPT device authorization

**Throwaway.** The reducer in `setup-flow.ts` is the part worth lifting; `tui.ts` is a shell for driving it by hand.

```
pnpm spike:370
```

## The question

Can the two irreducibly interactive parts of first-run setup be driven through a browser, and what shape must the server-side contract have?

## What the code already says

The callback seams are **already transport-agnostic** — they carry plain data, not terminal handles:

| Seam | Where |
|---|---|
| `PairingCallbacks.onPairing(progress)` | `packages/installation/src/whatsapp-account.ts:43-46` |
| `DeviceCodeCallbacks.onDeviceCode(info)` | `packages/engine/src/model/chatgpt-authentication.ts:38-41` |

The terminal coupling lives in the *implementations*, and one of them is in the wrong process:

- `apps/cli/src/prompts.ts:154-173` — CLI implementations. Fine; that is the CLI's job.
- `apps/runtime/src/host/whatsapp-runtime.ts:479-485` — **the runtime itself calls `renderQr()` and `process.stdout.write()`**. That is the process destined to become the control plane, and it is writing pairing UX to a terminal that will not exist.

So "add a seam" is not the work. The seam exists. The work is a second implementation plus deleting the runtime's direct terminal writes.

## The actual hard part

Those callbacks are **push-only and fire-and-forget**. A terminal is always attached; a browser page is not. It can connect late, and it can be closed and reopened mid-pair. A push-only callback has nothing to give a late subscriber — the QR was emitted to nobody, and the page renders blank against a live pairing session.

Hence the model here: **retained state + subscription**, not an event stream. Every observer gets `snapshot()` on connect, then deltas.

## Properties the spike checks

1. **QR rotation does not reset the flow** — `rotations` increments, the page swaps the image in place.
2. **A late joiner needs no replay** — `snapshot()` alone is sufficient to render correctly.
3. **Closing the page does not abort pairing** — observer churn deliberately does not advance `revision`; `hasWorkInFlight()` stays true at zero observers.
4. **Expiry without rotation is a distinct failure** — a dead transport is not silently indistinguishable from a slow user.

## Note: this is the same nest as #373

#373 found that liveness broke because the runtime held a cached belief and never reconciled it with the live signal — `session.status` never read, `onStatus` torn down after auth. This is the same class one layer up: a push-only callback with no retained state, so any observer that was not listening at emit time cannot learn the truth.

Same fix shape both times: **hold the current value, expose it for pull, and keep one long-lived subscription for push.** Two confirmed instances make this a nest worth naming before the build starts, not three separate patches.
