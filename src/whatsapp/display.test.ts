import { expect, test } from "bun:test";
import { addressLabel, chatRowLabel, lastActivityStamp } from "./display";

const at = (iso: string) => new Date(iso).getTime();
// A Wednesday, mid-afternoon, in local time — every case below is relative to it.
const now = at("2026-08-12T15:30:00");

test("only a dialable address is dressed as a phone number", () => {
  // A lid and a group id have the digit count of an E.164 address and neither
  // is a number anyone can call.
  expect(addressLabel("204663831932940@lid")).toBe("204663831932940");
  expect(addressLabel("120363000000000001@g.us")).toBe("120363000000000001");
  expect(addressLabel("15550001111@s.whatsapp.net")).toBe("+15550001111");
  expect(addressLabel("15550001111:7@s.whatsapp.net")).toBe("+15550001111");
});

test("today reads as a time, this week as a weekday, older as a date", () => {
  expect(lastActivityStamp(at("2026-08-12T09:05:00"), now)).toBe("09:05");
  expect(lastActivityStamp(at("2026-08-12T00:00:00"), now)).toBe("00:00");
  // Yesterday is a weekday even though it is under 24 hours ago.
  expect(lastActivityStamp(at("2026-08-11T23:59:00"), now)).toBe("Tue");
  expect(lastActivityStamp(at("2026-08-06T12:00:00"), now)).toBe("Thu");
  // Seven days back has fallen out of the week and becomes a date.
  expect(lastActivityStamp(at("2026-08-05T12:00:00"), now)).toBe("05/08");
  expect(lastActivityStamp(at("2026-01-09T12:00:00"), now)).toBe("09/01");
});

test("a chat nothing has ever arrived in carries no stamp", () => {
  expect(lastActivityStamp(0, now)).toBe("");
  expect(lastActivityStamp(Number.NaN, now)).toBe("");
});

test("a row fills its width with the stamp flush right", () => {
  const row = chatRowLabel("@ Alice", "18:16", 25);
  expect(row).toHaveLength(25);
  expect(row).toBe("@ Alice             18:16");
});

test("a name too long for its row is truncated, never the stamp", () => {
  const row = chatRowLabel("# KAPHILS <> BELVIDERE", "11:09", 25);
  expect(row).toHaveLength(25);
  expect(row.endsWith(" 11:09")).toBe(true);
  expect(row.startsWith("# KAPHILS")).toBe(true);
  expect(row).toContain("…");
});

test("a pane too narrow for both keeps the name and drops the stamp", () => {
  expect(chatRowLabel("@ Alice", "18:16", 9)).toBe("@ Alice");
  expect(chatRowLabel("@ Alexandra", "18:16", 9)).toBe("@ Alexan…");
});
