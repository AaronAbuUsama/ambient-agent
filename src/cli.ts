import { Command } from "commander";
import { join } from "node:path";
import { runDoctor } from "./home/doctor";
import { ambientHome, initHome } from "./home/init";

const program = new Command("ambient").description(
  "Ambient — one durable conversational entity over WhatsApp",
);

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

void program.parseAsync();
