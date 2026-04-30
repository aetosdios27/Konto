# Konto Codebase Explanation & Status

## Overview
**Konto** is being developed as a high-performance, strictly-typed, double-entry accounting ledger system backed by PostgreSQL. The codebase is structured as a monorepo using **pnpm** and **Turborepo** to organize independent packages and applications efficiently.

At its current stage, the project focuses heavily on the `core` library, delivering a rock-solid, production-ready ledger engine that enforces mathematical and financial correctness at the database level.

---

## 🏗️ Architecture & Monorepo Structure

The project root is configured via `pnpm-workspace.yaml` and `turbo.json`, which separate code into two main namespaces: `apps` and `packages`.

Currently, the scaffolding is present but sparsely populated except for the core engine:

- **`apps/studio`**: **Empty**. (Intended to be a web interface or visual dashboard for ledger management/analytics).
- **`packages/cli`**: **Active**. A lightweight, functional brutalist CLI built with `cac` and `@clack/prompts`, designed to flawlessly inject the strict mathematical `konto` schema directly into raw PostgreSQL instances, AND automatically construct strongly typed DX client bindings dynamically leveraging developer TS configurations.
- **`packages/types`**: **Active**. Contains the core `KontoQueryExecutor` interface — the Inversion of Control contract every database driver adapter must implement.
- **`packages/adapters`**: **Active**. First-party adapter implementations for Vercel Postgres and Neon Serverless. The Supabase adapter is explicitly gated as experimental.
- **`packages/core`**: **Active**. Contains the complete transaction engine and database schema.

---

## ⚙️ The Core Ledger (`@konto/core`)

The `packages/core` package is a fully functional double-entry accounting library interacting directly with PostgreSQL using `postgres.js`.

### 1. Database Schema (`schema.sql`)
The PostgreSQL schema reflects a classic immutable double-entry architecture heavily tuned against fragmentation at massive scale.
- **`konto_accounts`**: Tracks individual sub-accounts (nodes). Contains constraints specifically verifying currency format. Uses **UUIDv7** rather than UUIDv4 to maintain B-Tree spatial locality and prevent Index Thrashing at billions of rows.
- **`konto_journals`**: The atomic grouping for a single transaction action. Enforces **idempotency** constraints (`UNIQUE(account_id, idempotency_key)`) so identical requests from external systems aren't double-processed, while preventing cross-tenant squatting.
- **`konto_entries`**: The immutable, append-only source of truth connecting journals to accounts. 
  - **Financial Safety**: A strict check constraint (`amount != 0`) avoids meaningless entries. A `DEFERRED` PostgreSQL constraint trigger rigorously forces `SUM(amount) = 0` per journal, making out-of-balance entries physically impossible to commit.
- **`konto_holds`**: An ephemeral table managing the two-phase commit (Escrow) system. Tracks earmarked funds, but only `PENDING` rows reduce available balance. Built with strict `expires_at` TTL checks (capped at 30 days maximum) and is strictly state-based (`PENDING`, `COMMITTED`, `ROLLED_BACK`) to ensure pristine, undeleted audit trails.
- **`konto_balance_snapshots`**: Foundation for mathematically sound O(1) balance read scaling. Checkpoints balances securely to drastically truncate the derivation scan ranges. Arbitrary INSERTs are revoked in favor of a secure `take_snapshot(account_id)` stored procedure.

### 2. Transaction Engines (`transfer.ts` & `hold.ts`)
The `transfer` and `hold` functions manage the complexity of logging financial movements reliably and atomically.
- **Zod Validation**: Validates payloads on input. Crucially, uses **`bigint`** (not `number`) to eliminate any chance of IEEE 754 floating-point errors.
- **Zero-sum Constraints**: Mathematically enforces that `Sum(Debits) + Sum(Credits) = 0` prior to any database calls, and re-validates under strict locks.
- **Deadlock Prevention**: Deterministically sorts account IDs lexicographically and requests `FOR UPDATE` pessimistic locks in that specific order, preventing standard DB deadlocks across simultaneous complex transfers and holds.
- **On-the-fly Balance Calculation**: It avoids storing stale or out-of-sync balances. The system dynamically aggregates `SUM(amount)` across `konto_entries` and explicitly subtracts only active pending holds (`konto_holds` rows with `status = 'PENDING'` that are not expired) via a zero-copy indexed `LEFT JOIN` algorithm to safely prevent double-spends (`KontoInsufficientFundsError`).
- **High-performance Bulk Inserts**: Uses PostgreSQL's `UNNEST` capabilities to batch insert all legs of the journal entries simultaneously in a single atomic payload.
- **Hold Mechanics**: Implements a strict two-phase commit escrow. You can initialize a `hold()`, and eventually resolve it permanently via `commitHold()` or abort via `rollbackHold()`. Under locks, the engine recursively validates expiration limits and dynamically derives balances to eradicate double-spend exploits.

