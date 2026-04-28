# Konto

**The financial primitive your Postgres database is missing.**

---

## The Problem

Somewhere in your codebase, there's a line that looks like this:

```sql
UPDATE users SET balance = balance + 50 WHERE id = 'user_abc';
```

It works. Until it doesn't.

Two requests arrive simultaneously. Both read `balance = 100`. Both write `balance = 150`. You just created $50 out of thin air. There is no audit trail. There is no rollback. There is no way to know it happened until a customer calls you.

This is not a theoretical problem. It is the #1 cause of financial discrepancies in production systems that treat money as a mutable integer on a user row.

---

## The Solution

**Konto** is a zero-dependency, ACID-compliant, double-entry accounting engine that lives inside your PostgreSQL database. It replaces ad-hoc balance columns with an immutable, append-only ledger where every cent is accounted for, every movement is atomic, and every balance is derived — never stored.

```
npm install @konto/core @konto/cli zod
```

---

## The Three Pillars

### 1. Deadlock Immune

Every mutation — transfers, holds, commits — acquires pessimistic `FOR UPDATE` row locks in **deterministic lexicographical order**. Two concurrent requests trying to lock accounts `A → B` and `B → A` will always resolve to `A → B`. Deadlocks are mathematically impossible.

### 2. Zero-Copy Balance Derivation

Balances are never stored. They are derived on the fly from the immutable entry log, heavily optimized using O(1) mathematical **Balance Snapshots**, with active unexpired escrow holds subtracted in real-time:

$$B_a = \text{Snapshot}(a) + \sum \text{Entries}_{>\text{snapshot}}(a) - \sum \text{ActiveHolds}(a)$$

No stale caches. No sync drift. The number is always correct and fetches run in `O(1)` bounds regardless of transaction history depth.

### 3. Type-Safe SDK Compiler

Define your business rules in a `konto.config.ts` file. Run `npx @konto/cli generate`. Get a custom TypeScript client where `transfer()` autocompletes your application-specific metadata fields — `invoice_id`, `order_ref`, `tax_class` — enforced at compile time.

---

## Quickstart

### Step 1: Initialize the Migration Crawler

```bash
npx @konto/cli init
```

This connects to your Postgres instance, sets up the `_konto_migrations` tracking layer, and seamlessly applies the foundational `0001_initial_state.sql` schema required to boot the ledger framework.

### Step 2: Define Your Business Schema

Create a `konto.config.ts` in your project root:

```typescript
import { z } from "zod";
import { defineLedger } from "@konto/cli";

export default defineLedger({
  transfer: z.object({
    invoice_id: z.string(),
    notes: z.string().optional(),
    tax_class: z.enum(["GST", "VAT", "EXEMPT"]),
  }),
  hold: z.object({
    reason: z.enum(["AUTH_ONLY", "ESCROW"]),
  }),
  journal: z.object({
    source: z.enum(["HOLD_COMMIT", "MANUAL_ADJUSTMENT"]),
  }),
});
```

### Step 3: Generate the Typed Client

```bash
npx @konto/cli generate
```

This outputs a strictly-typed SDK to `node_modules/.konto` — instantly available across your entire project.
Your application must depend on both `@konto/cli` and `zod`, because `konto.config.ts` imports them directly and the generator loads that file at runtime.

### Step 4: Move Money

```typescript
import { transfer, getBalance } from ".konto";

// Execute an atomic, balanced, audited transfer
const { journalId } = await transfer({
  entries: [
    { accountId: MERCHANT_ID, amount: -5000n },   // debit ₹50.00
    { accountId: PLATFORM_ID, amount: 5000n },     // credit ₹50.00
  ],
  metadata: {
    invoice_id: "INV-2026-0042",   // ← autocompleted, type-checked
  },
});

// Query the true liquid balance (entries minus active holds)
const { balance } = await getBalance(MERCHANT_ID);
console.log(`Available: ₹${balance / 100n}`);
```

That's it. Five lines to replace `UPDATE ... SET balance = balance + n` with a production-grade, auditable, race-condition-proof financial system.

---

## Generated Client API

The signatures below describe the generated `.konto` proxy. If you import directly from `@konto/core`, the raw functions still take an explicit database executor as their first argument.

| Function | Description |
| --- | --- |
| `transfer(payload)` | Atomic multi-leg journal entry with zero-sum enforcement and Zod-validated transfer metadata |
| `hold(payload)` | Earmark funds without moving them (escrow phase 1) with Zod-validated hold metadata |
| `commitHold(holdId, metadata?)` | Settle a hold into the permanent ledger with optional `journal` metadata validation |
| `rollbackHold(holdId, metadata?)` | Release a hold and optionally validate `journal` metadata before resolving the hold |
| `getAccount(accountId)` | Fetch account metadata |
| `getBalance(accountId)` | Derived liquid balance via snapshots: `Snapshot + Σ entries − Σ pending active holds` |
| `getJournals(accountId, opts)` | Paginated, hydrated transaction history |

---

## Adapters

Konto decouples the ledger engine from any specific PostgreSQL driver via the `KontoQueryExecutor` interface. First-party adapters are provided for the most common serverless Postgres providers.

### Vercel Postgres

```bash
npm install @konto/adapters @vercel/postgres
```

```typescript
import { createVercelAdapter } from '@konto/adapters/vercel';

const konto = createVercelAdapter(process.env.POSTGRES_URL);
```

### Neon Serverless

```bash
npm install @konto/adapters @neondatabase/serverless
```

```typescript
import { createKontoClient } from '@konto/adapters/neon';
import { neon } from '@neondatabase/serverless';

const konto = createKontoClient(neon(process.env.DATABASE_URL));
```

### Supabase ⚠️

> **Experimental.** The Supabase adapter is not production-ready in this release. It will throw at runtime. Use the Neon or Vercel adapters instead, or connect directly via `postgres.js` with your Supabase connection string.

---

## Architecture

- **[Architecture & Physics](./docs/architecture.md)** — Schema design, concurrency model, escrow lifecycle, and the V8 float decay patch.
- **[Client Generation](./docs/client-generation.md)** — How `defineLedger` and the `.konto` proxy trick work under the hood.
- **[Adapters](./docs/adapters.md)** — How the KontoQueryExecutor interface works, per-adapter usage, edge case handling, and peer dependency configuration.
- **[Codebase Explanation](./docs/codebase_explanation.md)** — Full module-by-module status and implementation notes.

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| Database | PostgreSQL 16+ |
| Driver Layer | Inversion of Control via `KontoQueryExecutor` (`postgres.js`, `@vercel/postgres`, etc.) |
| Validation | `zod` with native `bigint` schemas |
| CLI | `cac` + `@clack/prompts` + `picocolors` |
| Config Loader | `jiti` (runtime TS import) |
| Testing | `vitest` + `@testcontainers/postgresql` |
| Bundler | `tsup` (ESM, minified) |

---

## Monorepo Structure

```
konto/
├── packages/
│   ├── core/        # The engine. transfer, hold, read, schema, errors.
│   ├── cli/         # Deterministic migration runner + client generator.
│   ├── types/       # Generic Database Driver abstractions.
│   └── adapters/    # First-party adapters (Vercel, Neon, Supabase).
├── apps/
│   └── studio/      # (Planned) Visual ledger dashboard.
├── docs/            # Architecture, client generation, codebase docs.
└── konto.config.ts  # Example developer configuration.
```

---

## License

MIT
