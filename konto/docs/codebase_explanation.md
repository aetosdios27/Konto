# Konto Codebase Explanation & Status

## Overview
**Konto** is being developed as a high-performance, strictly-typed, double-entry accounting ledger system backed by PostgreSQL. The codebase is structured as a monorepo using **pnpm** and **Turborepo** to organize independent packages and applications efficiently.

At its current stage, the project focuses heavily on the `core` library, delivering a rock-solid, production-ready ledger engine that enforces mathematical and financial correctness at the database level.

---

## 🏗️ Architecture & Monorepo Structure

The project root is configured via `pnpm-workspace.yaml` and `turbo.json`, which separate code into two main namespaces: `apps` and `packages`.

Currently, the scaffolding is present but sparsely populated except for the core engine:

- **`apps/studio`**: **Empty**. (Intended to be a web interface or visual dashboard for ledger management/analytics).
- **`packages/cli`**: **Active**. A lightweight, functional brutalist CLI built with `cac` and `@clack/prompts`, designed to flawlessly inject the strict mathematical `konto` schema directly into any raw PostgreSQL instance without leaning on ORMs.
- **`packages/types`**: **Empty**. (Intended for shared TypeScript definitions across various packages/apps).
- **`packages/core`**: **Active development focus**. Contains the complete transaction engine and database schema.

---

## ⚙️ The Core Ledger (`@konto/core`)

The `packages/core` package is a fully functional double-entry accounting library interacting directly with PostgreSQL using `postgres.js`.

### 1. Database Schema (`schema.sql`)
The PostgreSQL schema reflects a classic immutable double-entry architecture.
- **`konto_accounts`**: Tracks individual sub-accounts (nodes). Contains constraints specifically verifying currency format.
- **`konto_journals`**: The atomic grouping for a single transaction action. Enforces **idempotency** constraints so identical requests from external systems aren't double-processed.
- **`konto_entries`**: The immutable, append-only source of truth connecting journals to accounts. 
  - **Financial Safety**: A strict check constraint (`amount != 0`) avoids meaningless entries. Positive numbers represent credits, and negative numbers represent debits.
- **`konto_holds`**: An ephemeral table managing the two-phase commit (Escrow) system. Tracks uncommitted, earmarked funds that reduce the available balance but haven't hit the immutable journal yet.

### 2. Transaction Engines (`transfer.ts` & `hold.ts`)
The `transfer` and `hold` functions manage the complexity of logging financial movements reliably and atomically.
- **Zod Validation**: Validates payloads on input. Crucially, uses **`bigint`** (not `number`) to eliminate any chance of IEEE 754 floating-point errors.
- **Zero-sum Constraints**: Mathematically enforces that `Sum(Debits) + Sum(Credits) = 0` prior to any database calls, and re-validates under strict locks.
- **Deadlock Prevention**: Deterministically sorts account IDs lexicographically and requests `FOR UPDATE` pessimistic locks in that specific order, preventing standard DB deadlocks across simultaneous complex transfers and holds.
- **On-the-fly Balance Calculation**: It avoids storing stale or out-of-sync balances. The system dynamically aggregates `SUM(amount)` across `konto_entries` and explicitly subtracts active holds (`konto_holds`) via a zero-copy indexed `LEFT JOIN` algorithm to safely prevent double-spends (`KontoInsufficientFundsError`).
- **High-performance Bulk Inserts**: Uses PostgreSQL's `UNNEST` capabilities to batch insert all legs of the journal entries simultaneously in a single atomic payload.
- **Hold Mechanics**: Implements a strict two-phase commit escrow. You can initialize a `hold()`, and eventually resolve it permanently via `commitHold()` or abort via `rollbackHold()`, all fully integrated into the deadlock-immune lexographical locking structure.

### 3. Read API (`read.ts`)
The ledger avoids N+1 queries by offloading logic natively to PostgreSQL and aggressively mitigating Node.js floating-point decay lines across BigInt data limits.
- **`getAccount`**: High-performance isolated point lookups for account metadata.
- **`getBalance`**: Executes mathematical limits summing `konto_entries` natively and deducting explicitly queried locks over `konto_holds`. Emits zero-copy available balances deterministically.
- **`getJournals`**: Fetches deeply nested journal layouts, utilizing explicit `LATERAL` joins combined with sub-aggregated `json_agg` boundaries. Includes flawless deterministic keyset pagination scaling efficiently across infinite historical subsets.

### 4. Custom Errors (`errors.ts`)
Defined specialized domain errors to clearly bubble up faults to consumer applications:
- `KontoInsufficientFundsError`
- `KontoUnbalancedTransactionError`
- `KontoDuplicateTransactionError`
- `KontoInvalidEntryError`

### 4. Tests & Quality
- The testing framework relies on **Vitest** for script running alongside **Testcontainers** (`@testcontainers/postgresql`). This allows spinning up actual isolated PostgreSQL instances natively for flawless integration testing rather than using mock DB logic.

---

## 📍 Where the Project has Reached so far

**Completed ✅**
1. **Monorepo Setup**: Full Turborepo, Next.js configurations (though empty apps), TypeScript, Prettier, and basic linting configurations initialized.
2. **Core Schema**: Postgres structures, row-level security enabled (though policies are unwritten), optimization indexes established, including the `konto_holds` escrow foundation.
3. **Ledger Engine**: The raw financial transfer logic is highly optimized, handles high-concurrency correctly with deterministic locks, prevents deadlocks, validates payloads securely, and acts as an atomic unit of accounting truth.
4. **Escrow (Hold) Protocol Phase 1**: A fully ACID-compliant, two-phase commit system letting external applications natively block/earmark funds without corrupting balance computations. Successfully battle-tested against 1000s of concurrent transfers and holds (Pathological Benchmark).
5. **CLI Schema Injector Phase 2**: Developed `@konto/cli` featuring an extensive and incredibly fast standalone ES-module bundle built with `tsup`. It leverages `cac` and `@clack/prompts` to quickly and interactively provision database targets natively using raw `postgres.js`, entirely circumventing ORMs.
6. **Read API Phase 3**: Engineered zero-copy reading infrastructures (`read.ts`) mapping perfectly across account lookup points, real-time liquid balances mathematically deducting escrow components natively via JOINs, and complex sub-query payload mappings to emit heavily paginated Journal histories.

**Missing / To-Be-Done 🚧**
1. **Frontend / Studio App (`apps/studio`)**: Entirely missing. Needs a graphical interface to view accounts and journals.
2. **API Layer**: Missing an API encapsulation. As of now, `core` expects a database instance and payload. There's no REST/GraphQL layer natively exposed yet to wire it up to other microservices across a network.

## Conclusion
The repository has an extremely solid mathematical/accounting foundation mimicking industry-standard core banking ledgers. Both the mutation engine and Read API are fully complete inside the core library. The immediate next necessary steps involve API network encapsulation, and the `studio` graphical dashboard.