### 3. Read API (`read.ts`)
The ledger avoids N+1 queries by offloading logic natively to PostgreSQL and aggressively mitigating Node.js floating-point decay lines across BigInt data limits.
- **`getAccount`**: High-performance isolated point lookups for account metadata.
- **`getBalance`**: Executes mathematical limits summing `konto_entries` natively and deducting only `PENDING` `konto_holds` rows that are still active under `expires_at`. Emits zero-copy available balances deterministically. It avoids the O(N) performance death spiral by referencing **`konto_balance_snapshots`** via optimized `LATERAL` joins.
- **`getJournals`**: Fetches deeply nested journal layouts, utilizing explicit `LATERAL` joins combined with sub-aggregated `json_agg` boundaries (hard-capped at 500 limits to prevent memory exhaustion). Includes flawless deterministic keyset pagination scaling efficiently across infinite historical subsets based on strictly sortable UUID timelines.

### 4. Custom Errors (`errors.ts`)
Defined specialized domain errors to clearly bubble up faults to consumer applications:
- `KontoInsufficientFundsError`
- `KontoUnbalancedTransactionError`
- `KontoDuplicateTransactionError`
- `KontoInvalidEntryError`

### 4. Tests & Quality
- The testing framework relies on **Vitest** for script running alongside **Testcontainers** (`@testcontainers/postgresql`). This allows spinning up actual isolated PostgreSQL instances natively for flawless integration testing rather than using mock DB logic. The test suite successfully verifies critical constraint enforcement (such as the deferred zero-sum trigger correctly catching unbalanced journals) and complex hold lifecycle regressions (ensuring committed/rolled-back holds release funds properly and `NULL expires_at` holds function correctly).

---

## 📍 Where the Project has Reached so far

**Completed ✅**
1. **Monorepo Setup**: Full Turborepo, Next.js configurations (though empty apps), TypeScript, Prettier, and basic linting configurations initialized.
2. **Core Schema**: Postgres structures, row-level security enabled (though policies are unwritten), optimization indexes established, including the `konto_holds` escrow foundation.
3. **Ledger Engine**: The raw financial transfer logic is highly optimized, handles high-concurrency correctly with deterministic locks, prevents deadlocks, validates payloads securely, and acts as an atomic unit of accounting truth.
4. **Escrow (Hold) Protocol Phase 1**: A fully ACID-compliant, two-phase commit system letting external applications natively block/earmark funds without corrupting balance computations. Successfully battle-tested against 1000s of concurrent transfers and holds (Pathological Benchmark).
5. **CLI Schema Injector Phase 2**: Developed `@konto/cli` featuring an extensive and incredibly fast standalone ES-module bundle built with `tsup`. It leverages `cac` and `@clack/prompts` to quickly and interactively provision database targets natively using raw `postgres.js`, entirely circumventing ORMs.
6. **Read API Phase 3**: Engineered zero-copy reading infrastructures (`read.ts`) mapping perfectly across account lookup points, real-time liquid balances mathematically deducting escrow components natively via JOINs, and complex sub-query payload mappings to emit heavily paginated Journal histories.
7. **DX Client Generator Phase 4**: Designed and implemented the `@konto/cli` generator. It dynamically emits strict application client wrappers into `node_modules/.konto`, imports the root `konto.config.ts` through the public `@konto/cli` package surface, and bridges Zod schemas into both runtime `.parse()` validation and generated TypeScript metadata inference.
8. **Serverless IoC & Migration Crawler Phase 5**: Decoupled `@konto/core` from `postgres.js` explicitly utilizing Inversion of Control via abstract `KontoQueryExecutor` mappings (stored in `packages/types`). This explicitly unlocks executing highly contested ledger math securely mapped underneath independent `@vercel/postgres` (HTTP wrappers) pools preventing edge-exhaustion runtime failures natively. Eradicated unsafe `IF NOT EXISTS` executions replacing them flawlessly with autonomous `.sql` hash trackers nested across transaction limits natively within `packages/cli/src/commands/migrate.ts`.
9. **Zod Runtime Validation (Phase 3 Exploit)**: Dropped the string DSL and fully integrated Zod schemas into `konto.config.ts`. The generated `.konto` client uses `jiti` to dynamically load these schemas at runtime and executes `.parse()` on all incoming metadata, while `defineLedger()` preserves the exact schema shapes so the generated `index.d.ts` can infer strongly typed `transfer`, `hold`, `journal`, and `account` metadata fields without boilerplate.
10. **Adapters Expansion (Phase 3)**: Implemented production-ready adapters for `@vercel/postgres` and `@neondatabase/serverless` in `@konto/adapters`. The Supabase adapter is explicitly gated — it logs a warning and throws at runtime, rather than silently failing, because a financial library that partially executes is worse than one that fails loudly.
11. **Global Singleton Proxy (Phase 3)**: Engineered a Prisma-like singleton connection architecture in the generated `.konto` package. If developers don't inject an explicit adapter, `.konto` automatically reads `DATABASE_URL` and establishes a highly optimized pool, delivering a true zero-configuration "it just works" experience.
12. **Adversarial Hardening (Phase 6)**: Successfully patched the ledger engine against severe adversarial vectors (Phantom Money, Expired Hold Double Spends, Cross-Currency injections). Escrows are now transitioned instead of deleted, journals are enforced natively with DEFERRED zero-sum constraints, and the generated `.konto` proxy fails violently if Zod limits are bypassed at runtime.
13. **Real Postgres Verification & Publishing Prep (Phase 7)**: Successfully verified the core test suite natively against real PostgreSQL instances via Testcontainers, confirming core constraint enforcement (deferred zero-sum triggers correctly rejecting unbalanced fixtures) and hold regression compliance. Configured clean npm publishing tarballs (`sideEffects`, `peerDependencies`, baseline metadata like `LICENSE` and `SECURITY.md`).
14. **Adapter Hardening & Neon Support (Phase 8)**: Completed the `@konto/adapters` package with three significant changes:
    - **BigInt serialization fix** applied to both Vercel and Neon adapters: `bigint` parameter values are now stringified before entering the `params` array. This prevents `JSON.stringify` from throwing `TypeError: Do not know how to serialize a BigInt` in HTTP-based drivers.
    - **Neon Serverless adapter** (`@konto/adapters/neon`) re-implemented as `createKontoClient(sql)` — it accepts a `neon()` client instance directly rather than a connection string, matching the Neon SDK's preferred usage pattern. Tagged template stitching, `unsafe()`, and `begin()` transaction wrapping all implemented.
    - **Supabase adapter** explicitly gated: the broken `require("postgres")` call was removed. The function is typed `never` and throws immediately with a clear message directing consumers to Vercel or Neon.
    - **Subpath exports** configured: `@konto/adapters/vercel`, `@konto/adapters/neon`, and `@konto/adapters/supabase` are all individually importable.
    - **Unit tests** added for tagged template stitching across all edge cases: single value, multiple values, BigInt, null, and array — verified on both Vercel and Neon adapters without a live database.
