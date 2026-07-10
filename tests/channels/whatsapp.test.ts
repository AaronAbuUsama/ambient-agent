import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "eve/channels";
import type { SidecarEvent, WireMessage } from "whatsappd/sidecar";

const ENV_KEYS = [
  "WHATSAPP_GROUP_ID",
  "WHATSAPP_BOT_TRIGGER",
  "WHATSAPP_ALLOW_DM",
  "WHATSAPP_SIDECAR_URL",
  "WHATSAPP_SIDECAR_TOKEN",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

function wireText(text: string, over: Partial<WireMessage> = {}): WireMessage {
  return {
    id: "M1",
    chatId: "GROUP1@g.us",
    from: "111@s.whatsapp.net",
    pushName: "Ann",
    fromMe: false,
    timestamp: 1_700_000_000,
    isGroup: true,
    kind: "text",
    text,
    ...over,
  } as WireMessage;
}

function messageEvent(message: WireMessage, over: Partial<Extract<SidecarEvent, { type: "message" }>> = {}) {
  return {
    type: "message" as const,
    accountId: "acc",
    chatId: message.chatId,
    isGroup: message.isGroup,
    from: message.from,
    pushName: message.pushName,
    message,
    ...over,
  };
}

describe("isAddressed", () => {
  let envSnapshot: Record<string, string | undefined>;

  beforeEach(() => {
    envSnapshot = snapshotEnv();
    vi.resetModules();
  });
  afterEach(() => restoreEnv(envSnapshot));

  it("ignores a group message without the trigger", async () => {
    process.env.WHATSAPP_GROUP_ID = "GROUP1@g.us";
    const { isAddressed } = await import("../../agent/channels/whatsapp.ts");
    expect(isAddressed(messageEvent(wireText("what time is standup?")))).toBe(false);
  });

  it("addresses a group message that contains the default trigger, case-insensitively", async () => {
    process.env.WHATSAPP_GROUP_ID = "GROUP1@g.us";
    const { isAddressed } = await import("../../agent/channels/whatsapp.ts");
    expect(isAddressed(messageEvent(wireText("Hey @GitHub-Bot open an issue: it crashes")))).toBe(true);
  });

  it("respects a custom trigger word", async () => {
    process.env.WHATSAPP_GROUP_ID = "GROUP1@g.us";
    process.env.WHATSAPP_BOT_TRIGGER = "!gh";
    const { isAddressed } = await import("../../agent/channels/whatsapp.ts");
    expect(isAddressed(messageEvent(wireText("!gh list open issues")))).toBe(true);
    expect(isAddressed(messageEvent(wireText("@github-bot list open issues")))).toBe(false);
  });

  it("ignores messages from a different group when WHATSAPP_GROUP_ID is set", async () => {
    process.env.WHATSAPP_GROUP_ID = "GROUP1@g.us";
    const { isAddressed } = await import("../../agent/channels/whatsapp.ts");
    const otherGroup = wireText("@github-bot hi", { chatId: "OTHER@g.us" });
    expect(isAddressed(messageEvent(otherGroup))).toBe(false);
  });

  it("allows any group when WHATSAPP_GROUP_ID is unset, still gated by the trigger", async () => {
    delete process.env.WHATSAPP_GROUP_ID;
    const { isAddressed } = await import("../../agent/channels/whatsapp.ts");
    expect(isAddressed(messageEvent(wireText("@github-bot hi")))).toBe(true);
    expect(isAddressed(messageEvent(wireText("hi")))).toBe(false);
  });

  it("ignores direct messages by default, even with the trigger", async () => {
    const { isAddressed } = await import("../../agent/channels/whatsapp.ts");
    const dm = wireText("@github-bot open an issue", { chatId: "111@s.whatsapp.net", isGroup: false });
    expect(isAddressed(messageEvent(dm))).toBe(false);
  });

  it("allows direct messages with the trigger when WHATSAPP_ALLOW_DM=true", async () => {
    process.env.WHATSAPP_ALLOW_DM = "true";
    const { isAddressed } = await import("../../agent/channels/whatsapp.ts");
    const dm = wireText("@github-bot open an issue", { chatId: "111@s.whatsapp.net", isGroup: false });
    expect(isAddressed(messageEvent(dm))).toBe(true);
  });

  it("does not address non-text kinds with no caption", async () => {
    const { isAddressed } = await import("../../agent/channels/whatsapp.ts");
    const sticker = wireText("", { kind: "sticker", media: {}, text: undefined });
    expect(isAddressed(messageEvent(sticker))).toBe(false);
  });
});

describe("createGatedEventRoute", () => {
  let envSnapshot: Record<string, string | undefined>;

  beforeEach(() => {
    envSnapshot = snapshotEnv();
    process.env.WHATSAPP_GROUP_ID = "GROUP1@g.us";
    vi.resetModules();
  });
  afterEach(() => restoreEnv(envSnapshot));

  function postReq(body: unknown, token?: string): Request {
    return new Request("http://app.local/event", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body),
    });
  }

  function fakeSend() {
    const calls: { input: unknown; options: Record<string, unknown> }[] = [];
    const send = async (input: unknown, options: unknown): Promise<Session> => {
      calls.push({ input, options: options as Record<string, unknown> });
      return {
        id: "SESSION1",
        continuationToken: "whatsapp:GROUP1@g.us",
        getEventStream: () => Promise.reject(new Error("not used")),
      };
    };
    return { calls, send };
  }

  it("starts a session for an addressed group message", async () => {
    const { createGatedEventRoute } = await import("../../agent/channels/whatsapp.ts");
    const { calls, send } = fakeSend();
    const route = createGatedEventRoute();

    const res = await route(
      postReq(messageEvent(wireText("@github-bot list open issues"))),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { send } as any,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionId: "SESSION1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.continuationToken).toBe("GROUP1@g.us");
  });

  it("drops an unaddressed group message without starting a session", async () => {
    const { createGatedEventRoute } = await import("../../agent/channels/whatsapp.ts");
    const { calls, send } = fakeSend();
    const route = createGatedEventRoute();

    const res = await route(
      postReq(messageEvent(wireText("anyone up for lunch?"))),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { send } as any,
    );

    expect(await res.json()).toEqual({ ignored: true, reason: "not addressed" });
    expect(calls).toHaveLength(0);
  });

  it("rejects unauthenticated requests when a sidecar token is configured", async () => {
    process.env.WHATSAPP_SIDECAR_TOKEN = "s3cret";
    const { createGatedEventRoute } = await import("../../agent/channels/whatsapp.ts");
    const { calls, send } = fakeSend();
    const route = createGatedEventRoute();

    const denied = await route(
      postReq(messageEvent(wireText("@github-bot hi"))),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { send } as any,
    );
    expect(denied.status).toBe(401);

    const allowed = await route(
      postReq(messageEvent(wireText("@github-bot hi")), "s3cret"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { send } as any,
    );
    expect(allowed.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("ignores non-message events and the bot's own messages", async () => {
    const { createGatedEventRoute } = await import("../../agent/channels/whatsapp.ts");
    const { calls, send } = fakeSend();
    const route = createGatedEventRoute();

    const status = await route(
      postReq({ type: "status", accountId: "acc", status: { phase: "online" } }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { send } as any,
    );
    expect(await status.json()).toEqual({ ignored: true });

    const fromMe = await route(
      postReq(messageEvent(wireText("@github-bot hi", { fromMe: true }))),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { send } as any,
    );
    expect(await fromMe.json()).toEqual({ ignored: true });
    expect(calls).toHaveLength(0);
  });
});
