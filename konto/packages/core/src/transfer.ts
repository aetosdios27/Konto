import postgres from "postgres";
import { TransferPayloadSchema } from "./schema";
import {
  KontoInsufficientFundsError,
  KontoUnbalancedTransactionError,
  KontoDuplicateTransactionError,
} from "./errors";

// ── helpers ────────────────────────────────────────────────────────────────
function assertZeroSum(entries: { amount: bigint }[]): void {
  const sum = entries.reduce((acc, e) => acc + e.amount, 0n);
  if (sum !== 0n) throw new KontoUnbalancedTransactionError();
}

function sortedUniqueIds(entries: { accountId: string }[]): string[] {
  return [...new Set(entries.map((e) => e.accountId))].sort();
}

// ── transfer ───────────────────────────────────────────────────────────────
export async function transfer(
  db: ReturnType<typeof postgres>,
  payload: unknown,
): Promise<{ journalId: string }> {
  // 1. Runtime validation
  const parsed = TransferPayloadSchema.parse(payload);

  // 2. Zero-sum check before any DB round-trip
  assertZeroSum(parsed.entries);

  // 3. Deterministic lock order
  const accountIds = sortedUniqueIds(parsed.entries);

  const result = await Promise.resolve(
    db.begin(async (tx) => {
      // 4. Idempotency check
      if (parsed.idempotencyKey) {
        const existing = await tx<{ id: string }[]>`
          SELECT id FROM konto_journals
          WHERE idempotency_key = ${parsed.idempotencyKey}
          LIMIT 1
        `;
        if (existing[0]) throw new KontoDuplicateTransactionError();
      }

      // 5. Pessimistic locks
      const locked = await tx<{ id: string }[]>`
        SELECT id FROM konto_accounts
        WHERE id = ANY(${accountIds}::uuid[])
        ORDER BY id
        FOR UPDATE
      `;

      if (locked.length !== accountIds.length) {
        const foundIds = new Set(locked.map((r) => r.id));
        const missing = accountIds.filter((id) => !foundIds.has(id));
        throw new Error(`konto: accounts not found: ${missing.join(", ")}`);
      }

      // 6. Derived balances (debit accounts only)
      const debitAccountIds = [
        ...new Set(
          parsed.entries.filter((e) => e.amount < 0n).map((e) => e.accountId),
        ),
      ];

      const balances = new Map<string, bigint>();
      if (debitAccountIds.length > 0) {
        const rows = await tx<{ account_id: string; balance: string }[]>`
          SELECT
            account_id,
            COALESCE(SUM(amount), 0)::text AS balance
          FROM konto_entries
          WHERE account_id = ANY(${debitAccountIds}::uuid[])
          GROUP BY account_id
        `;
        for (const r of rows) {
          balances.set(r.account_id, BigInt(r.balance));
        }
      }

      // 7. Net balance check
      const netByAccount = new Map<string, bigint>();
      for (const entry of parsed.entries) {
        netByAccount.set(
          entry.accountId,
          (netByAccount.get(entry.accountId) ?? 0n) + entry.amount,
        );
      }

      for (const [accountId, net] of netByAccount) {
        if (net < 0n) {
          const current = balances.get(accountId) ?? 0n;
          if (current + net < 0n) throw new KontoInsufficientFundsError();
        }
      }

      // 8. Zero-sum re-check under lock
      assertZeroSum(parsed.entries);

      // 9. Insert journal record
      const description =
        typeof parsed.metadata?.description === "string"
          ? parsed.metadata.description
          : null;

      // Fix for the JSONValue error: Cast happens BEFORE passing to tx.json()
      const metadataJson = tx.json((parsed.metadata ?? {}) as any);

      const journalRows = await tx<{ id: string }[]>`
        INSERT INTO konto_journals (description, metadata, idempotency_key)
        VALUES (
          ${description},
          ${metadataJson},
          ${parsed.idempotencyKey ?? null}
        )
        RETURNING id
      `;

      const journal = journalRows[0];
      if (!journal) throw new Error("konto: journal insert returned no rows");

      // 10. Bulk insert entries
      await tx`
        INSERT INTO konto_entries (journal_id, account_id, amount)
        SELECT * FROM UNNEST(
          ${parsed.entries.map(() => journal.id)}::uuid[],
          ${parsed.entries.map((e) => e.accountId)}::uuid[],
          ${parsed.entries.map((e) => e.amount.toString())}::bigint[]
        ) AS t(journal_id, account_id, amount)
      `;

      return { journalId: journal.id };
    }),
  );

  return result;
}
