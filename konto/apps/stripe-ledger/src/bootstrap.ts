import { createAccount } from "@konto/core";
import { sql } from "./db.js";

// ── Account registry ───────────────────────────────────────────────────────
// Module-level singleton populated at startup. Never hardcode UUIDs —
// account IDs are resolved dynamically from the database.
export const accounts = {
  stripe_gross_revenue: "",
  stripe_fees: "",
  stripe_available_balance: "",
};

const LEDGER_ACCOUNTS = [
  { name: "stripe_gross_revenue", currency: "USD" },
  { name: "stripe_fees", currency: "USD" },
  { name: "stripe_available_balance", currency: "USD" },
] as const;

/**
 * Idempotent bootstrap — safe to call on every startup.
 *
 * For each ledger account:
 *  1. Attempt createAccount(). If it succeeds, store the returned ID.
 *  2. If it fails with a unique constraint violation (Postgres 23505),
 *     the account already exists — fetch it by name and store its ID.
 */
export async function bootstrapAccounts(): Promise<void> {
  for (const acct of LEDGER_ACCOUNTS) {
    try {
      const created = await createAccount(sql, {
        name: acct.name,
        currency: acct.currency,
      });
      accounts[acct.name] = created.id;
    } catch (err: unknown) {
      // Postgres unique violation on account name → already exists
      if (isUniqueViolation(err)) {
        const existing = await findAccountByName(acct.name);
        if (!existing) {
          throw new Error(
            `stripe-ledger: account '${acct.name}' reported as duplicate but could not be found`
          );
        }
        accounts[acct.name] = existing.id;
      } else {
        throw err;
      }
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}

async function findAccountByName(
  name: string
): Promise<{ id: string; name: string; currency: string } | null> {
  const rows = await sql<{ id: string; name: string; currency: string }[]>`
    SELECT id, name, currency FROM konto_accounts WHERE name = ${name} LIMIT 1
  `;
  return rows[0] ?? null;
}
