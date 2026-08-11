import { defineAction } from "agentic-tui-kit";
import { z } from "zod";
import type { WhatsAppSessionController } from "../session/controller";
import { statusLabel } from "../tui/presentation";
import { whatsAppActions } from "./ids";
import { attachmentReceiptSchema } from "./types";

export function defineConnectionActions(session: WhatsAppSessionController) {
  const receipt = () => {
    const { attachment, status } = session.getSnapshot();
    return { attachment, status: statusLabel(status) };
  };

  const connect = defineAction({
    id: whatsAppActions.connect,
    title: "Connect WhatsApp",
    group: "WhatsApp",
    description:
      "Claim the account, open the WhatsApp session, and follow it. Shows a pairing QR when no linked credentials are stored.",
    inputSchema: z.object({}),
    outputSchema: attachmentReceiptSchema,
    sideEffect: "external-write",
    paletteEntries: [{ title: "Connect WhatsApp", input: {} }],
    available: () =>
      session.getSnapshot().attachment === "detached" || "already connecting or connected",
    execute: async () => {
      await session.attach();
      return receipt();
    },
  });

  const disconnect = defineAction({
    id: whatsAppActions.disconnect,
    title: "Disconnect WhatsApp",
    group: "WhatsApp",
    description: "Close the session and release the account, keeping stored credentials.",
    inputSchema: z.object({}),
    outputSchema: attachmentReceiptSchema,
    sideEffect: "external-write",
    paletteEntries: [{ title: "Disconnect WhatsApp", input: {} }],
    available: () => session.getSnapshot().attachment !== "detached" || "already disconnected",
    execute: async () => {
      await session.detach();
      return receipt();
    },
  });

  const reconnect = defineAction({
    id: whatsAppActions.reconnect,
    title: "Reconnect WhatsApp",
    group: "WhatsApp",
    description: "Release the account and claim it again with a fresh session.",
    inputSchema: z.object({}),
    outputSchema: attachmentReceiptSchema,
    sideEffect: "external-write",
    paletteEntries: [{ title: "Reconnect WhatsApp", input: {} }],
    execute: async () => {
      await session.detach();
      await session.attach();
      return receipt();
    },
  });

  const unlink = defineAction({
    id: whatsAppActions.unlink,
    title: "Unlink this device",
    group: "WhatsApp",
    description:
      "Disconnect and erase stored credentials so the next connection pairs a new device. The phone still lists the old device until it is removed there.",
    inputSchema: z.object({}),
    outputSchema: z.object({ unlinked: z.literal(true) }),
    sideEffect: "destructive",
    paletteEntries: [{ title: "Unlink this device", input: {} }],
    execute: async () => {
      await session.forget();
      return { unlinked: true as const };
    },
  });

  return { connect, disconnect, reconnect, unlink };
}
