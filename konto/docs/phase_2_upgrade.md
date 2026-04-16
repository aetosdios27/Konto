# Trillion-Dollar Scale: Phase 2 Upgrade Log

This document records the exact architectural changes deployed during the Phase 2 Serverless & State Management upgrade of the Konto Ledger Protocol.

## 1. Zero-Dependency Migration Engine (`@konto/cli`)
**The Problem:** The initial CLI injected the database schema using raw `CREATE TABLE IF NOT EXISTS` expressions. This meant the database structure was hardcoded. If we ever needed to push an optimization (like a new B-Tree index) or modify foreign keys, we had no way of incrementally upgrading existing end-user instances without corrupting their state.

**The Solution:** We constructed an autonomous Migration Crawler (`migrate.ts`).
- Introduced the `_konto_migrations` tracking schema to provide deterministic state hashing.
- Replaced the hard-coded strings in `init.ts` with explicit migration files (`0001_initial_state.sql`).
- The `migrate()` core reads all un-applied SQL files and explicitly locks the execution in a transaction: `db.begin(async (tx) => { tx.unsafe(file); insert_tracker(); })`.

## 2. Serverless Inversion of Control (`@konto/types` & `@konto/adapters`)
**The Problem:** The core protocol mathematically required `postgres.js` to execute. For standard backend monoliths, this is incredibly fast. However, if deployed in a Vercel Edge runtime or an AWS account with 100+ parallel Lambda executors, each node instantiated isolated TCP connections directly to Postgres. You would instantly overwhelm your connection pool resulting in global `5xx` errors. 

**The Solution:** Inversion of Control via the `KontoQueryExecutor` interface.
- Core operations (`transfer.ts`, `hold.ts`, `read.ts`) no longer demand `postgres.js`. They rely strictly upon an arbitrary standard typescript interface defining `.begin()`, `.unsafe()`, and Tagged Template execution.
- We built `packages/adapters/vercel.ts`, wrapping the `@vercel/postgres` SDK. The adapter natively intercepts the ES6 tagged templates (`await tx<{id: string}>\`SELECT * FROM x WHERE id = ${var}\``), dynamically stitching them into hardened parameterized templates (`$1, $2`) for the underlying generic client. 

## 3. Ephemeral Monorepo Typing
*Technical Record:* We formally initialized the typescript bounds isolating `@konto/types` into its own TurbeRepo entity. We intentionally aborted the `tsup` build sequence for the `types` package to circumvent TS6059 boundaries, opting instead to route directly to `.ts` sources via native path assignments. This guarantees 0ms overhead TS propagation across the workspace.
