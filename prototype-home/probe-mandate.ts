// PROTOTYPE — throwaway. Walking-skeleton probe: mandate.yaml parse ->
// validate -> project round trip, good and bad file, in memory only.
// The schema here is a STRAWMAN — the real one is ticket #4's decision.
// Run: npx tsx prototype-home/probe-mandate.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

const homeDir = path.join(import.meta.dirname, "home");

const chatBinding = z.object({ chatId: z.string().min(1) });
const mandateSchema = z.object({
  mode: z.enum(["listening", "responding"]),
  instructions: z.string().min(1).optional(),
  memoryBrief: z.string().min(1).optional(),
  activationPoint: z.iso.datetime().optional(),
});

// The in-memory stand-in for conversation_speakers — the projection target.
type SpeakerRow = {
  conversationId: string;
  mode: "listening" | "responding";
  instructions: string | null;
  attendFrom: string;
  updatedAt: string;
};
const rows = new Map<string, SpeakerRow>();

// Seed: pretend product-feedback projected fine yesterday (keep-last-good demo).
rows.set("fake-feedback-group@g.us", {
  conversationId: "fake-feedback-group@g.us",
  mode: "listening",
  instructions: null,
  attendFrom: "2026-08-11T00:00:00Z",
  updatedAt: "2026-08-11T09:00:00Z",
});

function project(slug: string): void {
  const dir = path.join(homeDir, "chats", slug);
  console.log(`\n=== chats/${slug}/ ===`);

  const bindingRaw: unknown = YAML.parse(readFileSync(path.join(dir, "chat.yaml"), "utf8"));
  const binding = chatBinding.parse(bindingRaw);
  console.log(`  1. binding: slug "${slug}" -> ${binding.chatId}`);

  const mandateText = readFileSync(path.join(dir, "mandate.yaml"), "utf8");
  const parsed: unknown = YAML.parse(mandateText);
  console.log(`  2. parsed YAML:`, JSON.stringify(parsed));

  const validated = mandateSchema.safeParse(parsed);
  if (!validated.success) {
    console.log(`  3. INVALID mandate — diagnostics:`);
    for (const issue of validated.error.issues) {
      console.log(`       ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    const kept = rows.get(binding.chatId);
    console.log(
      kept
        ? `  4. keep-last-good: row unchanged -> ${JSON.stringify(kept)}`
        : `  4. no previous row: chat stays un-allowed (nothing projected)`,
    );
    console.log(
      `     (keep-last-good vs fail-closed is ticket #4's fork — this demos keep-last-good)`,
    );
    return;
  }

  const previous = rows.get(binding.chatId);
  const row: SpeakerRow = {
    conversationId: binding.chatId,
    mode: validated.data.mode,
    instructions: validated.data.instructions?.trim() ?? null,
    attendFrom:
      validated.data.activationPoint ??
      previous?.attendFrom ??
      new Date("2026-08-12T12:00:00Z").toISOString(),
    updatedAt: new Date("2026-08-12T12:00:00Z").toISOString(),
  };
  rows.set(binding.chatId, row);
  console.log(`  3. valid — projected row:`);
  console.log(`     ${JSON.stringify(row, null, 2).split("\n").join("\n     ")}`);
  console.log(
    `  4. (memoryBrief is parsed but has no row column yet — it feeds run assembly, ticket #4/#5)`,
  );
}

project("tst");
project("product-feedback");

console.log(`\n=== final in-memory speaker rows ===`);
for (const row of rows.values()) console.log(`  ${JSON.stringify(row)}`);
