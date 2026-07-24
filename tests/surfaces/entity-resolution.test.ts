import { describe, expect, it } from "vite-plus/test";

import {
  createGraphStore,
  type EntityUpsert,
  type GraphAttestationContext,
} from "../../packages/engine/src/graph/store.ts";
import { createSurfaceRegistry } from "../../packages/engine/src/surfaces/registry.ts";
import { resolveEntitySurface } from "../../apps/runtime/src/host/whatsapp-runtime.ts";

const ACCOUNT = "15550000000:7@s.whatsapp.net";
const GROUP = "team@g.us";
const PERSON_DM = "204663831932940@lid"; // the real archived DM from §13, never configured as a chat.
const CONTEXT: GraphAttestationContext = { author: { kind: "brain", id: "brain" }, evidenceIds: ["test:resolution"] };

const attestEntity = (store: ReturnType<typeof createGraphStore>, input: EntityUpsert): string => {
  const result = store.attest({ context: CONTEXT, claim: { kind: "entity", input } });
  if (result.kind !== "entity") throw new Error("Expected an Entity Attestation.");
  return result.entity.entityId;
};

describe("resolveEntitySurface — one prompt operation for group reply and known-Person DM (S5)", () => {
  it("resolves a configured group thread to its existing Surface and opens a known person's DM Surface", () => {
    const store = createGraphStore(":memory:");
    const surfaces = createSurfaceRegistry(":memory:");
    // Only the group is operator-authorized; the DM chat is not configured.
    const [groupSurface] = surfaces.activateConfigured(ACCOUNT, [GROUP]);

    const threadId = attestEntity(store, {
      type: "thread",
      properties: { chatId: GROUP },
      identity: { platform: "whatsapp", externalId: GROUP },
    });
    const personId = attestEntity(store, {
      type: "person",
      properties: { name: "Aaron" },
      identity: { platform: "whatsapp", externalId: PERSON_DM },
    });

    const deps = { graph: store, surfaces, accountJid: ACCOUNT };

    // Group reply: resolves to the pre-existing operator-authorized Surface.
    expect(resolveEntitySurface(deps, threadId)).toBe(groupSurface!.id);

    // Known-person DM: opens a distinct Surface on demand (find-or-create), idempotent on repeat.
    const dmSurface = resolveEntitySurface(deps, personId);
    expect(dmSurface).toBeDefined();
    expect(dmSurface).not.toBe(groupSurface!.id);
    expect(resolveEntitySurface(deps, personId)).toBe(dmSurface);
    expect(surfaces.activeBinding(dmSurface!)?.providerChatId).toBe(PERSON_DM);

    // Opening the DM never retired the configured group binding.
    expect(surfaces.activeSurface(ACCOUNT, GROUP)?.id).toBe(groupSurface!.id);

    store.close();
    surfaces.close();
  });

  it("fails closed for an unknown entity, a non-addressable entity, and a discovered (unconfigured) group", () => {
    const store = createGraphStore(":memory:");
    const surfaces = createSurfaceRegistry(":memory:");
    surfaces.activateConfigured(ACCOUNT, [GROUP]);
    const deps = { graph: store, surfaces, accountJid: ACCOUNT };

    // Unknown entity id — nothing in the Graph.
    expect(resolveEntitySurface(deps, "person:never-met")).toBeUndefined();

    // A person known only on GitHub has no WhatsApp identity → not a WhatsApp Surface.
    const githubOnly = attestEntity(store, {
      type: "person",
      properties: {},
      identity: { platform: "github", externalId: "octocat" },
    });
    expect(resolveEntitySurface(deps, githubOnly)).toBeUndefined();

    // A non-addressable type (a topic) resolves to nothing.
    const topic = attestEntity(store, { type: "topic", properties: { label: "release cadence" } });
    expect(resolveEntitySurface(deps, topic)).toBeUndefined();

    // A discovered group thread whose chat was never configured is NOT openable — discovery never grants
    // participation (unlike a known person, a thread resolves only to an already-active Surface).
    const strangerThread = attestEntity(store, {
      type: "thread",
      properties: { chatId: "stranger@g.us" },
      identity: { platform: "whatsapp", externalId: "stranger@g.us" },
    });
    expect(resolveEntitySurface(deps, strangerThread)).toBeUndefined();
    expect(surfaces.activeSurface(ACCOUNT, "stranger@g.us")).toBeUndefined();

    store.close();
    surfaces.close();
  });
});
