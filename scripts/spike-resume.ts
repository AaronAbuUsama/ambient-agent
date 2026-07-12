/**
 * Spike (ticket #4, R1): determine HOW the loopback doorway achieves durable
 * per-chat memory. DECISION-SPEC G1/D4 assume `continuationToken = chatId`
 * resumes one durable session per chat via `eve/client`. This harness tests the
 * three candidate resume strategies against the live server and prints, for
 * each, whether the SAME server session is reused (sessionId) and whether the
 * conversation history actually carries (a codeword memory probe).
 *
 * Strategy 1 — same ClientSession object, two sends (one long-lived caller).
 *              This is the REAL gateway usage: one process holds the session.
 * Strategy 2 — persist SessionState (incl. sessionId) from turn 1, rebuild a
 *              fresh Client + resume from that state. Simulates a cold restart
 *              that persisted its cursor (D6 SQLite).
 * Strategy 3 — continuationToken ALONE via a fresh Client.session(token).
 *              This is what the DoD's "run the script twice with the same token"
 *              literally does across cold processes.
 *
 * Usage: tsx scripts/spike-resume.ts    (env EVE_URL, default :4319)
 */
import { Client } from "eve/client";
import type { SessionState } from "eve/client";

const host = process.env.EVE_URL ?? "http://127.0.0.1:4319";

const CODEWORD = "BANANA-42";
const PLANT = `Please remember this codeword for later: ${CODEWORD}. Just acknowledge in one short sentence.`;
const PROBE = "What was the codeword I gave you earlier? Reply with ONLY the codeword, nothing else.";

async function turn(client: Client, sel: SessionState | string, message: string) {
  const session = client.session(sel);
  const resp = await session.send({ message });
  const result = await resp.result();
  return {
    sessionId: result.sessionId,
    status: result.status,
    reply: (result.message ?? "").trim(),
    state: session.state,
  };
}

const remembered = (reply: string) => reply.toUpperCase().includes(CODEWORD);

async function main() {
  const client = new Client({ host });
  await client.health();
  const rows: string[] = [];

  // ---- Strategy 1: one long-lived ClientSession, two sends ----
  {
    const token = `s1-${process.pid}`;
    const session = client.session(token);
    const r1 = await session.send({ message: PLANT }).then((r) => r.result());
    const r2 = await session.send({ message: PROBE }).then((r) => r.result());
    const sameSession = r1.sessionId === r2.sessionId;
    const mem = remembered((r2.message ?? "").trim());
    rows.push(
      `1 same-ClientSession   | sess1=${r1.sessionId.slice(-8)} sess2=${r2.sessionId.slice(-8)} same=${sameSession} | remembered=${mem} | probeReply="${(r2.message ?? "").trim()}"`,
    );
  }

  // ---- Strategy 2: persist SessionState, resume with a fresh Client ----
  {
    const token = `s2-${process.pid}`;
    const a = await turn(client, token, PLANT); // plant
    // "cold restart": brand-new Client, resume from the persisted state cursor
    const cold = new Client({ host });
    const b = await turn(cold, a.state, PROBE);
    const sameSession = a.sessionId === b.sessionId;
    rows.push(
      `2 persisted-SessionState| sess1=${a.sessionId.slice(-8)} sess2=${b.sessionId.slice(-8)} same=${sameSession} | remembered=${remembered(b.reply)} | probeReply="${b.reply}"`,
    );
  }

  // ---- Strategy 3: continuationToken ALONE, fresh Client each turn ----
  {
    const token = `s3-${process.pid}`;
    const a = await turn(new Client({ host }), token, PLANT);
    const b = await turn(new Client({ host }), token, PROBE);
    const sameSession = a.sessionId === b.sessionId;
    rows.push(
      `3 token-only cold       | sess1=${a.sessionId.slice(-8)} sess2=${b.sessionId.slice(-8)} same=${sameSession} | remembered=${remembered(b.reply)} | probeReply="${b.reply}"`,
    );
  }

  console.log("\n=== RESUME STRATEGY RESULTS (codeword=" + CODEWORD + ") ===");
  for (const r of rows) console.log(r);
}

main().catch((err) => {
  console.error("[spike-resume] ERROR:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
