import { intro, outro, spinner, text, isCancel, log } from "@clack/prompts";
import pc from "picocolors";
import postgres from "postgres";

export async function initCommand() {
  console.clear();
  intro(pc.bgBlack(pc.white(" KONTO ")));

  if (process.env.KONTO_INITIALIZED === "true") {
    log.info("Konto is already initialized (KONTO_INITIALIZED=true).");
    outro("Skipping schema injection.");
    process.exit(0);
  }

  let dbUrl = process.env.DATABASE_URL;

  if (dbUrl) {
    log.success("Detected DATABASE_URL in environment.");
  } else {
    log.warn("DATABASE_URL is missing from environment.");
    const input = await text({
      message: "Please provide your PostgreSQL connection string:",
      placeholder: "postgres://user:password@localhost:5432/db",
      validate(value) {
        if (!value.startsWith("postgres://") && !value.startsWith("postgresql://")) {
          return "Connection string must start with postgres:// or postgresql://";
        }
      },
    });

    if (isCancel(input)) {
      log.info("Operation cancelled.");
      process.exit(0);
    }

    dbUrl = input as string;
  }

  const s = spinner();
  s.start("Applying sequence migrations to Konto Ledger...");

  try {
    const sql = postgres(dbUrl, { max: 1, idle_timeout: 1 });
    
    // We pass the raw postgres.js client, which natively satisfies KontoQueryExecutor
    // for .unsafe and .begin calls.
    const { migrate } = await import("./migrate");
    const path = await import("path");
    
    const migrationsPath = path.resolve(__dirname, "../migrations");
    const { applied } = await migrate(sql as any, { migrationsPath });

    await sql.end();
    
    s.stop(pc.green(`✔ Sequence complete. Applied ${applied.length} migrations!`));
    if (applied.length > 0) {
      applied.forEach(m => log.info(pc.cyan(`  → ${m}`)));
    }
    
    log.info(pc.cyan("Tip: Add KONTO_INITIALIZED=true to your .env to prevent accidental re-runs in production."));
    outro("The engine is ready. You can now build with Konto.");
  } catch (err: any) {
    s.stop(pc.red("✖ Injection failed!"));
    console.error(pc.red(err.message ?? err.toString()));
    process.exit(1);
  }
}
