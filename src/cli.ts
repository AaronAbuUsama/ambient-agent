import { Command } from "commander";
import { join } from "node:path";
import { runDoctor } from "./home/doctor";
import { ambientHome, initHome } from "./home/init";
import { activateChat, setMaster } from "./home/ops";

const program = new Command("ambient").description(
  "Ambient — one durable conversational entity over WhatsApp",
);

// Bare `ambient`: initialize the home if it does not exist, then run the
// daemon in the foreground — stdout is the tail; ctrl-c stops it.
program.action(async () => {
  const home = ambientHome();
  const created = initHome(home);
  // First run means the config was just seeded — the operator has not
  // authored it yet. Merely repairing missing tree pieces is not first run.
  if (created.includes("config.yaml")) {
    console.log(`initialized ${home} — edit config.yaml, then run \`ambient\` again`);
    return;
  }
  const { loadAppConfig } = await import("./app/config");
  const { runAmbientProcess } = await import("./app/run");
  try {
    await runAmbientProcess(loadAppConfig());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("run `ambient doctor` for the full readout");
    process.exitCode = 1;
  }
});

program
  .command("init")
  .description("Create the Ambient home (idempotent)")
  .action(() => {
    const home = ambientHome();
    const created = initHome(home);
    if (created.length === 0) {
      console.log(`${home} is already initialized`);
      return;
    }
    for (const piece of created) console.log(`created ${join(home, piece)}`);
  });

program
  .command("doctor")
  .description("Re-derive the home's health from disk (non-zero exit when broken)")
  .option("--json", "machine-readable output")
  .action(async (options: { json?: boolean }) => {
    const report = await runDoctor();
    if (options.json === true) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      for (const check of report.checks) {
        console.log(`${check.ok ? "✓" : "✗"} ${check.name.padEnd(18)} ${check.detail}`);
      }
    }
    if (!report.ok) process.exitCode = 1;
  });

program
  .command("activate")
  .description("Activate a chat: create its folder and mandate (listening by default)")
  .argument("<query>", "chat name, phone number, or chat id")
  .option("--responding", "grant speaking rights immediately")
  .option("--json", "machine-readable output")
  .action(async (query: string, options: { responding?: boolean; json?: boolean }) => {
    const result = await activateChat(
      process.env,
      query,
      options.responding === true ? "responding" : "listening",
    );
    if (options.json === true) {
      console.log(JSON.stringify(result));
      if (result.kind !== "activated" && result.kind !== "already-active") process.exitCode = 1;
      return;
    }
    switch (result.kind) {
      case "activated":
        console.log(`✓ chats/${result.slug}/mandate.yaml — active, ${result.mode}`);
        break;
      case "already-active":
        console.log(`already active as chats/${result.slug}/`);
        break;
      case "ambiguous":
        console.log(`matches more than one chat:`);
        for (const candidate of result.candidates) console.log(`  ${candidate}`);
        process.exitCode = 1;
        break;
      case "not-found":
        console.log(`no chat matches "${result.query}"`);
        process.exitCode = 1;
        break;
      case "slug-taken": {
        console.log(`chats/${result.slug}/ already exists and binds a different chat`);
        process.exitCode = 1;
        break;
      }
      default: {
        const exhaustive: never = result;
        throw new Error(`unhandled result ${JSON.stringify(exhaustive)}`);
      }
    }
  });

program
  .command("master")
  .description("Record the master's direct line in config.yaml")
  .argument("<number>", "phone number or chat id")
  .action((number: string) => {
    const { chatId } = setMaster(process.env, number);
    console.log(`✓ master recorded (${chatId})`);
  });

void program.parseAsync();
