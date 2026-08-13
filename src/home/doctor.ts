import { existsSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { z } from "zod";
import { loadAppConfig, type AppConfig } from "../app/config";
import { mirrorAuthState } from "../whatsapp/mirror";
import { ambientHome } from "./init";
import { scanMandates } from "./mandates";
import { scanAllSkills } from "./skills";

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
}

function describeError(error: unknown): string {
  if (error instanceof z.ZodError) return z.prettifyError(error);
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The loud surface: re-derive the home's health from disk on demand — nothing
 * stored, nothing guessed (ADR 0002). Sections grow as the slice lands more
 * verticals (mandates and skills join with the projector and skills loading).
 */
export async function runDoctor(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const home = ambientHome(environment);

  const missing = ["chats", "skills", "state"].filter(
    (directory) => !existsSync(join(home, directory)),
  );
  checks.push(
    missing.length > 0
      ? {
          name: "home",
          ok: false,
          detail: `${home} is missing ${missing.join(", ")} — run \`ambient init\``,
        }
      : { name: "home", ok: true, detail: home },
  );

  let config: AppConfig | undefined;
  try {
    config = loadAppConfig(environment);
    checks.push({
      name: "config",
      ok: true,
      detail: `providers: ${Object.keys(config.models.providers).join(", ")} · roles: ${Object.keys(config.models.roles).join(", ")}`,
    });
  } catch (error) {
    checks.push({ name: "config", ok: false, detail: describeError(error) });
  }
  if (config === undefined) return { ok: false, checks };

  checks.push(
    config.master
      ? { name: "master", ok: true, detail: "recorded" }
      : { name: "master", ok: true, detail: "not recorded — set master.chatId before Root v1" },
  );

  for (const [name, provider] of Object.entries(config.models.providers)) {
    if (provider.credential === "none") continue;
    const resolved = provider.credential.env.find((variable) => environment[variable]);
    checks.push(
      resolved !== undefined
        ? { name: `credential ${name}`, ok: true, detail: `${resolved} resolved` }
        : {
            name: `credential ${name}`,
            ok: false,
            detail: `set one of ${provider.credential.env.join(", ")}`,
          },
    );
  }

  const scan = scanMandates(config.home);
  checks.push({
    name: "chats",
    ok: true,
    detail:
      scan.active.length === 0
        ? "none active — `ambient activate` grants the first mandate"
        : scan.active.map((mandate) => `${mandate.slug} (${mandate.mode})`).join(", "),
  });
  for (const chat of scan.broken) {
    checks.push({ name: `chat ${chat.slug}`, ok: false, detail: chat.problem });
  }

  const skillScan = scanAllSkills(config.home);
  const homeSkills = skillScan.skills.filter(({ scope }) => scope === "home").length;
  const chatSkills = skillScan.skills.length - homeSkills;
  checks.push({
    name: "skills",
    ok: true,
    detail:
      skillScan.skills.length === 0
        ? "none — drop SKILL.md folders into skills/ or a chat's skills/"
        : `${homeSkills} home, ${chatSkills} chat-scoped`,
  });
  for (const skill of skillScan.broken) {
    checks.push({ name: `skill ${skill.folder}`, ok: false, detail: skill.problem });
  }

  const databasePath = config.database.url.replace(/^file:/, "");
  if (!existsSync(databasePath)) {
    checks.push({ name: "state", ok: true, detail: "no database yet — created at first start" });
  } else {
    const database = createClient({ url: config.database.url });
    try {
      const result = await database.execute(
        "SELECT mode, count(*) AS n FROM conversation_speakers GROUP BY mode",
      );
      const byMode = new Map<string, number>();
      for (const row of result.rows) {
        if (typeof row.mode === "string") byMode.set(row.mode, Number(row.n));
      }
      const listening = byMode.get("listening") ?? 0;
      const responding = byMode.get("responding") ?? 0;
      checks.push({
        name: "state",
        ok: true,
        detail: `${databasePath} · speakers: ${responding} responding, ${listening} listening`,
      });
    } catch (error) {
      checks.push({ name: "state", ok: false, detail: describeError(error) });
    } finally {
      database.close();
    }
  }

  try {
    const auth = await mirrorAuthState(config.whatsapp.dataDirectory, config.whatsapp.accountId);
    checks.push(
      auth === "authenticated"
        ? {
            name: "whatsapp",
            ok: true,
            detail: `authenticated (account: ${config.whatsapp.accountId})`,
          }
        : auth === "no-state"
          ? { name: "whatsapp", ok: true, detail: "no WhatsApp state yet — pairs at first start" }
          : {
              name: "whatsapp",
              ok: false,
              detail: `state exists but account "${config.whatsapp.accountId}" has no credentials`,
            },
    );
  } catch (error) {
    checks.push({ name: "whatsapp", ok: false, detail: describeError(error) });
  }

  return { ok: checks.every((check) => check.ok), checks };
}
