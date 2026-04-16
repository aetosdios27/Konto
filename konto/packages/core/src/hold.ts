import postgres from "postgres";
import { HoldPayloadSchema, jsonSchema } from "./schema";
import { z } from "zod";
import {
  KontoInsufficientFundsError,
  KontoDuplicateTransactionError,
  KontoHoldNotFoundError,
} from "./errors";

// ── helpers ────────────────────────────────────────────────────────────────
function sortedUniqueIds(accountIds: string[]): string[] {
  return [...new Set(accountIds)].sort();
}

// ── hold ───────────────────────────────────────────────────────────────
export async function hold(
  db: ReturnType<typeof postgres>,
  payload: unknown,
): Promise<{ holdId: string }> {
  const parsed = HoldPayloadSchema.parse(payload);

  if (parsed.accountId === parsed.recipientId) {
    throw new Error("konto: hold sender and recipient cannot be the same");
  }

  return db.begin(async (tx) => {
    // Idempotency check
    if (parsed.idempotencyKey) {
      const existing = await tx<{ id: string }[]>`
        SELECT id FROM konto_holds
        WHERE idempotency_key = ${parsed.idempotencyKey}
        LIMIT 1
      `;
      if (existing.length > 0) throw new KontoDuplicateTransactionError();
    }

    // Lock accounts pessimistically in lexicographical order to prevent deadlocks
    const accountIds = sortedUniqueIds([parsed.accountId, parsed.recipientId]);
    const locked = await tx<{ id: string }[]>`
      SELECT id FROM konto_accounts
      WHERE id = ANY(${accountIds}::uuid[])
      ORDER BY id
      FOR UPDATE
    `;

    if (locked.length !== accountIds.length) {
      throw new Error(`konto: accounts not found for hold`);
    }

    // Get balance of sender
    const rows = await tx<{ account_id: string; balance: string }[]>`
        SELECT
          ids.id AS account_id,
          (COALESCE(s.balance, 0) + COALESCE(e.entry_sum, 0) - COALESCE(h.hold_sum, 0))::text AS balance
        FROM unnest(ARRAY[${parsed.accountId}]::uuid[]) AS ids(id)
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
            AND (expires_at IS NULL OR NOW() <= expires_at)
        ) h ON true
    `;

    const currentBalance = rows[0] ? BigInt(rows[0].balance) : 0n;

    if (currentBalance < parsed.amount) {
      throw new KontoInsufficientFundsError();
    }

    const holdRows = await tx<{ id: string }[]>`
      INSERT INTO konto_holds (account_id, recipient_id, amount, idempotency_key, expires_at)
      VALUES (
        ${parsed.accountId},
        ${parsed.recipientId},
        ${parsed.amount.toString()},
        ${parsed.idempotencyKey ?? null},
        ${parsed.ttlMs !== undefined ? tx`NOW() + (${parsed.ttlMs} || ' milliseconds')::interval` : null}
      )
      RETURNING id
    `;

    const holdRecord = holdRows[0];
    if (!holdRecord) throw new Error("konto: hold insert returned no rows");

    return { holdId: holdRecord.id };
  });
}

// ── commitHold ───────────────────────────────────────────────────────────────
export async function commitHold(
  db: ReturnType<typeof postgres>,
  holdId: string,
  metadata?: unknown,
): Promise<{ journalId: string }> {
  let parsedMetadata: any = {};
  if (metadata !== undefined) {
    parsedMetadata = z.record(jsonSchema).parse(metadata);
  }

  return db.begin(async (tx) => {
    // Lock the hold record so no one else can rollback/commit
    const holdLocked = await tx<{
      id: string;
      account_id: string;
      recipient_id: string;
      amount: string;
    }[]>`
      SELECT id, account_id, recipient_id, amount FROM konto_holds
      WHERE id = ${holdId}
      FOR UPDATE
    `;

    if (holdLocked.length === 0) {
      throw new KontoHoldNotFoundError();
    }
    const internalHold = holdLocked[0];
    if (!internalHold) throw new KontoHoldNotFoundError();

    const accountIds = sortedUniqueIds([
      internalHold.account_id,
      internalHold.recipient_id,
    ]);

    // Pessimistic locks for the affected accounts (Lexicographically sorted to preserve deadlock immunity)
    const locked = await tx<{ id: string }[]>`
      SELECT id FROM konto_accounts
      WHERE id = ANY(${accountIds}::uuid[])
      ORDER BY id
      FOR UPDATE
    `;

    if (locked.length !== accountIds.length) {
      throw new Error(`konto: accounts not found for hold commit`);
    }

    // Delete the hold now
    await tx`
        DELETE FROM konto_holds WHERE id = ${holdId}
    `;

    // Perform the transfer
    const amountBig = BigInt(internalHold.amount);
    const entries = [
      { accountId: internalHold.account_id, amount: -amountBig },
      { accountId: internalHold.recipient_id, amount: amountBig },
    ];

    const description =
      typeof parsedMetadata?.description === "string"
        ? parsedMetadata.description
        : null;

    const metadataJson = tx.json(parsedMetadata);

    const journalRows = await tx<{ id: string }[]>`
      INSERT INTO konto_journals (description, metadata, idempotency_key)
      VALUES (
        ${description},
        ${metadataJson},
        NULL
      )
      RETURNING id
    `;

    const journal = journalRows[0];
    if (!journal) throw new Error("konto: journal insert returned no rows");

    // Bulk insert entries (Using high-performance UNNEST)
    await tx`
      INSERT INTO konto_entries (journal_id, account_id, amount)
      SELECT * FROM UNNEST(
        ${entries.map(() => journal.id)}::uuid[],
        ${entries.map((e) => e.accountId)}::uuid[],
        ${entries.map((e) => e.amount.toString())}::bigint[]
      ) AS t(journal_id, account_id, amount)
    `;

    return { journalId: journal.id };
  });
}

// ── rollbackHold ─────────────────────────────────────────────────────────────
export async function rollbackHold(
  db: ReturnType<typeof postgres>,
  holdId: string,
): Promise<{ success: boolean }> {
  return db.begin(async (tx) => {
    // Lock the hold record so no one else can commit/rollback
    const holdLocked = await tx<{ id: string; account_id: string }[]>`
      SELECT id, account_id FROM konto_holds
      WHERE id = ${holdId}
      FOR UPDATE
    `;

    if (holdLocked.length === 0) {
      throw new KontoHoldNotFoundError();
    }
    const internalHold = holdLocked[0];
    if (!internalHold) throw new KontoHoldNotFoundError();

    // Lock the sender account just to be safe and maintain the lexicographical locks convention
    await tx<{ id: string }[]>`
      SELECT id FROM konto_accounts
      WHERE id = ${internalHold.account_id}
      FOR UPDATE
    `;

    // Purge the hold
    await tx`
        DELETE FROM konto_holds WHERE id = ${holdId}
    `;

    return { success: true };
  });
}
