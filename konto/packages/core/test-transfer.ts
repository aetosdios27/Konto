import postgres from "postgres";
import { transfer } from "./src/transfer";

const sql = postgres({
  host: "localhost",
  port: 5432,
  database: "postgres",
  username: "postgres",
  password: "postgres",
});

const ACCOUNT_A = "550e8400-e29b-41d4-a716-446655440000";
const ACCOUNT_B = "550e8400-e29b-41d4-a716-446655440001";
const EXTERNAL = "550e8400-e29b-41d4-a716-446655440002";

async function main() {
  console.log("🚀 Running first Konto transfer test...\n");

  try {
    // 1. Create test accounts
    await sql`
      INSERT INTO konto_accounts (id, name, currency)
      VALUES
        (${ACCOUNT_A}, 'Test Account A', 'INR'),
        (${ACCOUNT_B}, 'Test Account B', 'INR'),
        (${EXTERNAL}, 'External System', 'INR')
      ON CONFLICT (id) DO NOTHING
    `;
    console.log("✅ Test accounts ready");

    // 2. Genesis injection - directly credit EXTERNAL account
    await sql`
      INSERT INTO konto_journals (description, metadata)
      VALUES ('Genesis - Initial funding', '{}')
      RETURNING id
    `.then(async ([journal]) => {
      await sql`
        INSERT INTO konto_entries (journal_id, account_id, amount)
        VALUES (${journal.id}, ${EXTERNAL}, ${1000000n})   -- +₹10,000
      `;
    });
    console.log("✅ EXTERNAL account seeded with ₹10,000");

    // 3. Real test transfer (EXTERNAL → ACCOUNT_A)
    const result = await transfer(sql, {
      idempotencyKey: `test-${Date.now()}`,
      entries: [
        { accountId: EXTERNAL, amount: -5000n }, // EXTERNAL gives ₹50
        { accountId: ACCOUNT_A, amount: 5000n }, // A receives ₹50
      ],
      metadata: { description: "First real test transfer" },
    });

    console.log("✅ TRANSFER SUCCESSFUL!");
    console.log("Journal ID →", result.journalId);
  } catch (err: any) {
    console.error("❌ Failed:", err.message);
  } finally {
    await sql.end();
  }
}

main();
