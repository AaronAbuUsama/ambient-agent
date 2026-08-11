import { expect, test } from "bun:test";
import { loadAppConfig } from "./config";

test("history backfill is unlimited by default", () => {
  expect(loadAppConfig({}).whatsapp.historyBackfillLimit).toBeUndefined();
});

test("history backfill accepts an explicit deployment limit", () => {
  expect(loadAppConfig({ WHATSAPP_BACKFILL_LIMIT: "5000" }).whatsapp.historyBackfillLimit).toBe(
    5000,
  );
});

test.each(["all", "1"])("history backfill rejects invalid limit %s", (limit) => {
  expect(() => loadAppConfig({ WHATSAPP_BACKFILL_LIMIT: limit })).toThrow(
    "WHATSAPP_BACKFILL_LIMIT must be a positive multiple of 25",
  );
});
