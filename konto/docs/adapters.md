# Adapters

`@konto/adapters` provides first-party driver adapters that satisfy the `KontoQueryExecutor` interface from `@konto/types`. Each adapter bridges a specific PostgreSQL client library into the interface that `@konto/core` expects for all ledger operations.

---

## How Adapters Work

`@konto/core` never imports a database driver directly. All functions accept a `KontoQueryExecutor` as their first argument:

```typescript
interface KontoQueryExecutor {
  // Tagged template — parameterized query
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  // Raw SQL execution
  unsafe(sql: string, params?: unknown[]): Promise<unknown[]>;
  // Transaction wrapper
  begin<T>(fn: (tx: KontoQueryExecutor) => Promise<T>): Promise<T>;
}
```

Adapters convert each provider's native query interface into this contract. No ORM. No abstraction leakage.

### Tagged Template Stitching

Both the Vercel and Neon adapters intercept tagged template calls and convert them into parameterized `$1, $2, ...` queries:

```typescript
// Developer writes:
sql`SELECT * FROM konto_accounts WHERE id = ${accountId}`

// Adapter produces:
{ text: "SELECT * FROM konto_accounts WHERE id = $1", params: [accountId] }
```

The stitching logic (`buildQuery`) handles the following edge cases:

| Value Type | Behaviour |
| --- | --- |
| `string` | Passed through as-is |
| `number` | Passed through as-is |
| `boolean` | Passed through as-is |
| `null` | Passed through as `null` (not `"null"`) |
| `Array` | Passed through as the array reference |
| `bigint` | **Stringified** to prevent `JSON.stringify` from throwing `TypeError: Do not know how to serialize a BigInt` in HTTP-based drivers |

---

## Vercel Postgres (`@konto/adapters/vercel`)

**Status: Production-ready**

Wraps `@vercel/postgres`, which operates over HTTP connections to Vercel's managed Postgres infrastructure.

### Install

```bash
npm install @konto/adapters @vercel/postgres
```

### Usage

```typescript
import { createVercelAdapter } from '@konto/adapters/vercel';

const konto = createVercelAdapter(process.env.POSTGRES_URL);

// Use directly with @konto/core:
import { transfer, getBalance } from '@konto/core';
const result = await transfer(konto, { entries: [...] });
```

### API

```typescript
function createVercelAdapter(connectionString?: string): KontoQueryExecutor
```

- `connectionString` — optional; if omitted, the adapter reads from `process.env.POSTGRES_URL` via `@vercel/postgres` defaults.
- Transactions: uses explicit `BEGIN` / `COMMIT` / `ROLLBACK` calls on a dedicated client per transaction block, then disconnects.

---

## Neon Serverless (`@konto/adapters/neon`)

**Status: Production-ready**

Wraps the `neon()` HTTP client from `@neondatabase/serverless`. This is the correct choice for Neon-hosted databases and serverless/edge runtimes.

### Install

```bash
npm install @konto/adapters @neondatabase/serverless
```

### Usage

```typescript
import { createKontoClient } from '@konto/adapters/neon';
import { neon } from '@neondatabase/serverless';

const konto = createKontoClient(neon(process.env.DATABASE_URL));

// Use directly with @konto/core:
import { transfer, getBalance } from '@konto/core';
const result = await transfer(konto, { entries: [...] });
```

### API

```typescript
function createKontoClient(sql: ReturnType<typeof neon>): KontoQueryExecutor
```

- Accepts a `neon()` client directly. Do not pass a connection string — instantiate the client yourself and pass it in.
- Transactions: delegates to `client.transaction()` — Neon's native transaction wrapper.
- The adapter does **not** import `@neondatabase/serverless` directly; the caller provides the client, keeping the dependency truly optional.

---

## Supabase (`@konto/adapters/supabase`)

**Status: Experimental — throws at runtime**

The Supabase adapter is not production-ready. It logs a warning and throws immediately when called:

```
[konto] @konto/adapters/supabase is not yet production-ready.
Use @konto/adapters/vercel or @konto/adapters/neon instead.
```

> **Why not silently fail?** A financial library that partially executes and produces wrong results is worse than one that fails loudly. The function is typed as `never` — it makes the no-return contract explicit at the type level.

If you are running Supabase, connect directly using `postgres.js` with the Supabase connection string (TCP, not the HTTP REST API):

```typescript
import postgres from 'postgres';
// Supabase provides a direct Postgres connection string
const sql = postgres(process.env.DATABASE_URL);

// Use the raw postgres.js sql object directly as KontoQueryExecutor
import { transfer } from '@konto/core';
await transfer(sql as any, { entries: [...] });
```

This works because `postgres.js`'s tagged template interface is structurally compatible with `KontoQueryExecutor`. The `@konto/adapters/supabase` wrapper adds nothing useful on top of this until a proper implementation is written.

---

## Peer Dependencies

`@konto/adapters` declares all three drivers as **optional peer dependencies**. You only need to install the one you use:

```json
"peerDependencies": {
  "@vercel/postgres": "^0.10.0",
  "@neondatabase/serverless": "^1.1.0",
  "postgres": "^3.4.5"
},
"peerDependenciesMeta": {
  "@vercel/postgres": { "optional": true },
  "@neondatabase/serverless": { "optional": true },
  "postgres": { "optional": true }
}
```

---

## Subpath Exports

Each adapter is individually importable to avoid bundling unused drivers:

| Import | File |
| --- | --- |
| `@konto/adapters` | `dist/index.js` (all adapters re-exported) |
| `@konto/adapters/vercel` | `dist/vercel.js` |
| `@konto/adapters/neon` | `dist/neon.js` |
| `@konto/adapters/supabase` | `dist/supabase.js` |

---

## Writing Your Own Adapter

Any object that satisfies `KontoQueryExecutor` works. Here is a minimal example using `postgres.js`:

```typescript
import postgres from 'postgres';
import type { KontoQueryExecutor } from '@konto/types';

const sql = postgres(process.env.DATABASE_URL);

const executor: KontoQueryExecutor = Object.assign(
  (strings: TemplateStringsArray, ...values: unknown[]) => sql(strings, ...values as any),
  {
    unsafe: (query: string, params?: unknown[]) => sql.unsafe(query, params as any),
    begin: <T>(fn: (tx: KontoQueryExecutor) => Promise<T>) =>
      sql.begin(tx => fn(tx as unknown as KontoQueryExecutor)),
  }
);
```
