import postgres from "postgres";
import { transfer } from "./src/transfer";
import { performance } from "perf_hooks";

// 1. Explicitly configure the connection pool for a stress test
const MAX_CONNECTIONS = 100; // Adjust based on your postgres max_connections config
const sql = postgres({
  host: "localhost",
  port: 5432,
  database: "postgres",
  username: "postgres",
  password: "postgres",
  max: MAX_CONNECTIONS,
  idle_timeout: 20,
});

const ACCOUNT_A = "550e8400-e29b-41d4-a716-446655440000";
const ACCOUNT_B = "550e8400-e29b-41d4-a716-446655440001";

const CONCURRENCY = 5000;

async function main() {
  console.log(
    `🚀 Starting Konto Concurrency Hammer (${CONCURRENCY} transfers)...\n`,
  );
  console.log(`🔌 Database connection pool size: ${MAX_CONNECTIONS}`);

  try {
    // 1. Seed accounts
    await sql`
      INSERT INTO konto_accounts (id, name, currency)
      VALUES
        (${ACCOUNT_A}, 'Hammer A', 'INR'),
        (${ACCOUNT_B}, 'Hammer B', 'INR')
      ON CONFLICT (id) DO NOTHING
    `;

    // 2. Genesis Credit directly to ACCOUNT_A so it can actually send money
    await sql`
      INSERT INTO konto_journals (description) VALUES ('Genesis Hammer Funding')
      RETURNING id
    `.then(async ([j]) => {
      await sql`
        INSERT INTO konto_entries (journal_id, account_id, amount)
        VALUES (${j.id}, ${ACCOUNT_A}, ${10000000n})
      `;
    });

    console.log("✅ Accounts seeded and Account A funded with ₹100,000");
    console.log(
      "⏳ Hammering... (console suppressed during run to prevent event loop lag)",
    );

    let success = 0;
    let failed = 0;
    const latencies: number[] = [];
    const errorTypes = new Map<string, number>();

    const start = performance.now();

    // 3. Fire the load
    const promises = Array.from({ length: CONCURRENCY }, async (_, i) => {
      const reqStart = performance.now();
      try {
        await transfer(sql, {
          idempotencyKey: `hammer-${i}-${Date.now()}`,
          entries: [
            { accountId: ACCOUNT_A, amount: -100n }, // -₹1
            { accountId: ACCOUNT_B, amount: 100n }, // +₹1
          ],
        });
        success++;
        latencies.push(performance.now() - reqStart);
      } catch (e: any) {
        failed++;
        // Track error types without spamming the console
        const msg = e.message || "Unknown Error";
        errorTypes.set(msg, (errorTypes.get(msg) || 0) + 1);
      }
    });

    await Promise.all(promises);

    const durationMs = performance.now() - start;
    const durationSec = durationMs / 1000;

    // 4. Calculate Percentiles
    latencies.sort((a, b) => a - b);
    const getPercentile = (p: number) =>
      latencies.length > 0
        ? latencies[Math.floor(latencies.length * p)].toFixed(2)
        : "0.00";

    console.log("\n✅ HAMMER COMPLETE");
    console.log("--------------------------------------------------");
    console.log(`Total transfers : ${CONCURRENCY}`);
    console.log(`Successful      : ${success}`);
    console.log(`Failed          : ${failed}`);
    console.log(`Total Duration  : ${durationMs.toFixed(2)}ms`);
    console.log(
      `Throughput      : ${(CONCURRENCY / durationSec).toFixed(1)} req/sec`,
    );

    if (success > 0) {
      console.log("--------------------------------------------------");
      console.log(`Latency p50     : ${getPercentile(0.5)}ms`);
      console.log(`Latency p95     : ${getPercentile(0.95)}ms`);
      console.log(`Latency p99     : ${getPercentile(0.99)}ms`);
      console.log(
        `Latency Max     : ${latencies[latencies.length - 1]?.toFixed(2)}ms`,
      );
    }

    if (failed > 0) {
      console.log("--------------------------------------------------");
      console.log("❌ Failure Breakdown:");
      for (const [msg, count] of errorTypes.entries()) {
        console.log(`  - ${count}x: ${msg}`);
      }
    } else {
      console.log(
        "\n🎉 NO DEADLOCKS, NO RACES, NO INSUFFICIENT FUNDS — CLEAN RUN!",
      );
    }
  } catch (err: any) {
    console.error("Hammer crashed catastrophically:", err.message);
  } finally {
    await sql.end();
  }
}

main();
