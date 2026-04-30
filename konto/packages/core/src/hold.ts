import type { KontoQueryExecutor } from "@konto/types";
import { HoldPayloadSchema, jsonSchema } from "./schema";
import { z } from "zod";
import {
  KontoInsufficientFundsError,
  KontoDuplicateTransactionError,
  KontoHoldNotFoundError,
} from "./errors";
import { getKontoLogger } from "./logger";

// ── helpers ────────────────────────────────────────────────────────────────
function sortedUniqueIds(accountIds: string[]): string[] {
  return [...new Set(accountIds)].sort();
}

// ── hold ───────────────────────────────────────────────────────────────
export async function hold(
  db: KontoQueryExecutor,
  payload: unknown,
): Promise<{ holdId: string }> {
  const parsed = HoldPayloadSchema.parse(payload);

  if (parsed.accountId === parsed.recipientId) {
    throw new Error("konto: hold sender and recipient cannot be the same");
  }
  
  if (parsed.amount <= 0n) {
    throw new Error("konto: hold amount must be positive");
  }

  if (parsed.ttlMs !== undefined && parsed.ttlMs > 30 * 24 * 60 * 60 * 1000) {
    throw new Error("konto: hold ttlMs exceeds 30 days maximum");
  }

  const log = getKontoLogger();
  log.debug("hold: beginning transaction", { accountId: parsed.accountId, recipientId: parsed.recipientId, amount: parsed.amount.toString() });

  return db.begin(async (tx) => {
    // Idempotency check scoped to account
    if (parsed.idempotencyKey) {
      const existing = await tx<{ id: string }[]>`
        SELECT id FROM konto_holds
        WHERE account_id = ${parsed.accountId} AND idempotency_key = ${parsed.idempotencyKey}
        LIMIT 1
      `;
      if (existing.length > 0) throw new KontoDuplicateTransactionError();
    }

    // Lock accounts pessimistically in lexicographical order to prevent deadlocks
    const accountIds = sortedUniqueIds([parsed.accountId, parsed.recipientId]);
    const locked = await tx<{ id: string, currency: string, account_type: string }[]>`
      SELECT id, currency, account_type FROM konto_accounts
      WHERE id = ANY(${accountIds}::uuid[])
      ORDER BY id
      FOR UPDATE
    `;

    if (locked.length !== accountIds.length) {
      throw new Error(`konto: accounts not found for hold`);
    }

    // Check currency match
    const currencies = new Set(locked.map(r => r.currency));
    if (currencies.size > 1) {
      throw new Error("konto: cross-currency holds are not currently supported");
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
            AND status = 'PENDING'
            AND (expires_at IS NULL OR NOW() <= expires_at)
        ) h ON true
    `;

    const currentBalance = rows[0] ? BigInt(rows[0].balance) : 0n;

    // Enforce balance floor only for ASSET and EXPENSE accounts.
    // LIABILITY, EQUITY, and REVENUE carry credit normal balances.
    const senderType = locked.find((r) => r.id === parsed.accountId)?.account_type;
    if (senderType !== "LIABILITY" && senderType !== "EQUITY" && senderType !== "REVENUE") {
      if (currentBalance < parsed.amount) {
        throw new KontoInsufficientFundsError();
      }
    } else {
      log.debug("hold: floor bypass for credit-normal account", { accountId: parsed.accountId, accountType: senderType });
    }

    const expiresAt = parsed.ttlMs !== undefined ? new Date(Date.now() + parsed.ttlMs) : null;

    const holdRows = await tx<{ id: string }[]>`
      INSERT INTO konto_holds (account_id, recipient_id, amount, idempotency_key, expires_at, status)
      VALUES (
        ${parsed.accountId},
        ${parsed.recipientId},
        ${parsed.amount.toString()},
        ${parsed.idempotencyKey ?? null},
        ${expiresAt},
        'PENDING'
      )
      RETURNING id
    `;

    const holdRecord = holdRows[0];
    if (!holdRecord) throw new Error("konto: hold insert returned no rows");

    log.info("hold: created", { holdId: holdRecord.id, accountId: parsed.accountId, amount: parsed.amount.toString() });
    return { holdId: holdRecord.id };
  });
}

// ── commitHold ───────────────────────────────────────────────────────────────
export async function commitHold(
  db: KontoQueryExecutor,
  holdId: string,
  metadata?: unknown,
): Promise<{ journalId: string }> {
  let parsedMetadata: any = {};
  if (metadata !== undefined) {
    parsedMetadata = z.record(jsonSchema).parse(metadata);
  }

  const log = getKontoLogger();
  log.debug("commitHold: beginning", { holdId });

  return db.begin(async (tx) => {
    // Lock the hold record so no one else can rollback/commit
    const holdLocked = await tx<{
      id: string;
      account_id: string;
      recipient_id: string;
      amount: string;
    }[]>`
      SELECT id, account_id, recipient_id, amount FROM konto_holds
      WHERE id = ${holdId} AND status = 'PENDING' AND (expires_at IS NULL OR NOW() <= expires_at)
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

    // Pessimistic locks for the affected accounts
    const locked = await tx<{ id: string }[]>`
      SELECT id FROM konto_accounts
      WHERE id = ANY(${accountIds}::uuid[])
      ORDER BY id
      FOR UPDATE
    `;

    if (locked.length !== accountIds.length) {
      throw new Error(`konto: accounts not found for hold commit`);
    }

    const amountBig = BigInt(internalHold.amount);

    // Re-verify balance of sender (excluding this specific hold since we are committing it)
    const rows = await tx<{ account_id: string; balance: string }[]>`
        SELECT
          ids.id AS account_id,
          (COALESCE(s.balance, 0) + COALESCE(e.entry_sum, 0) - COALESCE(h.hold_sum, 0))::text AS balance
        FROM unnest(ARRAY[${internalHold.account_id}]::uuid[]) AS ids(id)
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
          WHERE account_id = ids.id AND id != ${holdId}
            AND status = 'PENDING'
            AND (expires_at IS NULL OR NOW() <= expires_at)
        ) h ON true
    `;

    const currentBalance = rows[0] ? BigInt(rows[0].balance) : 0n;
    if (currentBalance < amountBig) {
      throw new KontoInsufficientFundsError();
    }

    // Update status instead of delete
    await tx`
        UPDATE konto_holds SET status = 'COMMITTED' WHERE id = ${holdId}
    `;

    // Perform the transfer
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
      INSERT INTO konto_journals (account_id, description, metadata, idempotency_key)
      VALUES (
        ${internalHold.account_id},
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

    log.info("commitHold: committed", { holdId, journalId: journal.id });
    return { journalId: journal.id };
  });
}

// ── rollbackHold ─────────────────────────────────────────────────────────────
export async function rollbackHold(
  db: KontoQueryExecutor,
  holdId: string,
): Promise<{ success: boolean }> {
  const log = getKontoLogger();
  log.debug("rollbackHold: beginning", { holdId });

  return db.begin(async (tx) => {
    // Lock the hold record so no one else can commit/rollback
    const holdLocked = await tx<{ id: string; account_id: string }[]>`
      SELECT id, account_id FROM konto_holds
      WHERE id = ${holdId} AND status = 'PENDING'
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

    // Mark as rolled back
    await tx`
        UPDATE konto_holds SET status = 'ROLLED_BACK' WHERE id = ${holdId}
    `;

    log.info("rollbackHold: completed", { holdId, accountId: internalHold.account_id });
    return { success: true };
  });
}
