import { expect, test } from "bun:test";
import { memoryBackend } from "whatsappd";
import { createTestWhatsAppSession } from "whatsappd/testing";
import { whatsAppActions } from "../whatsapp/actions/ids";
import { createAmbientRuntime } from "./create-runtime";

test("the semantic runtime exposes actions without mounting a terminal", async () => {
  const driver = createTestWhatsAppSession();
  const runtime = createAmbientRuntime(
    {
      accountId: "headless-runtime",
      createBackend: () => memoryBackend(),
      openSession: () => driver.session,
    },
    { viewport: { width: 100, height: 32 } },
  );

  try {
    expect(runtime.tui.actions.catalogue().map((action) => action.id)).toContain(
      whatsAppActions.connect,
    );

    const connected = await runtime.tui.invokeId(
      whatsAppActions.connect,
      {},
      {
        actor: { kind: "agent", id: "headless-proof" },
        source: "agent",
      },
    );
    expect(connected.ok).toBe(true);
    expect(runtime.workbench.session.getSnapshot().attachment).toBe("attached");
    expect(runtime.tui.actions.invocations()).toContainEqual(
      expect.objectContaining({
        actionId: whatsAppActions.connect,
        actor: { kind: "agent", id: "headless-proof" },
        source: "agent",
        outcome: "success",
      }),
    );
  } finally {
    await runtime.dispose();
    await runtime.dispose();
  }
});
