import "dotenv/config";
import { cac } from "cac";
import { initCommand } from "./commands/init";

const cli = cac("konto");

cli
  .command("init", "Inject the Konto ledger schema into your PostgreSQL database")
  .action(async () => {
    await initCommand();
  });

cli.help();
cli.version("0.1.0");

cli.parse();
