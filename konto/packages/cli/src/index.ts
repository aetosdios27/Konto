import "dotenv/config";
import { cac } from "cac";
import { initCommand } from "./commands/init";
import { generateCommand } from "./commands/generate";

export { defineLedger } from "./config";

const cli = cac("konto");

cli
  .command("init", "Inject the Konto ledger schema into your PostgreSQL database")
  .action(async () => {
    await initCommand();
  });

cli
  .command("generate", "Generate a strictly typed Konto client based on konto.config.ts")
  .action(async () => {
    await generateCommand();
  });

cli.help();
cli.version("0.1.0");

cli.parse();
