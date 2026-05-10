import fs from "fs/promises";
import path from "path";
import { KontoQueryExecutor } from "@konto-ledger/types";

export interface MigrateOptions {
  migrationsPath: string;
}

export async function migrate(
  db: KontoQueryExecutor,
  options: MigrateOptions,
): Promise<{ applied: string[] }> {
  // 1. Ensure idempotency tracking table exists
  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS _konto_migrations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      migration_name TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 2. Fetch already applied migrations
  const existingRecords = await db.unsafe<{ migration_name: string }[]>(
    `SELECT migration_name FROM _konto_migrations ORDER BY applied_at ASC`
  );
  const appliedSet = new Set(existingRecords.map((r) => r.migration_name));

  // 3. Scan the designated migrations directory
  let files: string[];
  try {
    files = await fs.readdir(options.migrationsPath);
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new Error(`Migration directory not found: ${options.migrationsPath}`);
    }
    throw err;
  }

  // Filter for pending `.sql` logic and sort chronologically
  const pendingMigrations = files
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => !appliedSet.has(f));

  if (pendingMigrations.length === 0) {
    return { applied: [] };
  }

  const appliedList: string[] = [];

  // TODO: Support --no-transaction flags for CONCURRENTLY operations.
  // We will need it when we hit a billion rows and have to index live data without table locks.
  for (const file of pendingMigrations) {
    const fullPath = path.join(options.migrationsPath, file);
    const sqlContent = await fs.readFile(fullPath, "utf-8");

    // Atomically execute patch and record into tracker
    await db.begin(async (tx) => {
      await tx.unsafe(sqlContent);
      await tx.unsafe(
        `INSERT INTO _konto_migrations (migration_name) VALUES ($1)`,
        [file]
      );
    });
    
    appliedList.push(file);
  }

  return { applied: appliedList };
}
