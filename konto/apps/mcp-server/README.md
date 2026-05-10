# @konto-ledger/mcp-server

**The headless financial endpoint for autonomous agents.**

A stdio-based [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the Konto double-entry ledger engine to LLM agents. Compiled to a single binary via Bun.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        LLM Agent (Claude, GPT, etc.)            │
│                                                                 │
│  "Transfer $50 from the merchant to the platform fee pool"      │
└────────────────────────────┬────────────────────────────────────┘
                             │  JSON-RPC over stdio
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      konto-mcp (this binary)                    │
│                                                                 │
│  ┌──────────────────────┐  ┌─────────────────────────────────┐  │
│  │   Read Tools (4)     │  │   Mutation Tools (3)            │  │
│  │                      │  │   "Staged Intent" Pattern       │  │
│  │  konto_get_balance   │  │                                 │  │
│  │  konto_get_journals  │  │  konto_transfer     → Intent    │  │
│  │  konto_list_accounts │  │  konto_commit_hold  → Intent    │  │
│  │  konto_list_active   │  │  konto_rollback_hold→ Intent    │  │
│  │  _holds              │  │                                 │  │
│  │                      │  │  ⚠ NEVER executes mutations     │  │
│  │  Returns structured  │  │  Returns StagedIntent requiring │  │
│  │  deterministic JSON  │  │  human cryptographic approval   │  │
│  └──────────────────────┘  └─────────────────────────────────┘  │
│                                                                 │
└────────────────────────────┬────────────────────────────────────┘
                             │  postgres.js
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    PostgreSQL (Konto Schema)                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## The Staged Intent Pattern (Agent Authorization Profile)

Autonomous agents are **mathematically forbidden** from unilaterally executing financial mutations. Every mutation tool (`konto_transfer`, `konto_commit_hold`, `konto_rollback_hold`) implements the **Staged Intent** pattern:

1. **Agent calls the tool** with a transfer payload.
2. **Server validates** the payload (Zod schema, zero-sum constraint, account existence).
3. **Server generates** a deterministic idempotency key and serializes a `StagedIntent` object.
4. **Server returns** the intent — it does **NOT** call `await transfer()`.
5. **Agent presents** the `StagedIntent` to a human operator for cryptographic approval.

```json
{
  "intentId": "a1b2c3d4-...",
  "stagedAt": "2026-05-01T03:00:00.000Z",
  "mutationType": "TRANSFER",
  "idempotencyKey": "mcp-f47ac10b-...",
  "payload": {
    "accountId": "...",
    "entries": [
      { "accountId": "...", "amount": "-5000" },
      { "accountId": "...", "amount": "5000" }
    ]
  },
  "summary": "Transfer with 2 legs:\n  DEBIT ... -5000\n  CREDIT ... 5000",
  "status": "PENDING_HUMAN_APPROVAL",
  "instruction": "Intent staged successfully. Human cryptographic approval is required to execute this transaction."
}
```

---

## Protocol Constraint

**`console.log()` is strictly forbidden in this package.**

The MCP protocol uses `stdout` as the JSON-RPC transport layer. Any `console.log()` call would inject non-JSON bytes into the transport and crash the agent connection. All diagnostic output is routed exclusively to `console.error()` (stderr).

---

## Tools Reference

### Read Tools (The Facts Layer)

| Tool | Description |
|---|---|
| `konto_get_balance(accountId)` | Returns `{ ledgerBalance, availableBalance, activeHolds: { count, total } }` |
| `konto_get_journals(accountId, limit?)` | Paginated journal history with hydrated entry legs |
| `konto_list_accounts(currency?, account_type?)` | List accounts with optional filters |
| `konto_list_active_holds(accountId?)` | List all PENDING, non-expired holds |

### Mutation Tools (Staged Intent)

| Tool | Description |
|---|---|
| `konto_transfer(accountId, entries, metadata?)` | Stage a zero-sum transfer intent |
| `konto_commit_hold(holdId, metadata?)` | Stage a hold settlement intent |
| `konto_rollback_hold(holdId)` | Stage a hold release intent |

---

## Setup

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.0
- PostgreSQL 16+ with the Konto schema applied (`npx @konto-ledger/cli init && npx @konto-ledger/cli migrate`)

### Build

```bash
# From the monorepo root
pnpm install

# Compile to a standalone binary
cd apps/mcp-server
bun run build:binary
```

This produces `dist/konto-mcp` — a single self-contained binary with zero runtime dependencies.

### Run

```bash
DATABASE_URL="postgres://user:pass@localhost:5432/konto" ./dist/konto-mcp
```

### Claude Desktop / Cursor Configuration

```json
{
  "mcpServers": {
    "konto": {
      "command": "/absolute/path/to/dist/konto-mcp",
      "env": {
        "DATABASE_URL": "postgres://user:pass@localhost:5432/konto"
      }
    }
  }
}
```

### Development

```bash
DATABASE_URL="postgres://..." bun run dev
```

### MCP Inspector (Debugging)

```bash
DATABASE_URL="postgres://..." npx @modelcontextprotocol/inspector bun run src/index.ts
```

---

## Dependencies

| Package | Purpose |
|---|---|
| `@modelcontextprotocol/sdk` | MCP protocol server + stdio transport |
| `@konto-ledger/core` (workspace) | Double-entry ledger engine |
| `@konto-ledger/types` (workspace) | `KontoQueryExecutor` interface |
| `postgres` | PostgreSQL driver |
| `zod` | Runtime schema validation for tool inputs |
