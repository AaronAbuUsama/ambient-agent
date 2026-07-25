import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  observationSnapshot,
  observed,
  publishDeviceObservation,
  publishPairingProgress,
  publishPairingSettled,
  resetObservations,
  setupObservation,
  subscribeToAllObservations,
  transportObservation,
  whatsappObservation,
  type Observation,
} from "../../packages/installation/src/observation.ts";

beforeEach(() => {
  resetObservations();
});

/** A value that provably cannot pre-date this run, so "it was retained" cannot be confused with "it was already there". */
const nonce = () => randomBytes(8).toString("hex");

/**
 * How long the staleness tests wait for a ~20ms renewal deadline to elapse and be announced.
 *
 * `vi.waitFor` defaults to a 1s budget, which is not the deadline itself but the budget for a loaded
 * runner to get around to firing an unref'd `setTimeout` and running the poll. A full-suite Node 24
 * job exceeded it and turned "pushes the staleness transition to subscribers" red on `main` at
 * `7dd8750` — a scheduling delay, not a seam defect. Widened rather than made clock-dependent: these
 * assertions still fail if the transition is never announced, which is the whole point of them.
 *
 * Kept under vitest's 5s per-test timeout on purpose. Overshooting it would mean a genuine
 * regression surfaced as an opaque test timeout instead of the assertion that names what broke.
 */
const STALENESS_BUDGET_MS = 4_000;

describe("the retained-state observation seam", () => {
  it("gives a subscriber that attaches after the publication the current value, with no replay", () => {
    // The nest, in one test: the value is emitted while nobody is listening. A push-only callback
    // has nothing to give the observer that arrives second; a retained channel has everything.
    const channel = observed("late", { token: "initial" });
    const minted = nonce();
    channel.publish({ token: minted });

    const deltas: Observation<{ token: string }>[] = [];
    channel.subscribe((observation) => deltas.push(observation));

    expect(channel.snapshot().value).toEqual({ token: minted });
    expect(channel.snapshot().revision).toBe(1);
    // Nothing is re-emitted: the current value arrived by pull, not by a replayed event.
    expect(deltas).toEqual([]);
  });

  it("does not stop, block, or back up the producer when nobody is subscribed", () => {
    const channel = observed("unwatched", 0);

    for (let step = 1; step <= 1_000; step += 1) channel.publish(step);

    expect(channel.snapshot().value).toBe(1_000);
    expect(channel.snapshot().revision).toBe(1_000);
  });

  it("keeps the producer running when an observer throws", () => {
    const channel = observed("hostile", 0);
    channel.subscribe(() => {
      throw new Error("the browser went away mid-write");
    });
    const healthy = vi.fn();
    channel.subscribe(healthy);

    expect(() => channel.publish(1)).not.toThrow();
    expect(channel.snapshot().value).toBe(1);
    // A defective consumer must not cost a healthy one its delta either.
    expect(healthy).toHaveBeenCalledOnce();
  });

  it("recovers full current state when a subscriber disconnects and reconnects", () => {
    const channel = observed("reconnect", { step: "idle", detail: "" });
    const first: Observation<{ step: string; detail: string }>[] = [];
    const unsubscribe = channel.subscribe((observation) => first.push(observation));
    channel.publish({ step: "one", detail: "seen" });

    unsubscribe();
    // Two publications land while the client is away — the exact window a page is closed in.
    channel.publish({ step: "two", detail: "missed" });
    channel.publish({ step: "three", detail: "also missed" });
    const second: Observation<{ step: string; detail: string }>[] = [];
    channel.subscribe((observation) => second.push(observation));
    const recovered = channel.snapshot();

    expect(first).toHaveLength(1);
    // State is the whole value, not a fold over events, so one snapshot restores everything.
    expect(recovered.value).toEqual({ step: "three", detail: "also missed" });
    // The revision gap tells the client it missed publications without needing them replayed.
    expect(recovered.revision).toBe(3);
    expect(second).toEqual([]);
  });

  it("tells a value that went stale from one that is legitimately idle", async () => {
    const perishable = observed("perishable", "qr-1");
    const idle = observed("idle", "online");

    perishable.publish("qr-2", { freshUntil: Date.now() + 20 });
    idle.publish("online");

    expect(perishable.snapshot().stale).toBe(false);
    await vi.waitFor(() => expect(perishable.snapshot().stale).toBe(true), { timeout: STALENESS_BUDGET_MS });
    // No renewal deadline was promised, so nothing to break: a silent healthy socket is not stale.
    expect(idle.snapshot().stale).toBe(false);
    // Renewal clears it — rotation is health, not a restart.
    perishable.publish("qr-3", { freshUntil: Date.now() + 10_000 });
    expect(perishable.snapshot().stale).toBe(false);
  });

  it("pushes the staleness transition to subscribers, not only to readers", async () => {
    const channel = observed("unrenewed", "qr-1");
    const deltas: Observation<string>[] = [];
    channel.subscribe((observation) => deltas.push(observation));

    channel.publish("qr-2", { freshUntil: Date.now() + 20 });

    await vi.waitFor(() => expect(deltas.at(-1)?.stale).toBe(true), { timeout: STALENESS_BUDGET_MS });
    expect(deltas[0]?.stale).toBe(false);
  });

  it("projects a live source at read time instead of shadowing it with a cached copy", () => {
    let live = "connecting";
    const channel = observed("projected", { published: "starting", live: "" });
    channel.refreshWith((value) => ({ ...value, live }));
    channel.publish({ published: "online", live: "" });

    live = "backing_off";

    // Nothing was published in between, and the channel still reports the truth.
    expect(channel.snapshot().value).toEqual({ published: "online", live: "backing_off" });
    // Deltas carry the projection too, so push and pull can never disagree.
    const deltas: Observation<{ published: string; live: string }>[] = [];
    channel.subscribe((observation) => deltas.push(observation));
    live = "logged_out";
    channel.publish({ published: "online", live: "" });
    expect(deltas.at(-1)?.value).toEqual({ published: "online", live: "logged_out" });
  });

  it("delivers channels registered after a client attached", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeToAllObservations((observation) => seen.push(observation.channel));

    // The runtime boots after the control plane has already accepted clients, so its channels are
    // always late. A client must learn about them without reconnecting.
    const late = observed("appeared-later", "value");
    late.publish("changed");
    unsubscribe();
    observed("after-unsubscribe", "value").publish("ignored");

    expect(seen).toEqual(["appeared-later", "appeared-later"]);
  });

  it("collects every channel into one snapshot", () => {
    observed("alpha", 1).publish(2);
    observed("beta", "x");

    const snapshot = observationSnapshot();

    expect(Object.keys(snapshot).sort()).toEqual(["alpha", "beta"]);
    expect(snapshot.alpha?.value).toBe(2);
    expect(snapshot.beta?.value).toBe("x");
  });
});

