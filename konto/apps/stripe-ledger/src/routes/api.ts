import type { FastifyInstance } from "fastify";
import { getBalance, getJournals } from "@konto/core";
import { sql } from "../db.js";
import { accounts } from "../bootstrap.js";

export async function apiRoutes(fastify: FastifyInstance) {
  // ── GET /api/balance ───────────────────────────────────────────────────
  fastify.get("/api/balance", async (_request, reply) => {
    // getBalance() returns { accountId, balance, currency }
    // where balance = snapshot + entries - holds (net liquid balance).
    const result = await getBalance(sql, accounts.stripe_available_balance);

    // Map to the specified response shape.
    // This sidecar does not use holds, so held is always 0.
    // available = total = balance (the net liquid balance from getBalance).
    return reply.send({
      accountId: result.accountId,
      currency: result.currency,
      available: result.balance,
      held: 0n,
      total: result.balance,
    });
  });

  // ── GET /api/journals ──────────────────────────────────────────────────
  fastify.get("/api/journals", async (request, reply) => {
    const query = request.query as { limit?: string };
    const rawLimit = query.limit ? parseInt(query.limit, 10) : 20;
    const limit = Math.min(Math.max(1, Number.isNaN(rawLimit) ? 20 : rawLimit), 100);

    const journals = await getJournals(
      sql,
      accounts.stripe_available_balance,
      { limit }
    );

    // Derive cursor from the last journal if we received a full page.
    const lastJournal = journals.length === limit ? journals[journals.length - 1] : undefined;
    const nextCursor = lastJournal
      ? `${lastJournal.createdAt.toISOString()}_${lastJournal.id}`
      : null;

    return reply.send({
      journals,
      nextCursor,
    });
  });
}
