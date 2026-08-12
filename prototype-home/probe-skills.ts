// PROTOTYPE — throwaway. Walking-skeleton probe: what does the real pi loader
// do with skills spread across the home and two chat folders?
// Run: npx tsx prototype-home/probe-skills.ts
import {
  loadSkills,
  loadSourcedSkills,
  NodeExecutionEnv,
  type Skill,
} from "@earendil-works/pi-agent-core/node";
import path from "node:path";

const homeDir = path.join(import.meta.dirname, "home");
const env = new NodeExecutionEnv({ cwd: homeDir });

const dirs = {
  home: path.join(homeDir, "skills"),
  tst: path.join(homeDir, "chats/tst/skills"),
  productFeedback: path.join(homeDir, "chats/product-feedback/skills"),
};

console.log("=== A. loadSkills — flat multi-dir call (does pi dedupe or order?) ===");
const flat = await loadSkills(env, [dirs.home, dirs.tst, dirs.productFeedback]);
for (const s of flat.skills) {
  console.log(`  skill: ${s.name.padEnd(16)} <- ${path.relative(homeDir, s.filePath)}`);
}
console.log(`  diagnostics (${flat.diagnostics.length}):`);
for (const d of flat.diagnostics) {
  console.log(`    [${d.code}] ${d.message} (${path.relative(homeDir, d.path)})`);
}

console.log("\n=== B. loadSourcedSkills — provenance preserved per directory ===");
type Source = { scope: "home" } | { scope: "chat"; slug: string };
const sourced = await loadSourcedSkills<Source>(env, [
  { path: dirs.home, source: { scope: "home" } },
  { path: dirs.tst, source: { scope: "chat", slug: "tst" } },
  { path: dirs.productFeedback, source: { scope: "chat", slug: "product-feedback" } },
]);
for (const { skill, source } of sourced.skills) {
  const tag = source.scope === "home" ? "home" : `chat:${source.slug}`;
  console.log(
    `  skill: ${skill.name.padEnd(16)} source: ${tag.padEnd(22)} desc: ${skill.description.slice(0, 50)}`,
  );
}
console.log(`  diagnostics (${sourced.diagnostics.length}):`);
for (const d of sourced.diagnostics) {
  const tag = d.source.scope === "home" ? "home" : `chat:${d.source.slug}`;
  console.log(`    [${d.code}] (source ${tag}) ${d.message}`);
}

console.log("\n=== C. OUR collision policy on top (chat wins, warn on shadow) ===");
// Liftable candidate for the Skills ticket: pi has no precedence, so this is
// the whole policy Ambient would own.
function applyPrecedence(entries: Array<{ skill: Skill; source: Source }>, activeChat: string) {
  const inScope = entries.filter(
    (e) => e.source.scope === "home" || (e.source.scope === "chat" && e.source.slug === activeChat),
  );
  const byName = new Map<string, { skill: Skill; source: Source }>();
  const shadows: string[] = [];
  for (const e of inScope) {
    const existing = byName.get(e.skill.name);
    if (!existing) {
      byName.set(e.skill.name, e);
      continue;
    }
    const chatEntry = e.source.scope === "chat" ? e : existing;
    const homeEntry = e.source.scope === "chat" ? existing : e;
    byName.set(e.skill.name, chatEntry);
    shadows.push(
      `${e.skill.name}: chat copy shadows ${path.relative(homeDir, homeEntry.skill.filePath)}`,
    );
  }
  return { resolved: [...byName.values()], shadows };
}

const forTst = applyPrecedence(sourced.skills, "tst");
console.log(`  run assembly for chat "tst" sees ${forTst.resolved.length} skills:`);
for (const { skill, source } of forTst.resolved) {
  const tag = source.scope === "home" ? "home" : `chat:${source.slug}`;
  console.log(
    `    ${skill.name.padEnd(16)} from ${tag.padEnd(10)} body starts: "${skill.content.trim().slice(0, 40)}..."`,
  );
}
for (const w of forTst.shadows) console.log(`    WARN shadow — ${w}`);
