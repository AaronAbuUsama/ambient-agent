import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureStrayOutput, createSessionLogger } from "./log";

async function inScratch<T>(work: (file: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "wa-log-"));
  try {
    return await work(join(directory, "whatsapp.log"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Everything the terminal would have shown while a capture was installed. */
function recordTerminal(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  return { lines, restore: () => void (process.stdout.write = original) };
}

test("the session logger writes to its file and never to the screen", async () => {
  await inScratch(async (file) => {
    // Stand in for the renderer: whatever reaches this is what shreds the frame.
    const terminal = recordTerminal();
    try {
      createSessionLogger(file).warn({ err: new Error("socket closed") }, "connection update");
    } finally {
      terminal.restore();
    }

    expect(terminal.lines).toEqual([]);
    expect(await readFile(file, "utf8")).toContain("connection update");
  });
});

test("the session logger redacts what an upstream error carries", async () => {
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

test("stray descriptor writes land in the log until the capture is released", async () => {
  await inScratch(async (file) => {
    const terminal = recordTerminal();
    let release: (() => void) | undefined;
    try {
      // Installed over the recorder, exactly as it installs over the renderer's
      // saved write: the UI keeps its own reference and is never diverted.
      release = captureStrayOutput(file);
      process.stdout.write("baileys says hello\n");
      process.stderr.write("ExperimentalWarning: something\n");
      release();
      release = undefined;
      process.stdout.write("after release\n");
    } finally {
      release?.();
      terminal.restore();
    }

    expect(terminal.lines).toEqual(["after release\n"]);
    const written = await readFile(file, "utf8");
    expect(written).toContain("[stdout] baileys says hello");
    expect(written).toContain("[stderr] ExperimentalWarning: something");
    expect(written).not.toContain("after release");
  });
});
