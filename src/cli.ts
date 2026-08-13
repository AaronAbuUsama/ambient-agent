import { Command } from "commander";
import { join } from "node:path";
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

program.parse();
