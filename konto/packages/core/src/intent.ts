/**
 * @konto-ledger/core — Staged Intent System
 *
 * Implements the Agent Authorization Profile (AAP) approval loop.
 *
 * stageIntent()   → Inserts a validated intent into konto_staged_intents.
 * executeIntent() → Reads a PENDING intent, executes the mutation, marks EXECUTED.
 * rejectIntent()  → Marks a PENDING intent as REJECTED without execution.
 * getPendingIntents() → Lists all PENDING, non-expired intents for human review.
 */

import type { KontoQueryExecutor } from "@konto-ledger/types";
import { transfer } from "./transfer";
import { commitHold, rollbackHold } from "./hold";

// ── Constants ──────────────────────────────────────────────────────────────

/** Default intent TTL: 24 hours. */
const DEFAULT_INTENT_TTL_MS = 24 * 60 * 60 * 1000;

/** Maximum intent TTL: 7 days. */
const MAX_INTENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── Types ──────────────────────────────────────────────────────────────────

export interface StagedIntentRecord {
  id: string;
  intentType: string;
  idempotencyKey: string | null;
  payload: Record<string, unknown>;
  status: string;
  createdAt: Date;
  executedAt: Date | null;
  expiresAt: Date | null;
}

export interface StageIntentPayload {
  intentType: "TRANSFER" | "COMMIT_HOLD" | "ROLLBACK_HOLD";
  idempotencyKey?: string;
  payload: Record<string, unknown>;
  /** Time-to-live in milliseconds. Default: 24h. Max: 7 days. */
  ttlMs?: number;
}

// ── stageIntent ────────────────────────────────────────────────────────────

export async function stageIntent(
  sql: KontoQueryExecutor,
  input: StageIntentPayload,
): Promise<{ intentId: string; expiresAt: string }> {
  const ttl = input.ttlMs ?? DEFAULT_INTENT_TTL_MS;
  if (ttl > MAX_INTENT_TTL_MS) {
    throw new Error(
      `konto: intent TTL ${ttl}ms exceeds maximum of ${MAX_INTENT_TTL_MS}ms (7 days).`,
    );
  }
  if (ttl <= 0) {
    throw new Error("konto: intent TTL must be positive.");
  }

  const expiresAt = new Date(Date.now() + ttl);

  const rows = await sql<{ id: string }[]>`
    INSERT INTO konto_staged_intents (intent_type, idempotency_key, payload, expires_at)
    VALUES (
      ${input.intentType},
      ${input.idempotencyKey ?? null},
      ${sql.json(input.payload)},
      ${expiresAt}
    )
    RETURNING id
  `;

  const row = rows[0];
  if (!row) throw new Error("konto: staged intent insert returned no rows");

  return { intentId: row.id, expiresAt: expiresAt.toISOString() };
}

// ── executeIntent ──────────────────────────────────────────────────────────

export async function executeIntent(
  sql: KontoQueryExecutor,
  intentId: string,
): Promise<{ journalId?: string; success: boolean }> {
  return sql.begin(async (tx) => {
    // Lock the intent row to prevent concurrent execution
    const intentRows = await tx<{
      id: string;
      intent_type: string;
      payload: Record<string, unknown>;
      status: string;
      expires_at: Date | null;
    }[]>`
      SELECT id, intent_type, payload, status, expires_at
      FROM konto_staged_intents
      WHERE id = ${intentId}
      FOR UPDATE
    `;

    if (intentRows.length === 0) {
      throw new Error(`konto: staged intent not found: ${intentId}`);
    }

    const intent = intentRows[0]!;

    // Check expiration before status — an expired PENDING intent should be
    // transitioned to EXPIRED, not treated as a normal PENDING.
    if (
      intent.status === "PENDING" &&
      intent.expires_at &&
      new Date() > intent.expires_at
    ) {
      await tx`
        UPDATE konto_staged_intents
        SET status = 'EXPIRED'
        WHERE id = ${intentId}
      `;
      throw new Error(
        `konto: staged intent ${intentId} has expired (expired at ${intent.expires_at.toISOString()}).`,
      );
    }

    if (intent.status !== "PENDING") {
      throw new Error(
        `konto: staged intent ${intentId} is in state '${intent.status}' — only PENDING intents can be executed.`,
      );
    }

    let result: { journalId?: string; success: boolean };

    switch (intent.intent_type) {
      case "TRANSFER": {
        const payload = intent.payload as {
          accountId: string;
          entries: Array<{ accountId: string; amount: string }>;
          metadata?: Record<string, unknown>;
        };

        // Reconstruct the transfer payload with BigInt amounts
        const transferPayload = {
          accountId: payload.accountId,
          entries: payload.entries.map((e) => ({
            accountId: e.accountId,
            amount: BigInt(e.amount),
          })),
          metadata: payload.metadata,
        };

        const { journalId } = await transfer(tx, transferPayload);
        result = { journalId, success: true };
        break;
      }

      case "COMMIT_HOLD": {
        const payload = intent.payload as {
          holdId: string;
          metadata?: Record<string, unknown>;
        };

        const { journalId } = await commitHold(tx, payload.holdId, payload.metadata);
        result = { journalId, success: true };
        break;
      }

      case "ROLLBACK_HOLD": {
        const payload = intent.payload as { holdId: string };
        await rollbackHold(tx, payload.holdId);
        result = { success: true };
        break;
      }

      default:
        throw new Error(`konto: unknown intent type: ${intent.intent_type}`);
    }

    // Mark as executed
    await tx`
      UPDATE konto_staged_intents
      SET status = 'EXECUTED', executed_at = NOW()
      WHERE id = ${intentId}
    `;

    return result;
  });
}

// ── rejectIntent ───────────────────────────────────────────────────────────

export async function rejectIntent(
  sql: KontoQueryExecutor,
  intentId: string,
): Promise<{ success: boolean }> {
  const rows = await sql<{ id: string }[]>`
    UPDATE konto_staged_intents
    SET status = 'REJECTED'
    WHERE id = ${intentId}
      AND status = 'PENDING'
      AND (expires_at IS NULL OR NOW() <= expires_at)
    RETURNING id
  `;

  if (rows.length === 0) {
    throw new Error(
      `konto: staged intent ${intentId} not found, not PENDING, or has expired.`,
    );
  }

  return { success: true };
}

// ── getPendingIntents ──────────────────────────────────────────────────────

export async function getPendingIntents(
  sql: KontoQueryExecutor,
): Promise<StagedIntentRecord[]> {
  // Auto-expire stale intents before returning the list
  await sql`
    UPDATE konto_staged_intents
    SET status = 'EXPIRED'
    WHERE status = 'PENDING'
      AND expires_at IS NOT NULL
      AND NOW() > expires_at
  `;

  const rows = await sql<any[]>`
    SELECT id, intent_type, idempotency_key, payload, status, created_at, executed_at, expires_at
    FROM konto_staged_intents
    WHERE status = 'PENDING'
    ORDER BY created_at ASC
  `;

  return rows.map((r) => ({
    id: r.id,
    intentType: r.intent_type,
    idempotencyKey: r.idempotency_key,
    payload: r.payload,
    status: r.status,
    createdAt: r.created_at,
    executedAt: r.executed_at,
    expiresAt: r.expires_at,
  }));
}
