/**
 * @konto/mcp-server — Entrypoint
 *
 * A headless, stdio-based MCP server for autonomous agent finance.
 * Communicates exclusively via stdin/stdout JSON-RPC.
 *
 * PROTOCOL LAW: console.log() is FORBIDDEN in this entire package.
 * stdout = JSON-RPC transport. Logging to it corrupts the protocol.
 * All diagnostics go to console.error() (stderr).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { sql } from "./db.js";
import {
  kontoGetBalance,
  kontoGetJournals,
  kontoListAccounts,
  kontoListActiveHolds,
} from "./tools/read.js";
import {
  kontoTransferStaged,
  kontoCommitHoldStaged,
  kontoRollbackHoldStaged,
} from "./tools/mutate.js";

// ── Server Initialization ──────────────────────────────────────────────────

const server = new McpServer({
  name: "konto-mcp",
  version: "0.1.0",
});

// ═══════════════════════════════════════════════════════════════════════════
// READ TOOLS (The Facts Layer)
// Agents cannot do financial math. We return deterministic, deeply
// structured, self-describing JSON objects.
// ═══════════════════════════════════════════════════════════════════════════

server.tool(
  "konto_get_balance",
  "Retrieve the full balance breakdown for an account, including gross ledger balance, available (liquid) balance after holds, and active hold details.",
  {
    accountId: z.string().uuid().describe("The UUID of the account to query."),
  },
  async ({ accountId }) => {
    try {
      const result = await kontoGetBalance(sql as any, accountId);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      console.error(`[konto-mcp] konto_get_balance error:`, err.message);
      return {
        content: [
          { type: "text", text: JSON.stringify({ error: err.message }) },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "konto_get_journals",
  "Retrieve paginated journal entries (transaction history) for an account. Each journal contains its constituent entry legs with amounts.",
  {
    accountId: z
      .string()
      .uuid()
      .describe("The UUID of the account to query journals for."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum number of journals to return. Default 25, max 100."),
  },
  async ({ accountId, limit }) => {
    try {
      const result = await kontoGetJournals(sql as any, accountId, limit);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      console.error(`[konto-mcp] konto_get_journals error:`, err.message);
      return {
        content: [
          { type: "text", text: JSON.stringify({ error: err.message }) },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "konto_list_accounts",
  "List all accounts in the ledger, optionally filtered by currency code (ISO 4217) or account type (ASSET, LIABILITY, EQUITY, REVENUE, EXPENSE).",
  {
    currency: z
      .string()
      .length(3)
      .optional()
      .describe("ISO 4217 currency code to filter by (e.g. 'USD', 'INR')."),
    account_type: z
      .enum(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"])
      .optional()
      .describe("Account type to filter by."),
  },
  async ({ currency, account_type }) => {
    try {
      const result = await kontoListAccounts(sql as any, currency, account_type);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      console.error(`[konto-mcp] konto_list_accounts error:`, err.message);
      return {
        content: [
          { type: "text", text: JSON.stringify({ error: err.message }) },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "konto_list_active_holds",
  "List all currently active (PENDING, non-expired) holds across the ledger, or for a specific account.",
  {
    accountId: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Optional account UUID to filter holds. If omitted, returns all active holds.",
      ),
  },
  async ({ accountId }) => {
    try {
      const result = await kontoListActiveHolds(sql as any, accountId);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      console.error(
        `[konto-mcp] konto_list_active_holds error:`,
        err.message,
      );
      return {
        content: [
          { type: "text", text: JSON.stringify({ error: err.message }) },
        ],
        isError: true,
      };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// MUTATION TOOLS (AAP Oversight — Staged Intent Pattern)
//
// These tools validate the payload and return a StagedIntent object.
// They do NOT execute the mutation.
// The agent must present the intent to a human operator for approval.
// ═══════════════════════════════════════════════════════════════════════════

server.tool(
  "konto_transfer",
  "Stage a double-entry transfer intent. Validates zero-sum constraint and account existence. Does NOT execute — returns a StagedIntent requiring human cryptographic approval.",
  {
    accountId: z
      .string()
      .uuid()
      .describe("The primary account UUID initiating this transfer."),
    entries: z
      .array(
        z.object({
          accountId: z.string().uuid().describe("Account UUID for this leg."),
          amount: z
            .string()
            .describe(
              "Amount in minor units as a string (e.g. '5000' for $50.00). Negative for debits, positive for credits. Must sum to zero.",
            ),
        }),
      )
      .min(2)
      .describe("The entry legs of the transfer. Must be zero-sum."),
    metadata: z
      .record(z.unknown())
      .optional()
      .describe("Optional structured metadata for the journal entry."),
  },
  async ({ accountId, entries, metadata }) => {
    try {
      const intent = await kontoTransferStaged(sql as any, {
        accountId,
        entries,
        metadata,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(intent, null, 2) }],
      };
    } catch (err: any) {
      console.error(`[konto-mcp] konto_transfer error:`, err.message);
      return {
        content: [
          { type: "text", text: JSON.stringify({ error: err.message }) },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "konto_commit_hold",
  "Stage a hold commitment intent. Validates the hold exists and is PENDING. Does NOT execute — returns a StagedIntent requiring human cryptographic approval.",
  {
    holdId: z
      .string()
      .uuid()
      .describe("The UUID of the PENDING hold to commit."),
    metadata: z
      .record(z.unknown())
      .optional()
      .describe("Optional metadata for the resulting journal entry."),
  },
  async ({ holdId, metadata }) => {
    try {
      const intent = await kontoCommitHoldStaged(sql as any, {
        holdId,
        metadata,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(intent, null, 2) }],
      };
    } catch (err: any) {
      console.error(`[konto-mcp] konto_commit_hold error:`, err.message);
      return {
        content: [
          { type: "text", text: JSON.stringify({ error: err.message }) },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "konto_rollback_hold",
  "Stage a hold rollback intent. Validates the hold exists and is PENDING. Does NOT execute — returns a StagedIntent requiring human cryptographic approval.",
  {
    holdId: z
      .string()
      .uuid()
      .describe("The UUID of the PENDING hold to roll back."),
  },
  async ({ holdId }) => {
    try {
      const intent = await kontoRollbackHoldStaged(sql as any, { holdId });
      return {
        content: [{ type: "text", text: JSON.stringify(intent, null, 2) }],
      };
    } catch (err: any) {
      console.error(`[konto-mcp] konto_rollback_hold error:`, err.message);
      return {
        content: [
          { type: "text", text: JSON.stringify({ error: err.message }) },
        ],
        isError: true,
      };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[konto-mcp] MCP server connected via stdio transport.");
  console.error("[konto-mcp] Registered 7 tools (4 read, 3 staged mutation).");
}

main().catch((err) => {
  console.error("[konto-mcp] FATAL:", err);
  process.exit(1);
});
