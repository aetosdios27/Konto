import "dotenv/config";
import { cac } from "cac";
import { initCommand } from "./commands/init";
import { generateCommand } from "./commands/generate";
import { approveCommand } from "./commands/approve";

export { defineLedger } from "./config";

const cli = cac("konto");

cli
  .command("init", "Inject the Konto ledger schema into your PostgreSQL database")
  .action(async () => {
    await initCommand();
  });

cli
  .command("generate", "Generate a strictly typed Konto client based on konto.config.ts")
  .option("-o, --output <dir>", "Output directory for the generated client")
  .action(async (options) => {
    await generateCommand(false, options);
  });

cli
  .command("approve [intentId]", "Approve and execute a staged financial intent (or launch interactive bulk queue)")
  .action(async (intentId?: string) => {
    await approveCommand(intentId);
  });

cli.help();
cli.version("0.1.0");

cli.parse();
