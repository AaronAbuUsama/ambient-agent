import { describe, expect, it } from "vite-plus/test";

import { makeManagedChatGate } from "../../packages/engine/src/coalescer/chat-gate.ts";

describe("typed managed chat gate", () => {
  it("admits only exact configured group and direct-chat JIDs", () => {
    const gate = makeManagedChatGate(["GROUP@G.US", "15551234567@s.whatsapp.net"]);

    expect(gate.allowed("group@g.us", true)).toBe(true);
    expect(gate.allowed("15551234567@s.whatsapp.net", false)).toBe(true);
    expect(gate.allowed("other@g.us", true)).toBe(false);
    expect(gate.allowed("15550000000@s.whatsapp.net", false)).toBe(false);
  });

  it("keeps an unknown person's inbound DM out of participation (S5 negative — observation never grants it)", () => {
    // Only the group is operator-authorized; no direct chat is configured. A stranger's DM (like the real
    // archived `204663831932940@lid`) is archived elsewhere but never reaches the loop — S5 opens a DM
    // Surface only when the Brain deliberately targets a KNOWN Person, never from an observed inbound DM.
    const gate = makeManagedChatGate(["GROUP@G.US"]);
    expect(gate.allowed("204663831932940@lid", false)).toBe(false);
  });
});