15. **Production Hardening & Account Types (Phase 9)**: Addressed critical schema drift between development environments and production by standardizing constraints via migrations `0003`, `0004`, and `0005`. Implemented `account_type` support (`ASSET`, `LIABILITY`, `EQUITY`, `REVENUE`, `EXPENSE`) into `@konto/core` with corresponding balance-floor constraint logic (allowing `LIABILITY`, `EQUITY`, and `REVENUE` accounts to natively carry negative credit balances). Enforced a strict `UNIQUE` constraint on account names and transitioned all genesis funding in the test suites from raw SQL inserts to proper `transfer()` mutations using `EQUITY` accounts. Shifted the CLI E2E test suite to execute natively against Testcontainers to verify the complete initial migration lifecycle.
16. **MCP Server — Agent Finance Endpoint (Phase 10)**: Scaffolded `apps/mcp-server` as a headless, stdio-based Model Context Protocol server compiled to a single Bun binary. Implements 4 read tools (`konto_get_balance`, `konto_get_journals`, `konto_list_accounts`, `konto_list_active_holds`) returning deeply structured, self-describing JSON objects. Implements 3 mutation tools (`konto_transfer`, `konto_commit_hold`, `konto_rollback_hold`) using the **Staged Intent** pattern — payloads are fully validated against Zod schemas and account existence, but mutations are never executed. Instead, a serialized `StagedIntent` object is returned requiring human cryptographic approval, enforcing the Agent Authorization Profile (AAP) oversight constraint. Zero `console.log()` usage — all diagnostics route to `stderr` to protect the JSON-RPC transport on `stdout`.

**Missing / To-Be-Done 🚧**
1. **Frontend / Studio App (`apps/studio`)**: Entirely missing. Needs a graphical interface to view accounts and journals.
2. **MCP Intent Execution Endpoint**: The MCP server stages intents but does not yet provide a human-facing execution endpoint to approve and execute `StagedIntent` objects. This requires a separate authenticated API or CLI command.
3. **Automated Balance Snapshots**: The `take_snapshot()` stored procedure exists but requires manual invocation. A background worker or `pg_cron` scheduler should automate this for $O(1)$ read performance at scale.

## Conclusion
The repository has an extremely solid mathematical/accounting foundation mimicking industry-standard core banking ledgers. Both the mutation engine and Read API are fully complete inside the core library. The system now extends beyond human developers — the MCP server enables autonomous LLM agents to query the ledger in real time while enforcing strict human-in-the-loop oversight for all financial mutations via the Staged Intent pattern. The immediate next necessary steps involve the `studio` graphical dashboard and the intent execution approval endpoint.
