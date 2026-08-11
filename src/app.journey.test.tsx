import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { driveHeadlessTui, type HeadlessTuiJourney } from "agentic-tui-kit/testing";
import jsQR from "jsqr";
import { memoryBackend } from "whatsappd";
import { createTestWhatsAppSession, textMessage } from "whatsappd/testing";
import { createWhatsAppWorkbench, type WhatsAppWorkbench } from "./app/create-workbench";
import { rasterizeQrRows } from "../test/support/qr-raster";
import { qrRowsFromFrame } from "../test/support/screen-qr";

const viewport = { width: 120, height: 44 };
const agent = { actor: { kind: "agent", id: "journey" }, source: "test" } as const;
const alice = "15550001111@s.whatsapp.net";
const bob = "15550002222@s.whatsapp.net";
const artifacts = process.env.JOURNEY_ARTIFACT_DIR ?? "artifacts/journey";

/** A pairing challenge shaped exactly as `whatsappd` reports one. */
const pairingChallenge = {
  phase: "pairing",
  pairing: {
    step: "challenge_live",
    method: "qr",
    qr: "2@JourneyProofPayload/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/==,KeyOne+/==,KeyTwo+/==,1",
    expiresAt: Date.now() + 20_000,
  },
} as const;

function launch(): {
  workbench: WhatsAppWorkbench;
  driver: ReturnType<typeof createTestWhatsAppSession>;
} {
  const driver = createTestWhatsAppSession({
    identity: {
      jid: "15559990000:7@s.whatsapp.net",
      pushName: "Journey",
      phoneE164: "+15559990000",
    },
  });
  const backend = memoryBackend();
  const workbench = createWhatsAppWorkbench({
    accountId: "journey",
    createBackend: () => backend,
    openSession: () => driver.session,
  });
  return { workbench, driver };
}

async function open(workbench: WhatsAppWorkbench): Promise<HeadlessTuiJourney> {
  return driveHeadlessTui(workbench.app, { ...workbench.runtimeOptions, viewport });
}

test("the workbench pairs, syncs, opens a chat and sends — one action path throughout", async () => {
  const { workbench, driver } = launch();
  const tui = await open(workbench);
  await mkdir(artifacts, { recursive: true });

  try {
    // The connection screen is the landing view, before anything is claimed.
    await tui.expect.text("WHATSAPP");
    await tui.expect.text("CONNECTION");
    await tui.expect.text("not linked yet");

    // An agent connects through the same action the [c] control reaches.
    const connected = await tui.invoke(workbench.whatsapp.actions.connect, {}, agent);
    expect(connected.ok).toBe(true);
    expect(workbench.session.getSnapshot().attachment).toBe("attached");

    // WhatsApp offers a pairing challenge: the QR must be on screen, drawn in
    // half blocks, with the instruction a human needs to act on it.
    await driver.emit({ type: "connection", status: pairingChallenge });
    await tui.expect.text("scan to link");
    const pairingScreen = await tui.expect.text("Scan with WhatsApp");
    // Decode what is actually on screen. Asserting the payload survives a real
    // QR decoder is the difference between "a QR is drawn" and "a phone can
    // read this one" — the whole point of the pairing view.
    const drawn = qrRowsFromFrame(pairingScreen);
    expect(drawn).not.toBeNull();
    const raster = rasterizeQrRows(drawn!);
    const scanned = jsQR(raster.data, raster.width, raster.height);
    expect(scanned?.data).toBe(pairingChallenge.pairing.qr);

    await tui.screenshot(join(artifacts, "01-pairing.png"));

    // The phone accepts, the socket comes up, and history arrives.
    await driver.emit({ type: "connection", status: { phase: "online" } });
    await tui.expect.text("online");
    await tui.expect.text("Journey");
    await tui.screenshot(join(artifacts, "02-connected.png"));

    await driver.emit({
      type: "message",
      message: textMessage({ id: "m1", chatId: alice, text: "are we still on for friday?" }),
    });
    await driver.emit({
      type: "message",
      message: textMessage({ id: "m2", chatId: bob, text: "shipped the build" }),
    });

    // Two chats plus the settings row is what brings the sidebar out.
    await tui.expect.text("CHATS");
    await tui.expect.text("⚙ Settings");
    await tui.screenshot(join(artifacts, "03-chats.png"));

    // Keyboard navigation: focus the sidebar, walk to a chat, open it.
    await tui.key("left");
    await tui.key("down");
    await tui.key("enter");
    await tui.expect.text("are we still on for friday?");
    await tui.screenshot(join(artifacts, "04-chat.png"));

    // The composer sends through whatsapp.send, which reaches the session.
    await tui.key("i");
    await tui.text("friday works");
    await tui.key("enter");
    await tui.expect.text("friday works");

    await new Promise((resolve) => setTimeout(resolve, 50));
    const sent = driver.commands.sent;
    expect(sent).toContainEqual(
      expect.objectContaining({ to: alice, content: { text: "friday works" } }),
    );
    await tui.screenshot(join(artifacts, "05-sent.png"));
    await tui.recording(join(artifacts, "journey.mp4"));

    // Every visible control and every agent call landed on the same actions.
    const invocations = tui.runtime.actions.invocations();
    expect(invocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionId: "whatsapp.connect",
          source: "test",
          outcome: "success",
        }),
        expect.objectContaining({
          actionId: "whatsapp.open-chat",
          source: "keyboard",
          outcome: "success",
        }),
        expect.objectContaining({
          actionId: "whatsapp.send",
          source: "keyboard",
          outcome: "success",
        }),
      ]),
    );
  } finally {
    await tui.finish();
    await workbench.session.dispose();
  }
}, 30_000);

test("disconnecting releases the account and sending is refused while detached", async () => {
  const { workbench, driver } = launch();
  const tui = await open(workbench);

  try {
    await tui.invoke(workbench.whatsapp.actions.connect, {}, agent);
    await driver.emit({ type: "connection", status: { phase: "online" } });
    await tui.expect.text("online");

    const disconnected = await tui.invoke(workbench.whatsapp.actions.disconnect, {}, agent);
    expect(disconnected.ok).toBe(true);
    expect(workbench.session.getSnapshot().attachment).toBe("detached");
    await tui.expect.text("offline");

    const refused = await tui.invoke(
      workbench.whatsapp.actions.send,
      { chatId: alice, text: "x" },
      agent,
    );
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error.code).toBe("unavailable");
  } finally {
    await tui.finish();
    await workbench.session.dispose();
  }
}, 30_000);
