/**
 * @konto-ledger/mcp-server — Read Tools (The Facts Layer)
 *
 * These tools provide deterministic, deeply-structured, self-describing
 * JSON objects to autonomous agents. Flat arrays are forbidden.
 *
 * Every tool returns a richly typed object that an LLM can reason about
 * without needing domain knowledge of double-entry accounting.
 */

import type { KontoQueryExecutor } from "@konto-ledger/types";
import {
  getAccount,
  getBalance,
  getJournals,
} from "@konto-ledger/core";

// ── konto_get_balance ──────────────────────────────────────────────────────
export async function kontoGetBalance(
  sql: KontoQueryExecutor,
  accountId: string,
) {
  // Derive the full balance breakdown
  const balanceResult = await getBalance(sql, accountId);
  const account = await getAccount(sql, accountId);

  if (!account) {
    return {
      error: "ACCOUNT_NOT_FOUND",
      accountId,
      message: `No account exists with ID ${accountId}.`,
    };
  }

  // Query active holds separately for the structured breakdown
  const holdRows = await (sql as any)`
    SELECT COUNT(*)::text AS count, COALESCE(SUM(amount), 0)::text AS total
    FROM konto_holds
    WHERE account_id = ${accountId}
      AND status = 'PENDING'
      AND (expires_at IS NULL OR NOW() <= expires_at)
  `;

  const holds = holdRows[0];

  // Compute the ledger balance (gross, before holds)
  const ledgerBalance = balanceResult.balance + BigInt(holds?.total ?? "0");

  return {
    accountId: balanceResult.accountId,
    currency: balanceResult.currency,
    ledgerBalance: ledgerBalance.toString(),
    availableBalance: balanceResult.balance.toString(),
    activeHolds: {
      count: Number(holds?.count ?? 0),
      total: holds?.total ?? "0",
    },
  };
}

// ── konto_get_journals ─────────────────────────────────────────────────────
export async function kontoGetJournals(
  sql: KontoQueryExecutor,
  accountId: string,
  limit?: number,
  cursorId?: string,
) {
  const journals = await getJournals(sql, accountId, {
    limit: limit ?? 25,
    cursorId,
  });

  return {
    accountId,
    count: journals.length,
    journals: journals.map((j) => ({
      id: j.id,
      description: j.description,
      metadata: j.metadata,
      idempotencyKey: j.idempotencyKey,
      createdAt: j.createdAt.toISOString(),
      entries: j.entries.map((e) => ({
        accountId: e.accountId,
        amount: e.amount.toString(),
      })),
    })),
  };
}

// ── konto_list_accounts ────────────────────────────────────────────────────
export async function kontoListAccounts(
  sql: KontoQueryExecutor,
  currency?: string,
  accountType?: string,
  cursorId?: string,
) {
  const rows = await (sql as any)`
    SELECT id, name, currency, account_type, metadata, created_at
    FROM konto_accounts
    WHERE 1=1
      ${currency ? (sql as any)`AND currency = ${currency}` : (sql as any)``}
      ${accountType ? (sql as any)`AND account_type = ${accountType}` : (sql as any)``}
      ${cursorId ? (sql as any)`AND id < ${cursorId}` : (sql as any)``}
    ORDER BY id DESC
    LIMIT 100
  `;

  return {
    count: rows.length,
    accounts: rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      currency: r.currency,
      accountType: r.account_type,
      metadata: r.metadata,
      createdAt: r.created_at?.toISOString?.() ?? r.created_at,
    })),
  };
}

// ── konto_list_active_holds ────────────────────────────────────────────────
export async function kontoListActiveHolds(
  sql: KontoQueryExecutor,
  accountId?: string,
  cursorId?: string,
) {
  const rows = await (sql as any)`
    SELECT
      h.id,
      h.account_id,
      h.recipient_id,
      h.amount::text AS amount,
      h.status,
      h.idempotency_key,
      h.expires_at,
      h.created_at
    FROM konto_holds h
    WHERE h.status = 'PENDING'
      AND (h.expires_at IS NULL OR NOW() <= h.expires_at)
      ${accountId ? (sql as any)`AND h.account_id = ${accountId}` : (sql as any)``}
      ${cursorId ? (sql as any)`AND h.id < ${cursorId}` : (sql as any)``}
    ORDER BY h.id DESC
    LIMIT 100
  `;

  return {
    count: rows.length,
    holds: rows.map((r: any) => ({
      id: r.id,
      accountId: r.account_id,
      recipientId: r.recipient_id,
      amount: r.amount,
      status: r.status,
      idempotencyKey: r.idempotency_key,
      expiresAt: r.expires_at?.toISOString?.() ?? r.expires_at,
      createdAt: r.created_at?.toISOString?.() ?? r.created_at,
    })),
  };
}
