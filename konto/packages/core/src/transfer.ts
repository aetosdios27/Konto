import type { KontoQueryExecutor } from "@konto-ledger/types";
import { TransferPayloadSchema } from "./schema";
import {
  KontoInsufficientFundsError,
  KontoUnbalancedTransactionError,
  KontoDuplicateTransactionError,
  KontoInvalidEntryError,
} from "./errors";
import { getKontoLogger } from "./logger";

// ── helpers ────────────────────────────────────────────────────────────────
function assertValidEntries(
  entries: { accountId: string; amount: bigint }[],
): void {
  let sum = 0n;
  const seenIds = new Set<string>();

  for (const e of entries) {
    if (e.amount === 0n)
      throw new KontoInvalidEntryError("konto: transfer amount cannot be zero");
    if (seenIds.has(e.accountId))
      throw new KontoInvalidEntryError(
        "konto: duplicate account id in single transfer leg",
      );
    seenIds.add(e.accountId);
    sum += e.amount;
  }

  if (sum !== 0n) throw new KontoUnbalancedTransactionError();
}

function sortedUniqueIds(entries: { accountId: string }[]): string[] {
  return [...new Set(entries.map((e) => e.accountId))].sort();
}

// ── transfer ───────────────────────────────────────────────────────────────
export async function transfer(
  db: KontoQueryExecutor,
  payload: unknown,
): Promise<{ journalId: string }> {
  // 1. Runtime validation
  const parsed = TransferPayloadSchema.parse(payload);

  // 2. Zero-sum and edge-case check before any DB round-trip
  assertValidEntries(parsed.entries);

  // 3. Deterministic lock order
  const accountIds = sortedUniqueIds(parsed.entries);

  // 4. Execute atomic transaction
  const log = getKontoLogger();
  log.debug("transfer: beginning transaction", { accountId: parsed.accountId, entryCount: parsed.entries.length });

  return db.begin(async (tx) => {
    // 5. Idempotency check scoped to account
    if (parsed.idempotencyKey) {
      const existing = await tx<{ id: string }[]>`
        SELECT id FROM konto_journals
        WHERE account_id = ${parsed.accountId} AND idempotency_key = ${parsed.idempotencyKey}
        LIMIT 1
      `;
      if (existing.length > 0) throw new KontoDuplicateTransactionError();
    }

    // 6. Pessimistic locks (Lexicographically sorted to mathematically prevent deadlocks)
    const lockStart = performance.now();
    const locked = await tx<{ id: string, currency: string, account_type: string }[]>`
      SELECT id, currency, account_type FROM konto_accounts
      WHERE id = ANY(${accountIds}::uuid[])
      ORDER BY id
      FOR UPDATE
    `;
    log.debug("transfer: locks acquired", { accountIds, lockMs: Math.round(performance.now() - lockStart) });

    if (locked.length !== accountIds.length) {
      const foundIds = new Set(locked.map((r) => r.id));
      const missing = accountIds.filter((id) => !foundIds.has(id));
      throw new Error(`konto: accounts not found: ${missing.join(", ")}`);
    }

    // Check currency match
    const currencies = new Set(locked.map((r) => r.currency));
    if (currencies.size > 1) {
      throw new Error("konto: cross-currency transfers are not currently supported");
    }

    // 7. Derived balances (debit accounts only to save compute)
    const debitAccountIds = [
      ...new Set(
        parsed.entries.filter((e) => e.amount < 0n).map((e) => e.accountId),
      ),
    ];

    const balances = new Map<string, bigint>();
    if (debitAccountIds.length > 0) {
      const rows = await tx<{ account_id: string; balance: string }[]>`
        SELECT
          ids.id AS account_id,
          (COALESCE(s.balance, 0) + COALESCE(e.entry_sum, 0) - COALESCE(h.hold_sum, 0))::text AS balance
        FROM unnest(${debitAccountIds}::uuid[]) AS ids(id)
        LEFT JOIN LATERAL (
          SELECT balance, snapshot_at
          FROM konto_balance_snapshots
          WHERE account_id = ids.id
          ORDER BY snapshot_at DESC
          LIMIT 1
        ) s ON true
        LEFT JOIN LATERAL (
          SELECT SUM(amount) as entry_sum
          FROM konto_entries
          WHERE account_id = ids.id
            AND (s.snapshot_at IS NULL OR created_at > s.snapshot_at)
        ) e ON true
        LEFT JOIN LATERAL (
          SELECT SUM(amount) as hold_sum
          FROM konto_holds
          WHERE account_id = ids.id
            AND status = 'PENDING'
            AND (expires_at IS NULL OR NOW() <= expires_at)
        ) h ON true
      `;
      for (const r of rows) {
        balances.set(r.account_id, BigInt(r.balance));
      }
    }

    // 8. Net balance check
    const netByAccount = new Map<string, bigint>();
    for (const entry of parsed.entries) {
      netByAccount.set(
        entry.accountId,
        (netByAccount.get(entry.accountId) ?? 0n) + entry.amount,
      );
    }

    for (const [accountId, net] of netByAccount) {
      if (net < 0n) {
        const accountType = locked.find((r) => r.id === accountId)?.account_type;
        if (accountType === "LIABILITY" || accountType === "EQUITY" || accountType === "REVENUE") {
          log.debug("transfer: floor bypass for credit-normal account", { accountId, accountType, net: net.toString() });
          continue; // These accounts carry credit balances and can go negative
        }

        const current = balances.get(accountId) ?? 0n;
        if (current + net < 0n) throw new KontoInsufficientFundsError();
      }
    }

    // 9. Zero-sum and validation re-check under lock
    assertValidEntries(parsed.entries);

    // 10. Insert journal record
    const description =
      typeof parsed.metadata?.description === "string"
        ? parsed.metadata.description
        : null;

    const metadataJson = tx.json(parsed.metadata ?? {});

    const journalRows = await tx<{ id: string }[]>`
      INSERT INTO konto_journals (account_id, description, metadata, idempotency_key)
      VALUES (
        ${parsed.accountId},
        ${description},
        ${metadataJson},
        ${parsed.idempotencyKey ?? null}
      )
      RETURNING id
    `;

    const journal = journalRows[0];
    if (!journal) throw new Error("konto: journal insert returned no rows");

    // 11. Bulk insert entries (Using high-performance UNNEST)
    await tx`
      INSERT INTO konto_entries (journal_id, account_id, amount)
      SELECT * FROM UNNEST(
        ${parsed.entries.map(() => journal.id)}::uuid[],
        ${parsed.entries.map((e) => e.accountId)}::uuid[],
        ${parsed.entries.map((e) => e.amount.toString())}::bigint[]
      ) AS t(journal_id, account_id, amount)
    `;

    log.info("transfer: committed", { journalId: journal.id, accountId: parsed.accountId, entryCount: parsed.entries.length });
    return { journalId: journal.id };
  });
}
