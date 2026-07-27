import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  acknowledgeWhatsAppTerminalReceipt,
  markWhatsAppTerminalReceiptAnnounced,
  pendingWhatsAppTerminalReceipt,
  persistWhatsAppTerminalReceipt,
} from "../../packages/installation/src/whatsapp-terminal-receipt.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("WhatsApp terminal receipt", () => {
  it("keeps one pending correlation through restart churn and acknowledges it once", () => {
    const directory = mkdtempSync(join(tmpdir(), "whatsapp-terminal-receipt-"));
    directories.push(directory);
    const database = join(directory, "application.sqlite");
    const first = {
      correlationId: "11111111-1111-4111-8111-111111111111",
      invocationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      phase: "logged_out" as const,
      reason: "connection_replaced",
      observedAt: "2026-07-27T00:00:00.000Z",
    };
    const churn = {
      correlationId: "22222222-2222-4222-8222-222222222222",
      invocationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      phase: "logged_out" as const,
      reason: "credentials_invalid",
      observedAt: "2026-07-27T00:01:00.000Z",
    };

    expect(pendingWhatsAppTerminalReceipt(database)).toBeUndefined();
    expect(persistWhatsAppTerminalReceipt(database, first)).toEqual(first);
    expect(persistWhatsAppTerminalReceipt(database, churn)).toEqual(first);
    acknowledgeWhatsAppTerminalReceipt(database, first.correlationId);
    expect(pendingWhatsAppTerminalReceipt(database)).toEqual(first);
    expect(() => acknowledgeWhatsAppTerminalReceipt(database, first.correlationId)).not.toThrow();
    expect(persistWhatsAppTerminalReceipt(database, churn)).toEqual(first);
    markWhatsAppTerminalReceiptAnnounced(database, first.correlationId);
    expect(pendingWhatsAppTerminalReceipt(database)).toBeUndefined();
    expect(() => markWhatsAppTerminalReceiptAnnounced(database, first.correlationId)).toThrow(
      "could not be marked announced",
    );
  });
});
