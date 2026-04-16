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
  s.start("Injecting Konto Ledger Schema...");

  const SCHEMA_SQL = `
    CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid AS $$
    BEGIN
      RETURN (
        lpad(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint), 12, '0') ||
        '7' || substr(md5(random()::text), 1, 3) ||
        '8' || substr(md5(random()::text), 1, 3) ||
        substr(md5(random()::text), 1, 12)
      )::uuid;
    END;
    $$ LANGUAGE plpgsql VOLATILE;

    CREATE TABLE IF NOT EXISTS konto_accounts (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
      name TEXT NOT NULL,
      currency TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS konto_journals (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
      description TEXT,
      metadata JSONB,
      idempotency_key TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS konto_entries (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
      journal_id UUID NOT NULL REFERENCES konto_journals(id) ON DELETE RESTRICT,
      account_id UUID NOT NULL REFERENCES konto_accounts(id) ON DELETE RESTRICT,
      amount BIGINT NOT NULL CHECK (amount != 0)
    );

    CREATE TABLE IF NOT EXISTS konto_holds (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
      account_id UUID NOT NULL REFERENCES konto_accounts(id) ON DELETE RESTRICT,
      recipient_id UUID NOT NULL REFERENCES konto_accounts(id) ON DELETE RESTRICT,
      amount BIGINT NOT NULL CHECK (amount > 0),
      idempotency_key TEXT UNIQUE,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS konto_balance_snapshots (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
      account_id UUID NOT NULL REFERENCES konto_accounts(id) ON DELETE RESTRICT,
      balance BIGINT NOT NULL,
      snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_holds_account ON konto_holds(account_id);
    CREATE INDEX IF NOT EXISTS idx_balance_snapshots_account ON konto_balance_snapshots(account_id, snapshot_at DESC);
  `;

  try {
    const sql = postgres(dbUrl, { max: 1, idle_timeout: 1 });
    await sql.unsafe(SCHEMA_SQL);
    await sql.end();
    
    s.stop(pc.green("✔ Schema successfully injected!"));
    log.info(pc.cyan("Tip: Add KONTO_INITIALIZED=true to your .env to prevent accidental re-runs in production."));
    outro("The engine is ready. You can now build with Konto.");
  } catch (err: any) {
    s.stop(pc.red("✖ Injection failed!"));
    console.error(pc.red(err.message ?? err.toString()));
    process.exit(1);
  }
}
