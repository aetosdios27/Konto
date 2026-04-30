/**
 * @konto/core — Staged Intent System
 *
 * Implements the Agent Authorization Profile (AAP) approval loop.
 *
 * stageIntent()   → Inserts a validated intent into konto_staged_intents.
 * executeIntent() → Reads a PENDING intent, executes the mutation, marks EXECUTED.
 * rejectIntent()  → Marks a PENDING intent as REJECTED without execution.
 * getPendingIntents() → Lists all PENDING intents for human review.
 */

import type { KontoQueryExecutor } from "@konto/types";
import { transfer } from "./transfer";
import { commitHold, rollbackHold } from "./hold";

// ── Types ──────────────────────────────────────────────────────────────────

export interface StagedIntentRecord {
  id: string;
  intentType: string;
  idempotencyKey: string | null;
  payload: Record<string, unknown>;
  status: string;
  createdAt: Date;
  executedAt: Date | null;
}

export interface StageIntentPayload {
  intentType: "TRANSFER" | "COMMIT_HOLD" | "ROLLBACK_HOLD";
  idempotencyKey?: string;
  payload: Record<string, unknown>;
}

// ── stageIntent ────────────────────────────────────────────────────────────

export async function stageIntent(
  sql: KontoQueryExecutor,
  input: StageIntentPayload,
): Promise<{ intentId: string }> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO konto_staged_intents (intent_type, idempotency_key, payload)
    VALUES (
      ${input.intentType},
      ${input.idempotencyKey ?? null},
      ${sql.json(input.payload)}
    )
    RETURNING id
  `;

  const row = rows[0];
  if (!row) throw new Error("konto: staged intent insert returned no rows");

  return { intentId: row.id };
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
    }[]>`
      SELECT id, intent_type, payload, status
      FROM konto_staged_intents
      WHERE id = ${intentId}
      FOR UPDATE
    `;

    if (intentRows.length === 0) {
      throw new Error(`konto: staged intent not found: ${intentId}`);
    }

    const intent = intentRows[0]!;

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
    WHERE id = ${intentId} AND status = 'PENDING'
    RETURNING id
  `;

  if (rows.length === 0) {
    throw new Error(
      `konto: staged intent ${intentId} not found or not in PENDING state.`,
    );
  }

  return { success: true };
}

// ── getPendingIntents ──────────────────────────────────────────────────────

export async function getPendingIntents(
  sql: KontoQueryExecutor,
): Promise<StagedIntentRecord[]> {
  const rows = await sql<any[]>`
    SELECT id, intent_type, idempotency_key, payload, status, created_at, executed_at
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
  }));
}
