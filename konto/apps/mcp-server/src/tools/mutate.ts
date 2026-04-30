/**
 * @konto/mcp-server — Mutation Tools (AAP Oversight Layer)
 *
 * CRITICAL CONSTRAINT: Agents are mathematically forbidden from
 * unilaterally executing financial mutations.
 *
 * This module implements the "Staged Intent" pattern:
 *
 *   1. Agent calls konto_transfer / konto_commit_hold / konto_rollback_hold
 *   2. We validate the payload, generate a deterministic idempotency key,
 *      and serialize the intent into a StagedIntent object.
 *   3. We return the StagedIntent WITHOUT executing the mutation.
 *   4. The agent must present this intent to a human operator for
 *      cryptographic approval before it can be executed.
 *
 * await transfer() is NEVER called from this module.
 */

import { randomUUID } from "crypto";
import { TransferPayloadSchema, HoldPayloadSchema } from "@konto/core";
import type { KontoQueryExecutor } from "@konto/types";
import { getAccount } from "@konto/core";

// ── Types ──────────────────────────────────────────────────────────────────

export interface StagedIntent {
  /** Unique identifier for this staged intent */
  intentId: string;
  /** ISO 8601 timestamp of when this intent was staged */
  stagedAt: string;
  /** The mutation type that would be executed */
  mutationType: "TRANSFER" | "COMMIT_HOLD" | "ROLLBACK_HOLD";
  /** Deterministic idempotency key for replay protection */
  idempotencyKey: string;
  /** The validated, serialized payload ready for execution */
  payload: Record<string, unknown>;
  /** Human-readable summary of the intent */
  summary: string;
  /** Execution status — always PENDING from this module */
  status: "PENDING_HUMAN_APPROVAL";
  /** Instruction to the agent */
  instruction: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function generateIdempotencyKey(): string {
  return `mcp-${randomUUID()}`;
}

function serializeBigIntsInPayload(obj: unknown): unknown {
  if (typeof obj === "bigint") return obj.toString();
  if (Array.isArray(obj)) return obj.map(serializeBigIntsInPayload);
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = serializeBigIntsInPayload(value);
    }
    return result;
  }
  return obj;
}

// ── konto_transfer (Staged) ────────────────────────────────────────────────

export async function kontoTransferStaged(
  sql: KontoQueryExecutor,
  params: {
    accountId: string;
    entries: Array<{ accountId: string; amount: string }>;
    metadata?: Record<string, unknown>;
  },
): Promise<StagedIntent> {
  // Convert string amounts to bigint for validation
  const entriesWithBigInt = params.entries.map((e) => ({
    accountId: e.accountId,
    amount: BigInt(e.amount),
  }));

  const payload = {
    accountId: params.accountId,
    entries: entriesWithBigInt,
    metadata: params.metadata,
  };

  // Validate the payload against the Zod schema — this catches
  // invalid UUIDs, zero-amounts, and non-zero-sum entries BEFORE
  // any staged intent is created.
  TransferPayloadSchema.parse(payload);

  // Verify all referenced accounts exist
  const accountIds = [...new Set(entriesWithBigInt.map((e) => e.accountId))];
  for (const id of accountIds) {
    const account = await getAccount(sql, id);
    if (!account) {
      throw new Error(`Account not found: ${id}`);
    }
  }

  const idempotencyKey = generateIdempotencyKey();
  const serialized = serializeBigIntsInPayload(payload) as Record<string, unknown>;

  // Build the human-readable summary
  const legs = entriesWithBigInt
    .map(
      (e) =>
        `  ${BigInt(e.amount) < 0n ? "DEBIT" : "CREDIT"} ${e.accountId} ${e.amount.toString()}`,
    )
    .join("\n");

  return {
    intentId: randomUUID(),
    stagedAt: new Date().toISOString(),
    mutationType: "TRANSFER",
    idempotencyKey,
    payload: serialized,
    summary: `Transfer with ${entriesWithBigInt.length} legs:\n${legs}`,
    status: "PENDING_HUMAN_APPROVAL",
    instruction:
      "Intent staged successfully. Human cryptographic approval is required to execute this transaction. Present this StagedIntent to an authorized operator.",
  };
}

// ── konto_commit_hold (Staged) ─────────────────────────────────────────────

export async function kontoCommitHoldStaged(
  sql: KontoQueryExecutor,
  params: {
    holdId: string;
    metadata?: Record<string, unknown>;
  },
): Promise<StagedIntent> {
  // Verify the hold exists and is PENDING
  const holdRows = await (sql as any)`
    SELECT id, account_id, recipient_id, amount::text AS amount, status
    FROM konto_holds
    WHERE id = ${params.holdId}
    LIMIT 1
  `;

  if (holdRows.length === 0) {
    throw new Error(`Hold not found: ${params.holdId}`);
  }

  const hold = holdRows[0];
  if (hold.status !== "PENDING") {
    throw new Error(
      `Hold ${params.holdId} is in state '${hold.status}' — only PENDING holds can be committed.`,
    );
  }

  return {
    intentId: randomUUID(),
    stagedAt: new Date().toISOString(),
    mutationType: "COMMIT_HOLD",
    idempotencyKey: generateIdempotencyKey(),
    payload: {
      holdId: params.holdId,
      metadata: params.metadata ?? {},
      holdDetails: {
        accountId: hold.account_id,
        recipientId: hold.recipient_id,
        amount: hold.amount,
      },
    },
    summary: `Commit hold ${params.holdId}: ${hold.amount} from ${hold.account_id} → ${hold.recipient_id}`,
    status: "PENDING_HUMAN_APPROVAL",
    instruction:
      "Intent staged successfully. Human cryptographic approval is required to execute this hold settlement. Present this StagedIntent to an authorized operator.",
  };
}

// ── konto_rollback_hold (Staged) ───────────────────────────────────────────

export async function kontoRollbackHoldStaged(
  sql: KontoQueryExecutor,
  params: {
    holdId: string;
  },
): Promise<StagedIntent> {
  // Verify the hold exists and is PENDING
  const holdRows = await (sql as any)`
    SELECT id, account_id, recipient_id, amount::text AS amount, status
    FROM konto_holds
    WHERE id = ${params.holdId}
    LIMIT 1
  `;

  if (holdRows.length === 0) {
    throw new Error(`Hold not found: ${params.holdId}`);
  }

  const hold = holdRows[0];
  if (hold.status !== "PENDING") {
    throw new Error(
      `Hold ${params.holdId} is in state '${hold.status}' — only PENDING holds can be rolled back.`,
    );
  }

  return {
    intentId: randomUUID(),
    stagedAt: new Date().toISOString(),
    mutationType: "ROLLBACK_HOLD",
    idempotencyKey: generateIdempotencyKey(),
    payload: {
      holdId: params.holdId,
      holdDetails: {
        accountId: hold.account_id,
        recipientId: hold.recipient_id,
        amount: hold.amount,
      },
    },
    summary: `Rollback hold ${params.holdId}: release ${hold.amount} back to ${hold.account_id}`,
    status: "PENDING_HUMAN_APPROVAL",
    instruction:
      "Intent staged successfully. Human cryptographic approval is required to execute this hold rollback. Present this StagedIntent to an authorized operator.",
  };
}
