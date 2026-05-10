/**
 * @konto-ledger/mcp-server — Database Connection
 *
 * Establishes a postgres.js connection pool from DATABASE_URL.
 * CRITICAL: All diagnostic output goes to stderr.
 * stdout is the JSON-RPC transport — writing to it kills the protocol.
 */

import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error(
    "[konto-mcp] FATAL: DATABASE_URL environment variable is not set."
  );
  process.exit(1);
}

export const sql = postgres(DATABASE_URL, {
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
  // Transform BigInt columns to string to prevent precision loss
  types: {
    bigint: postgres.BigInt,
  },
});

console.error("[konto-mcp] Database pool established.");
