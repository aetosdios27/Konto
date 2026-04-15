# Konto Codebase Explanation & Status

## Overview
**Konto** is being developed as a high-performance, strictly-typed, double-entry accounting ledger system backed by PostgreSQL. The codebase is structured as a monorepo using **pnpm** and **Turborepo** to organize independent packages and applications efficiently.

At its current stage, the project focuses heavily on the `core` library, delivering a rock-solid, production-ready ledger engine that enforces mathematical and financial correctness at the database level.

---

## 🏗️ Architecture & Monorepo Structure

The project root is configured via `pnpm-workspace.yaml` and `turbo.json`, which separate code into two main namespaces: `apps` and `packages`.

Currently, the scaffolding is present but sparsely populated except for the core engine:

- **`apps/studio`**: **Empty**. (Intended to be a web interface or visual dashboard for ledger management/analytics).
- **`packages/cli`**: **Empty**. (Intended to be command-line tooling to interact with the ledger or run migrations).
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

### 2. Transaction Engine (`transfer.ts`)
The `transfer` function manages the complexity of logging financial movements reliably.
- **Zod Validation**: Validates payloads on input. Crucially, uses **`bigint`** (not `number`) to eliminate any chance of IEEE 754 floating-point errors.
- **Zero-sum Constraints**: Mathematically enforces that `Sum(Debits) + Sum(Credits) = 0` prior to any database calls, and re-validates under strict locks.
- **Deadlock Prevention**: Deterministically sorts account IDs lexicographically and requests `FOR UPDATE` pessimistic locks in that specific order, preventing standard DB deadlocks.
- **On-the-fly Balance Calculation**: It avoids storing stale or out-of-sync balances. For any account being debit-tested, it dynamically aggregates `SUM(amount)` across associated account entries to check if an overdraft error should be thrown (`KontoInsufficientFundsError`).
- **High-performance Bulk Inserts**: Uses PostgreSQL's `UNNEST` capabilities to batch insert all legs of the journal entries simultaneously in a single atomic payload.

### 3. Custom Errors (`errors.ts`)
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
2. **Core Schema**: Postgres structures, row-level security enabled (though policies are unwritten), optimization indexes established.
3. **Ledger Engine**: The raw financial transfer logic is highly optimized, handles high-concurrency correctly with deterministic locks, prevents deadlocks, validates payloads securely, and acts as an atomic unit of accounting truth.

**Missing / To-Be-Done 🚧**
1. **Frontend / Studio App (`apps/studio`)**: Entirely missing. Needs a graphical interface to view accounts and journals.
2. **CLI Tools (`packages/cli`)**: Missing completely. Needs logic to execute commands, seed DBs, or apply ledger schemas to existing infrastructures.
3. **API Layer**: Missing an API encapsulation. As of now, `core` expects a database instance and payload. There's no REST/GraphQL layer natively exposed yet to wire it up to other microservices across a network.
4. **General Reading functions**: There is a `transfer` mutation block but simple "Get Account Balance" or "Fetch Account History" queries don't yet have dedicated exported typescript abstractions in `core`.

## Conclusion
The repository has an extremely solid mathematical/accounting foundation mimicking industry-standard core banking ledgers. The immediate next necessary steps for the project involve building out the read operations (Get Balance, List Transactions) and establishing user/developer interfaces (`studio` and `cli`).