describe("the channels the seam is consolidating", () => {
  it("retains rotating pairing material and counts rotations rather than restarting", () => {
    const expiresAt = Date.now() + 60_000;
    publishPairingProgress({ method: "qr", qr: "first", expiresAt });
    publishPairingProgress({ method: "qr", qr: "second", expiresAt: expiresAt + 20_000 });

    const pairing = setupObservation().snapshot().value.pairing;

    expect(pairing).toMatchObject({ kind: "awaiting_scan", qr: "second", rotations: 1 });
    // The client's own rotation deadline becomes the channel's renewal promise.
    expect(setupObservation().snapshot().freshUntil).toBe(expiresAt + 20_000);
  });

  it("retires pairing material once it settles, and never retracts a completed pairing", () => {
    publishPairingProgress({ method: "qr", qr: "live", expiresAt: Date.now() + 60_000 });
    publishPairingSettled({ jid: "15550000000@s.whatsapp.net" });

    const settled = setupObservation().snapshot();
    expect(settled.value.pairing).toEqual({ kind: "paired", jid: "15550000000@s.whatsapp.net" });
    // Settled carries no renewal promise, so it cannot rot the way live material does.
    expect(settled.freshUntil).toBeUndefined();
    expect(settled.stale).toBe(false);

    // A runtime that dies later is a transport failure, not a retraction of a pairing a page
    // already watched complete.
    publishPairingSettled({ reason: "the fiber died an hour later" });
    expect(setupObservation().snapshot().value.pairing).toMatchObject({ kind: "paired" });
  });

  it("reports a pairing that failed before it settled", () => {
    publishPairingProgress({ method: "qr", qr: "live", expiresAt: Date.now() + 60_000 });

    publishPairingSettled({ reason: "authentication ended in logged_out" });

    expect(setupObservation().snapshot().value.pairing).toEqual({
      kind: "failed",
      reason: "authentication ended in logged_out",
    });
  });

  it("makes a device code perishable and a completed authorization idle", () => {
    publishDeviceObservation({
      kind: "awaiting_authorization",
      userCode: "ABCD-EFGH",
      verificationUri: "https://example.test/device",
      expiresAt: Date.now() + 900_000,
    });
    expect(setupObservation().snapshot().freshUntil).toBeGreaterThan(Date.now());

    publishDeviceObservation({ kind: "complete" });

    expect(setupObservation().snapshot().value.device).toEqual({ kind: "complete" });
    expect(setupObservation().snapshot().freshUntil).toBeUndefined();
    // The two sub-states share one channel and must not clobber each other.
    expect(setupObservation().snapshot().value.pairing).toEqual({ kind: "idle" });
  });

  it("carries the transport's fault reason and never its pairing material", () => {
    // The whatsapp channel is read by health consumers, so the QR must not ride on it — pairing
    // material travels on the setup channel, which exists to carry it.
    const projected = transportObservation({
      phase: "backing_off",
      reason: "connection_replaced",
      retryAttempt: 3,
      nextRetryAt: 1_700_000_000_000,
    } as never);

    expect(projected).toEqual({
      phase: "backing_off",
      reason: "connection_replaced",
      retryAttempt: 3,
      nextRetryAt: 1_700_000_000_000,
    });
    expect(transportObservation({ phase: "pairing", pairing: { qr: "secret" } } as never)).toEqual({
      phase: "pairing",
    });
  });

  it("starts liveness at disabled rather than at nothing", () => {
    expect(whatsappObservation().snapshot().value).toEqual({ status: { phase: "disabled" } });
    expect(whatsappObservation().snapshot().stale).toBe(false);
  });
});
