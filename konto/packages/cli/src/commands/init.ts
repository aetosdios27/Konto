import { intro, outro, spinner, text, select, confirm, isCancel, log } from "@clack/prompts";
import pc from "picocolors";
import postgres from "postgres";
import fs from "fs";
import path from "path";
import { generateCommand } from "./generate";

export async function initCommand() {
  intro(pc.bgBlack(pc.white(" KONTO ")));

  if (process.env.KONTO_INITIALIZED === "true") {
    log.info("Konto is already initialized (KONTO_INITIALIZED=true).");
    outro("Skipping schema injection.");
    process.exit(0);
  }

  let dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;

  if (dbUrl) {
    log.success("Detected database URL in environment.");
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

  const driver = await select({
    message: "Which database driver are you using in your application?",
    options: [
      { value: "prisma", label: "Prisma ORM", hint: "Keep Prisma for App state, use Konto for Money state" },
      { value: "drizzle", label: "Drizzle ORM", hint: "Use your existing Drizzle connection" },
      { value: "vercel", label: "Vercel Postgres (@vercel/postgres)" },
      { value: "neon", label: "Neon Serverless (@neondatabase/serverless)" },
      { value: "supabase", label: "Supabase" },
      { value: "postgres", label: "Raw Postgres (postgres.js)" },
    ],
  });

  if (isCancel(driver)) {
    log.info("Operation cancelled.");
    process.exit(0);
  }

  log.info("We will now configure your local environment. Your database will not be modified without permission.");

  const shouldMigrate = await confirm({
    message: "Would you also like to apply the Konto schema migrations to your database right now?",
    initialValue: true,
  });

  if (isCancel(shouldMigrate)) {
    log.info("Operation cancelled.");
    process.exit(0);
  }

  log.step("1. Scaffolding local configuration");
  const configPath = path.resolve(process.cwd(), "konto.config.ts");
  if (!fs.existsSync(configPath)) {
    log.info("→ Creating konto.config.ts...");
    fs.writeFileSync(configPath, `import { z } from "zod";\nimport { defineLedger } from "@konto-ledger/cli";\n\nexport default defineLedger({\n  transfer: z.object({\n    invoice_id: z.string(),\n  }),\n  hold: z.object({}),\n  journal: z.object({}),\n  account: z.object({}),\n});\n`);
  }

  log.step("2. Generating localized adapter boilerplate");
  let libPath = path.resolve(process.cwd(), "src/lib");
  let relativePath = "src/lib/konto.ts";
  if (!fs.existsSync(path.resolve(process.cwd(), "src"))) {
    libPath = path.resolve(process.cwd(), "lib");
    relativePath = "lib/konto.ts";
  }
  if (!fs.existsSync(libPath)) {
    fs.mkdirSync(libPath, { recursive: true });
  }

  const fileDest = path.join(libPath, "konto.ts");
  let boilerplate = "";

  if (driver === "prisma") {
    boilerplate = `import { PrismaClient } from "@prisma/client";\nimport { createPrismaAdapter } from "@konto-ledger/adapters/prisma";\n\nexport const prisma = new PrismaClient();\nexport const db = createPrismaAdapter(prisma);\n`;
  } else if (driver === "drizzle") {
    boilerplate = `import { drizzle } from "drizzle-orm/postgres-js";\nimport postgres from "postgres";\nimport { createDrizzleAdapter } from "@konto-ledger/adapters/drizzle";\n\nconst client = postgres(process.env.DATABASE_URL!);\nexport const drizzleDb = drizzle(client);\nexport const db = createDrizzleAdapter(drizzleDb);\n`;
  } else if (driver === "vercel") {
    boilerplate = `import { createVercelAdapter } from "@konto-ledger/adapters/vercel";\n\n// Automatically uses process.env.POSTGRES_URL\nexport const db = createVercelAdapter();\n`;
  } else if (driver === "neon") {
    boilerplate = `import { neon } from "@neondatabase/serverless";\nimport { createNeonAdapter } from "@konto-ledger/adapters/neon";\n\nconst sql = neon(process.env.DATABASE_URL!);\nexport const db = createNeonAdapter(sql);\n`;
  } else if (driver === "supabase") {
    boilerplate = `import { createSupabaseAdapter } from "@konto-ledger/adapters/supabase";\n\nexport const db = createSupabaseAdapter(process.env.DATABASE_URL!);\n`;
  } else {
    boilerplate = `import postgres from "postgres";\n\n// postgres.js natively satisfies KontoQueryExecutor\nexport const db = postgres(process.env.DATABASE_URL!);\n`;
  }

  if (!fs.existsSync(fileDest)) {
    fs.writeFileSync(fileDest, boilerplate);
    log.success(`Scaffolded adapter boilerplate at ${pc.cyan(relativePath)}`);
  }

  if (shouldMigrate) {
    const s = spinner();
    s.start("Applying sequence migrations to Konto Ledger...");

    try {
      const sql = postgres(dbUrl, { max: 1, idle_timeout: 1 });
      const { migrate } = await import("./migrate");
      const pathModule = await import("path");

      const migrationsPath = pathModule.resolve(__dirname, "../migrations");
      const { applied } = await migrate(sql as any, { migrationsPath });

      await sql.end();

      s.stop(pc.green(`✔ Sequence complete. Applied ${applied.length} migrations!`));
      if (applied.length > 0) {
        applied.forEach(m => log.info(pc.cyan(`  → ${m}`)));
      }

      log.info(pc.cyan("Tip: Add KONTO_INITIALIZED=true to your .env to prevent accidental re-runs in production."));
    } catch (err: any) {
      s.stop(pc.red("✖ Migration injection failed!"));
      console.error(pc.red(err.message ?? err.toString()));
      process.exit(1);
    }
  } else {
    log.info("Skipped migrations. Run `npx @konto-ledger/cli migrate` later to apply them.");
  }

  log.step("3. Generating strictly typed .konto client");
  await generateCommand(true);

  log.success("Setup complete! Here is your quickstart code:");
  log.message(pc.green(`import { createAccount, transfer } from ".konto";\nimport { db } from "./${relativePath.replace(".ts", "")}";\n\nconst alice = await createAccount({ metadata: {} }, db);\nconst bob = await createAccount({ metadata: {} }, db);\n\nawait transfer({\n  entries: [\n    { accountId: alice.id, amount: -5000n },\n    { accountId: bob.id, amount: 5000n },\n  ],\n  metadata: { invoice_id: "INV-001" },\n}, db);`));
}
