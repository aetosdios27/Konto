# Architecture & Physics

This document describes the internal systems architecture of the Konto Protocol. It is intended for engineers who need absolute trust in the underlying math, concurrency model, and database operations before integrating a financial ledger into production.

---

## 1. The Core Schema

Konto's data model consists of five PostgreSQL tables and one agent oversight table. They are designed to be immutable-first, append-only where possible, and strictly constrained at the database level so that application bugs cannot corrupt financial state.

### `konto_accounts`

The node table. Every financial entity (user wallet, merchant account, platform fee pool, tax escrow) is a row here.

```sql
CREATE TABLE konto_accounts (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  name         TEXT NOT NULL UNIQUE,
  account_type TEXT NOT NULL DEFAULT 'ASSET' CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
  currency     TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  metadata     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Design decisions:**
- **Account Types & Normal Balances** — Accounts are typed (`ASSET`, `LIABILITY`, `EQUITY`, `REVENUE`, `EXPENSE`). This determines if an account can hold a negative balance (normal credit balance) or is strictly guarded against dropping below zero.
- **Unique Entity Resolution** — `name` is strictly `UNIQUE`. This prevents silent account duplication on client retries or microservice restarts.
- **UUIDv7 primary keys** — Eliminates fragmentation of B-Trees at extreme scale. Allows keyset pagination on temporal sequences instead of pure randomness.
- **ISO 4217 currency check** — The `CHECK (currency ~ '^[A-Z]{3}$')` constraint rejects malformed currency codes at the database level.
- **`ON DELETE RESTRICT`** on all foreign keys pointing here — You cannot delete an account that has entries or active holds. The ledger is permanent.

### `konto_journals`

The atomic event wrapper. A journal represents a single business event ("Invoice #42 paid", "Subscription renewed"). It groups one or more entry legs together.

```sql
CREATE TABLE konto_journals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES konto_accounts(id) ON DELETE RESTRICT,
  description       TEXT,
  metadata          JSONB,
  idempotency_key   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, idempotency_key)
);
```

**Design decisions:**
- **Idempotency key scoping** — A `UNIQUE(account_id, idempotency_key)` constraint prevents double-processing while protecting against global DoS squatting. If a network retry sends the same payment request twice, the second attempt throws `KontoDuplicateTransactionError`.
- **Metadata is JSONB** — Structured, queryable, and schema-free. The typed client generator (Phase 4) overlays strict TypeScript interfaces on top of this field.

### `konto_entries`

The only source of truth. This is an append-only, immutable log of every financial movement in the system.

```sql
CREATE TABLE konto_entries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id  UUID NOT NULL REFERENCES konto_journals(id) ON DELETE RESTRICT,
  account_id  UUID NOT NULL REFERENCES konto_accounts(id) ON DELETE RESTRICT,
  amount      BIGINT NOT NULL CHECK (amount != 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Design decisions:**
- **Zero-Sum Constraint Trigger** — A `DEFERRED` Postgres constraint trigger mathematically verifies `SUM(amount) = 0` per journal before the transaction commits. Out-of-balance entries are physically impossible to persist.
- **`BIGINT`, not `NUMERIC` or `FLOAT`** — JavaScript's `number` type is IEEE 754 double-precision. Values above `2^53` silently lose precision. By using `BIGINT` in Postgres and `bigint` in TypeScript, we guarantee exact integer arithmetic for all monetary values. Store cents/paise, not dollars/rupees.
- **`CHECK (amount != 0)`** — A zero-amount entry is meaningless in double-entry accounting.
- **`ON DELETE RESTRICT` from journals** — Entries are immutable. A journal and its entries are permanently bound to preserve the absolute audit trail.
- **`ON DELETE RESTRICT` to accounts** — An account with entries cannot be deleted. Period.

### `konto_holds`

The ephemeral escrow table. Holds represent funds that are earmarked but not yet settled.

```sql
CREATE TABLE konto_holds (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES konto_accounts(id) ON DELETE RESTRICT,
  recipient_id    UUID NOT NULL REFERENCES konto_accounts(id) ON DELETE RESTRICT,
  amount          BIGINT NOT NULL CHECK (amount > 0),
  idempotency_key TEXT,
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMMITTED', 'ROLLED_BACK')),
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, idempotency_key)
);
```

**Design decisions:**
- **`CHECK (amount > 0)`** — A hold is always a positive earmark. JS validations strictly prevent 0 or negative inputs, mitigating infinite-money exploits.
- **Stateful but Immutable** — Unlike early designs, holds are *never deleted*. Their state transitions to `COMMITTED` or `ROLLED_BACK` to preserve a pristine audit trail.
- **Mechanical, not semantic** — Holds carry no metadata natively. Context for why a hold exists belongs in the journal created when the hold is committed.

---

## 2. The Derivation Engine (Read API)

Konto never stores a balance. Every call to `getBalance()` derives the number from first principles.

### The Balance Equation

For any account `a`:

$$B_a = \text{Snapshot}(a) + \sum_{e \in \text{entries}_{>snap}(a)} e.\text{amount} - \sum_{h \in \text{holds}_{active}(a)} h.\text{amount}$$

This avoids O(N) performance death loops by utilizing `LATERAL JOIN`s combined with balance snapshots:

```sql
SELECT
  a.id,
  a.currency,
  COALESCE(s.balance, 0)::text AS snapshot_balance,
  COALESCE(e.total, 0)::text AS entries_sum,
  COALESCE(h.total, 0)::text AS holds_sum
FROM konto_accounts a
LEFT JOIN LATERAL (
  SELECT balance, snapshot_at 
  FROM konto_balance_snapshots 
  WHERE account_id = a.id 
  ORDER BY snapshot_at DESC 
  LIMIT 1
) s ON true
LEFT JOIN LATERAL (
  SELECT SUM(amount) as total
  FROM konto_entries
  WHERE account_id = a.id 
    AND (s.snapshot_at IS NULL OR created_at > s.snapshot_at)
) e ON true
LEFT JOIN LATERAL (
  SELECT SUM(amount) as total
  FROM konto_holds
  WHERE account_id = a.id
    AND status = 'PENDING'
    AND (expires_at IS NULL OR NOW() <= expires_at)
) h ON true
WHERE a.id = $1
```

Only `PENDING` holds participate in available-balance derivation. Historical `COMMITTED` and `ROLLED_BACK` rows remain in `konto_holds` for auditability but must never continue depressing spendable balance.

### Balance Floor Constraints

During mutations (`transfer()` and `hold()`), Konto enforces a strict zero-balance floor (`>= 0`) for `ASSET` and `EXPENSE` accounts to prevent overdrafts. However, `LIABILITY`, `EQUITY`, and `REVENUE` accounts carry normal credit balances. Both the transfer engine and the hold engine fetch `account_type` during the pessimistic lock query and automatically bypass the floor check for credit-normal accounts, aligning with standard double-entry accounting principles. This consistency was explicitly hardened — `hold()` previously used a flat check regardless of account type.

### The V8 Float Decay Patch

Notice the `::text` cast on the sums. This is critical.

**The problem:** PostgreSQL's `BIGINT` can hold values up to `2^63 - 1`. JavaScript's `Number` type can only safely represent integers up to `2^53 - 1` (`Number.MAX_SAFE_INTEGER = 9007199254740991`). If Postgres returns a raw `BIGINT` to the `postgres.js` driver, the driver deserializes it as a JavaScript `number`. For values above `2^53`, this causes **silent precision loss** — the number is rounded to the nearest representable float.

**The fix:** Cast to `::text` inside SQL. The driver returns a string. We then convert it in TypeScript:

```typescript
const entriesSum = BigInt(row.entries_sum);  // "9007199254740993" → 9007199254740993n ✓
```

This pattern is applied everywhere: `getBalance`, `transfer` (during debit-side balance checks), and `getJournals`.

### Avoiding N+1 in Journal Hydration

`getJournals()` must return each journal with its associated entry legs. A naive implementation would query journals, then loop over each journal to fetch its entries — the classic N+1 problem.

Konto solves this with a PostgreSQL `LATERAL` join and `json_agg`:

```sql
SELECT 
  j.id, j.description, j.metadata, j.created_at,
  e.agg_entries as entries
FROM konto_journals j
JOIN LATERAL (
  SELECT json_agg(
    json_build_object(
      'accountId', account_id,
      'amount', amount::text   -- V8 Float Decay Patch applied here too
    )
  ) as agg_entries
  FROM konto_entries WHERE journal_id = j.id
) e ON true
WHERE j.id IN (
  SELECT journal_id FROM konto_entries WHERE account_id = $1
)
ORDER BY j.created_at DESC, j.id DESC   -- deterministic tie-breaker
LIMIT $2
```

**Key details:**
- `amount::text` inside `json_build_object` — JSON serialization would otherwise convert BigInt to an unquoted number, which `JSON.parse` would then truncate to a float. By casting to text, we get `"amount": "5000"` in the JSON, which we safely convert via `BigInt(entry.amount)` in TypeScript.
- `ORDER BY created_at DESC, id DESC` — Because journal IDs are UUIDv4 (random, not sequential), sorting only by timestamp is non-deterministic when two journals share the same millisecond. The `id DESC` tie-breaker guarantees stable keyset pagination.

---

## 3. Concurrency & Locking (Mutation API)

### The Deadlock Problem

Consider two concurrent requests:

- **Request A**: Transfer from Account `X` to Account `Y`. Locks `X`, then tries to lock `Y`.
- **Request B**: Transfer from Account `Y` to Account `X`. Locks `Y`, then tries to lock `X`.

Both requests hold one lock and are waiting for the other. This is a textbook deadlock. PostgreSQL will detect it and kill one transaction — but the application must handle the retry, and under high concurrency, this causes cascading failures.

### The Lexicographical Locking Solution

Konto prevents deadlocks entirely by **never allowing arbitrary lock ordering**.

Before any mutation (`transfer`, `hold`, `commitHold`), the engine:

1. Collects all account IDs involved in the operation.
2. Sorts them lexicographically (UUID string sort).
3. Acquires `FOR UPDATE` locks in that exact order.

```typescript
// From transfer.ts
function sortedUniqueIds(entries: { accountId: string }[]): string[] {
  return [...new Set(entries.map((e) => e.accountId))].sort();
}

// Then in the transaction:
const locked = await tx`
  SELECT id FROM konto_accounts
  WHERE id = ANY(${accountIds}::uuid[])
  ORDER BY id
  FOR UPDATE
`;
```

Because every concurrent request sorts locks identically, two requests involving the same accounts will always acquire them in the same order. Deadlocks become mathematically impossible.

This pattern is applied uniformly across:
- `transfer()` — All entry leg accounts.
- `hold()` — Sender and recipient.
- `commitHold()` — Sender and recipient (re-locked during settlement).

### Double Validation Under Lock

The `transfer` function validates the zero-sum constraint **twice**:

1. **Before the transaction** — A fast pre-check to reject obviously invalid payloads without opening a database transaction.
2. **After acquiring locks** — Re-validated under the pessimistic lock to ensure no concurrent mutation has changed the state between validation and execution.

```typescript
// Pre-check (fast, no DB)
assertValidEntries(parsed.entries);

// ... acquire locks, derive balances ...

// Re-check under lock (guarantees consistency)
assertValidEntries(parsed.entries);
```

---

## 4. The Escrow System

Holds implement a two-phase commit pattern for scenarios where funds must be reserved before a final decision is made (ride-sharing fare estimates, marketplace order holds, pre-authorization charges).

### Lifecycle

```
hold()  ──────┬──────▶  commitHold()  ──▶  Permanent journal entry created.
              │                              Hold status: 'COMMITTED'
              │
              └──────▶  rollbackHold() ──▶  Hold status: 'ROLLED_BACK'
                                             Funds released. No journal.
```

### Phase 1: `hold()`

1. Validate the payload (sender, recipient, amount).
2. Sort account IDs lexicographically. Acquire `FOR UPDATE` locks.
3. Derive the sender's available balance: `Σ entries − Σ active holds`.
4. If `available < hold_amount`, throw `KontoInsufficientFundsError`.
5. Insert a row into `konto_holds`.

**The hold immediately reduces available balance** — any subsequent `getBalance()` or `transfer()` will see the reduced number, preventing double-spending.

### Phase 2a: `commitHold()`

1. Lock the hold row with `FOR UPDATE` (prevents concurrent commit/rollback).
2. Lock the sender and recipient accounts (lexicographical order).
3. Mark the hold row as `COMMITTED`.
4. Create a permanent journal with two entry legs: debit sender, credit recipient.

The hold is atomically converted into an immutable ledger entry within a single transaction. Its row remains for auditability, but because balance derivation only counts `PENDING` holds, the settled row no longer reduces available funds.

### Phase 2b: `rollbackHold()`

1. Lock the hold row with `FOR UPDATE`.
2. Lock the sender account.
3. Mark the hold row as `ROLLED_BACK`.

No journal is created. The earmarked funds are silently released back to the sender's available balance, and the historical hold row remains as terminal audit state.

### Conservation of Value

The escrow system has been battle-tested with a pathological benchmark: 1000+ concurrent transfers and holds executing simultaneously against a shared set of accounts. The test verifies:

- **Zero deadlocks** — The lexicographical locking strategy holds under extreme concurrency.
- **Strict conservation** — `Σ all balances` before the test equals `Σ all balances` after. No money is created or destroyed.

---

## 5. The Agent Authorization Profile (Staged Intents)

Konto exposes a headless MCP (Model Context Protocol) server for autonomous LLM agents. Financial mutations from agents are **never executed directly**. Instead, they follow the **Staged Intent** pattern.

### `konto_staged_intents`

```sql
CREATE TABLE konto_staged_intents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_type     TEXT NOT NULL CHECK (intent_type IN ('TRANSFER', 'COMMIT_HOLD', 'ROLLBACK_HOLD')),
  idempotency_key TEXT UNIQUE,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'EXECUTED', 'REJECTED', 'EXPIRED')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  executed_at     TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ
);
```

**Design decisions:**
- **Persisted, not ephemeral** — When an agent calls `konto_transfer` via MCP, the payload is validated (Zod schema, zero-sum, account existence) and persisted to `konto_staged_intents` via `stageIntent()`. The `intentId` returned to the agent is the database-generated UUID, not an ephemeral random value. The mutation is never called.
- **Human approval loop** — A human operator reviews the intent via `npx @konto/cli approve <intent_id>`, which displays the financial impact, prompts for confirmation, and only then calls `executeIntent()` to execute the stored payload. The MCP server's response includes the exact CLI command in its `instruction` field.
- **Terminal states** — Intents transition to `EXECUTED` (approved and run), `REJECTED` (denied by operator), or `EXPIRED` (TTL exceeded). All states are immutable once set.
- **Idempotency** — Each intent carries a `UNIQUE` idempotency key (prefixed `mcp-`) to prevent duplicate staging from agent retries.
- **TTL Expiration** — Every intent is created with an `expires_at` timestamp (default: 24 hours, max: 7 days). Expired intents are automatically transitioned to `EXPIRED` on access — both when `executeIntent()` is called and when `getPendingIntents()` lists pending intents. The CLI `approve` command also checks expiration and shows remaining time. This prevents stale, unapproved intents from accumulating as financial state debt.

### End-to-End Pipeline

```
MCP Agent                          konto_staged_intents              Human Operator
   │                                       │                              │
   │  konto_transfer(payload)              │                              │
   │──────────────────────────▶ validate   │                              │
   │                           + persist ──▶ INSERT (PENDING)             │
   │◀── StagedIntent {intentId, instruction}│                             │
   │                                        │                             │
   │  "Run: konto approve <id>"             │   npx @konto/cli approve <id>
   │                                        │◀────────────────────────────│
   │                                        │   Display financial impact  │
   │                                        │   Confirm? (y/N)            │
   │                                        │                     ┌──────┴──────┐
   │                                        │                     ▼             ▼
   │                                        │──▶ EXECUTED      REJECTED
   │                                        │  (transfer() runs) (no mutation)
```

---

## 6. Observability

Konto implements dependency-injected structured logging via the `KontoLogger` interface. The core library remains zero-dependency — if no logger is injected, all log calls are silently no-oped.

```typescript
import { setKontoLogger } from '@konto/core';
import pino from 'pino';

setKontoLogger(pino()); // Compatible with pino, winston, console, or any structured logger
```

The following critical execution paths are instrumented:

| Event | Level | Data |
|---|---|---|
| Transaction begin | `debug` | `accountId`, `entryCount` |
| Lock acquisition | `debug` | `accountIds`, `lockMs` (timing) |
| Floor bypass (credit-normal) | `debug` | `accountId`, `accountType`, `net` |
| Transfer committed | `info` | `journalId`, `accountId`, `entryCount` |
| Hold created | `info` | `holdId`, `accountId`, `amount` |
| Hold committed | `info` | `holdId`, `journalId` |
| Hold rolled back | `info` | `holdId`, `accountId` |

---

## 7. The Snapshot Daemon (O(1) Read Scaling)

The `getBalance()` derivation engine references `konto_balance_snapshots` via `LATERAL` joins to avoid scanning the entire entry history. The `take_snapshot(account_id)` stored procedure checkpoints the current derived balance.

Without periodic snapshots, `getBalance()` degrades from O(1) to O(N) as the entry log grows — a silent performance bomb at scale.

The **snapshot daemon** (`packages/core/scripts/snapshot-daemon.ts`) is a lightweight Node worker that defuses this:

1. **Polls every 60 seconds** (configurable via `SNAPSHOT_INTERVAL_MS`).
2. **Identifies stale accounts** — queries for all accounts with more than 1,000 new entries (configurable via `SNAPSHOT_THRESHOLD`) since their last recorded snapshot.
3. **Calls `take_snapshot()`** for each qualifying account.
4. **Handles graceful shutdown** via `SIGINT`/`SIGTERM`.

```bash
DATABASE_URL="postgres://..." npx tsx packages/core/scripts/snapshot-daemon.ts
```

---

## 8. Konto Studio (Admin Dashboard)

Konto Studio (`apps/studio`) is a first-party Next.js 16 dashboard that provides direct graphical administration of the ledger. It connects to Postgres via raw `postgres.js` in Server Components — no ORM, no REST layer, no abstraction.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ Accounts (/) │  │ Transfers    │  │ Holds (countdown)│   │
│  │ + New Acct   │  │ + Direct     │  │ + Live timer     │   │
│  │   dialog     │  │   xfer form  │  │   via setInterval│   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
│  ┌──────────────┐  ┌──────────────────────────────────────┐  │
│  │ Account      │  │ Intents (AAP Approval Queue)        │  │
│  │ Detail [id]  │  │ + Approve / Reject buttons          │  │
│  └──────────────┘  └──────────────────────────────────────┘  │
└────────────────────────────┬────────────────────────────────┘
                             │  Server Actions (Next.js)
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                    PostgreSQL (Konto Schema)                  │
│  ┌─────────┐ ┌─────────┐ ┌────────┐ ┌──────────────────┐   │
│  │accounts │ │journals │ │entries │ │staged_intents    │   │
│  │         │ │         │ │        │ │                  │   │
│  └─────────┘ └─────────┘ └────────┘ └──────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Server Components vs Client Components

The Studio uses a deliberate split between server and client rendering:

- **Server Components** — All data fetching. Account lists, journal hydration, hold queries, and intent lists are rendered server-side with zero JavaScript shipped to the client for those views. The `LATERAL JOIN` balance derivation runs entirely in Postgres.
- **Client Components** — Interactive forms (account creation, transfers) and the hold countdown timer. The `HoldCountdown` uses `useEffect` + `setInterval` because server-rendered relative timestamps go stale immediately.

### The Genesis Funding Pattern

When a developer creates an account with an initial balance, the system needs to credit funds from somewhere — but double-entry accounting doesn't allow money from thin air.

The solution is a **deterministic system account** per currency:

```
__konto_genesis_USD__    (account_type: LIABILITY)
__konto_genesis_EUR__    (account_type: LIABILITY)
__konto_genesis_INR__    (account_type: LIABILITY)
```

The flow:

1. **Create the user's account** via `INSERT`.
2. **Find or create the genesis account** via `INSERT ... ON CONFLICT (name) DO NOTHING`, then `SELECT` its ID.
3. **Execute a zero-sum transfer**: debit genesis (goes negative), credit the new account.

**Why `LIABILITY`?**

A genesis account represents "money owed to the outside world." When real money enters the system (via a payment processor, bank transfer, etc.), the genesis account's negative balance represents the obligation the system has accepted. `LIABILITY` accounts bypass the zero-balance floor in both `transfer()` and `hold()`, so they naturally accommodate the negative balances that result from funding operations.

**Why `ON CONFLICT (name) DO NOTHING`?**

The genesis lookup must be collision-safe. The `UNIQUE` constraint on `name` (migration `0004_account_name_unique.sql`) guarantees that `INSERT ... ON CONFLICT (name) DO NOTHING` either creates the account or silently skips if it already exists. A subsequent `SELECT` retrieves the canonical ID regardless of which code path executed.

**Why double underscores?**

The `__konto_genesis_XXX__` naming convention uses double underscores to signal "this is a system-internal account, not a user-created one." The Studio UI checks for this prefix and:
- Grey out the row, disable click-through links, and add a `GENESIS` badge.
- Relabel the account as `SYSTEM_GENESIS` in transfer dropdowns.
- Keep them selectable for manual fund drainage (defensive UX).

### Idempotency in the Browser

The `DirectTransferForm` generates a `crypto.randomUUID()` on component mount (not on submit). This key is passed to the server action, which forwards it as the `idempotencyKey` to `transfer()`. The database's `UNIQUE(account_id, idempotency_key)` constraint catches duplicates.

The key is only rotated after a *successful* commit via `setIdempotencyKey(crypto.randomUUID())`. This means:
- **Double-click**: Second request carries the same key → `KontoDuplicateTransactionError`. Safe.
- **Network retry**: Same key → same error. Safe.
- **User corrects and resubmits**: Key was not rotated (previous attempt failed) → same key → same duplicate check. The user must trigger a page refresh or successful commit to get a fresh key.

