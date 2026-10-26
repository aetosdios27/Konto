import "dotenv/config";
import path from "path";
import postgres from "postgres";
import { cac } from "cac";
import { initCommand } from "./commands/init";
import { generateCommand } from "./commands/generate";
import { approveCommand } from "./commands/approve";
import { migrate } from "./commands/migrate";

export { defineLedger } from "./config";
export { migrate } from "./commands/migrate";

const cli = cac("konto");

cli
  .command("init", "Inject the Konto ledger schema into your PostgreSQL database")
  .action(async () => {
    await initCommand();
  });

cli
  .command("migrate", "Apply pending schema migrations to your PostgreSQL database")
  .option("--migrations <dir>", "Path to migrations directory")
  .action(async (options: { migrations?: string } = {}) => {
    const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!dbUrl) {
      console.error("DATABASE_URL or POSTGRES_URL is required to run migrations.");
      process.exit(1);
    }
    const sql = postgres(dbUrl, { max: 1, idle_timeout: 1 });
    const migrationsPath = options.migrations
      ? path.resolve(process.cwd(), options.migrations)
      : path.resolve(__dirname, "../migrations");
    try {
      const { applied } = await migrate(sql as any, { migrationsPath });
      await sql.end();
      if (applied.length > 0) {
        console.log(`Applied ${applied.length} migration(s): ${applied.join(", ")}`);
      } else {
        console.log("No pending migrations.");
      }
    } catch (err: any) {
      await sql.end();
      console.error(`Migration failed: ${err.message ?? err}`);
      process.exit(1);
    }
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
cli.version("0.2.0");

cli.parse();
