import postgres from "postgres";
import { transfer } from "../src/transfer";
import { performance } from "perf_hooks";
import { v4 as uuidv4 } from "uuid";

// Max connections tuned for high-throughput parallel execution
const MAX_CONNECTIONS = 100;
const sql = postgres({
  host: "localhost",
  port: 5432,
  database: "postgres",
  username: "postgres",
  password: "postgres",
  max: MAX_CONNECTIONS,
  idle_timeout: 20,
});

const POOL_SIZE = 500;
const CONCURRENCY = 10000;

async function main() {
  console.log(`🚀 Starting Konto REALISTIC Hammer...`);
  console.log(
    `📊 Accounts: ${POOL_SIZE} | Concurrent Transfers: ${CONCURRENCY}\n`,
  );

  try {
    // 1. Generate an array of Account IDs
    const accountIds = Array.from({ length: POOL_SIZE }, () => uuidv4());

    // 2. Batch Insert Accounts
    console.log(`⏳ Seeding ${POOL_SIZE} accounts...`);
    const accountRows = accountIds.map((id, index) => ({
      id,
      name: `Pool Account ${index}`,
      currency: "INR",
    }));
    await sql`INSERT INTO konto_accounts ${sql(accountRows, "id", "name", "currency")} ON CONFLICT DO NOTHING`;

    // 3. Genesis Funding (Give everyone ₹100,000 so we don't hit random Insufficient Funds)
    console.log(`⏳ Funding accounts...`);
    await sql.begin(async (tx) => {
      const [j] =
        await tx`INSERT INTO konto_journals (description) VALUES ('Realistic Hammer Genesis') RETURNING id`;
      const entryRows = accountIds.map((id) => ({
        journal_id: j.id,
        account_id: id,
        amount: 10000000n, // ₹100,000 in cents/paisa
      }));
      // Chunking the insert just in case the pool is massive
      for (let i = 0; i < entryRows.length; i += 1000) {
        await tx`INSERT INTO konto_entries ${sql(entryRows.slice(i, i + 1000), "journal_id", "account_id", "amount")}`;
      }
    });

    console.log(
      "✅ Pool seeded and funded. \n⏳ Hammering (console suppressed)...",
    );

    let success = 0;
    let failed = 0;
    const latencies: number[] = [];
    const errorTypes = new Map<string, number>();

    const start = performance.now();

    // 4. Fire randomized load
    const promises = Array.from({ length: CONCURRENCY }, async (_, i) => {
      // Pick random sender and receiver
      const sender = accountIds[Math.floor(Math.random() * POOL_SIZE)];
      let receiver = accountIds[Math.floor(Math.random() * POOL_SIZE)];
      while (receiver === sender) {
        receiver = accountIds[Math.floor(Math.random() * POOL_SIZE)];
      }

      const reqStart = performance.now();
      try {
        await transfer(sql, {
          accountId: sender!,
          idempotencyKey: `real-hammer-${i}-${Date.now()}`,
          entries: [
            { accountId: sender!, amount: -100n },
            { accountId: receiver!, amount: 100n },
          ],
        });
        success++;
        latencies.push(performance.now() - reqStart);
      } catch (e: any) {
        failed++;
        const msg = e.message || "Unknown Error";
        errorTypes.set(msg, (errorTypes.get(msg) || 0) + 1);
      }
    });

    await Promise.all(promises);

    const durationMs = performance.now() - start;
    const durationSec = durationMs / 1000;

    // 5. Metrics
    latencies.sort((a, b) => a - b);
    const getPercentile = (p: number) =>
      latencies.length > 0
        ? latencies[Math.floor(latencies.length * p)].toFixed(2)
        : "0.00";

    console.log("\n✅ REALISTIC HAMMER COMPLETE");
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
      console.log("\n🎉 CLEAN RUN!");
    }
  } catch (err: any) {
    console.error("Hammer crashed:", err.message);
  } finally {
    await sql.end();
  }
}

main();
