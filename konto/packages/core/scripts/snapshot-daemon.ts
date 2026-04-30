/**
 * @konto/core — Snapshot Daemon
 *
 * A lightweight worker that continuously polls the database every 60 seconds,
 * identifies accounts with more than 1,000 new entries since their last
 * snapshot, and calls the take_snapshot(account_id) stored procedure
 * to maintain O(1) read performance on getBalance().
 *
 * Run: npx tsx packages/core/scripts/snapshot-daemon.ts
 * Or:  node --loader tsx packages/core/scripts/snapshot-daemon.ts
 *
 * Environment:
 *   DATABASE_URL — PostgreSQL connection string (required)
 *   SNAPSHOT_INTERVAL_MS — Poll interval in ms (default: 60000)
 *   SNAPSHOT_THRESHOLD — Minimum new entries to trigger snapshot (default: 1000)
 */

import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[snapshot-daemon] FATAL: DATABASE_URL is not set.");
  process.exit(1);
}

const INTERVAL_MS = Number(process.env.SNAPSHOT_INTERVAL_MS ?? 60_000);
const THRESHOLD = Number(process.env.SNAPSHOT_THRESHOLD ?? 1_000);

const sql = postgres(DATABASE_URL, { max: 3, idle_timeout: 30 });

console.error(`[snapshot-daemon] Started. Interval: ${INTERVAL_MS}ms, Threshold: ${THRESHOLD} entries.`);

/**
 * Finds all accounts that have accumulated more than THRESHOLD entries
 * since their most recent balance snapshot, and takes a new snapshot.
 */
async function runSnapshotCycle(): Promise<void> {
  const startTime = performance.now();

  // Find accounts with > THRESHOLD entries since their last snapshot.
  // Accounts with NO snapshots are also included if they have > THRESHOLD entries total.
  const staleAccounts = await sql<{ id: string; new_entries: string }[]>`
    SELECT
      a.id,
      COUNT(e.id)::text AS new_entries
    FROM konto_accounts a
    LEFT JOIN LATERAL (
      SELECT snapshot_at
      FROM konto_balance_snapshots
      WHERE account_id = a.id
      ORDER BY snapshot_at DESC
      LIMIT 1
    ) s ON true
    INNER JOIN konto_entries e
      ON e.account_id = a.id
      AND (s.snapshot_at IS NULL OR e.created_at > s.snapshot_at)
    GROUP BY a.id
    HAVING COUNT(e.id) > ${THRESHOLD}
  `;

  if (staleAccounts.length === 0) {
    return;
  }

  console.error(
    `[snapshot-daemon] Found ${staleAccounts.length} account(s) exceeding threshold.`,
  );

  let successCount = 0;
  for (const account of staleAccounts) {
    try {
      await sql`SELECT take_snapshot(${account.id}::uuid)`;
      successCount++;
      console.error(
        `[snapshot-daemon] Snapshotted ${account.id} (${account.new_entries} new entries).`,
      );
    } catch (err: any) {
      console.error(
        `[snapshot-daemon] ERROR snapshotting ${account.id}: ${err.message}`,
      );
    }
  }

  const elapsed = Math.round(performance.now() - startTime);
  console.error(
    `[snapshot-daemon] Cycle complete. ${successCount}/${staleAccounts.length} snapshots taken in ${elapsed}ms.`,
  );
}

// ── Main Loop ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Run immediately on startup, then every INTERVAL_MS
  while (true) {
    try {
      await runSnapshotCycle();
    } catch (err: any) {
      console.error(`[snapshot-daemon] Cycle error: ${err.message}`);
    }

    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.error("[snapshot-daemon] SIGINT received. Shutting down.");
  await sql.end();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.error("[snapshot-daemon] SIGTERM received. Shutting down.");
  await sql.end();
  process.exit(0);
});

main().catch((err) => {
  console.error("[snapshot-daemon] FATAL:", err);
  process.exit(1);
});
