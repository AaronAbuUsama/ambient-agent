import { expect, test } from "vite-plus/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionLogger } from "./logging";

async function inScratch<T>(work: (file: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "wa-log-"));
  try {
    return await work(join(directory, "whatsapp.log"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("the WhatsApp session logger writes to its deployment file", async () => {
  await inScratch(async (file) => {
    createSessionLogger(file).warn({ err: new Error("socket closed") }, "connection update");

    expect(await readFile(file, "utf8")).toContain("connection update");
  });
});

test("the WhatsApp session logger redacts upstream message and address fields", async () => {
  await inScratch(async (file) => {
    createSessionLogger(file).warn(
      { err: { data: { text: "dinner at seven", to: "15550001111@s.whatsapp.net" } } },
      "send failed",
    );

    const written = await readFile(file, "utf8");
    expect(written).toContain("send failed");
    expect(written).not.toContain("dinner at seven");
    expect(written).not.toContain("15550001111");
  });
});
