# Client Generation

This document explains how Konto's TypeScript SDK generator works — from the developer-facing configuration file to the internal engineering trick that makes `import { transfer } from '.konto'` resolve globally without any `tsconfig.json` modifications.

---

## The Problem

Most ledger libraries accept metadata as `Record<string, any>` or `unknown`. This means a transfer call looks like this:

```typescript
await transfer({
  entries: [...],
  metadata: {
    invoce_id: "INV-001",  // ← typo. "invoce" instead of "invoice". No error.
    // forgot order_ref entirely. No error.
  },
});
```

This compiles. This deploys. And three months later, an accounting reconciliation fails because 12,000 transfers are missing their `order_ref` field, and 400 have a misspelled `invoce_id` that no downstream system can parse.

The root cause: **the type system and runtime validation had no opinion about what metadata should contain.**

---

## The Solution: `konto.config.ts`

Konto solves this by letting you define your metadata schema once using **Zod**, then generating a typed client that enforces it at compile time *and* validates it at runtime.

Because `konto.config.ts` is real executable project code, the consuming app must have both `@konto-ledger/cli` and `zod` installed. The generator loads that file directly via `jiti`; it is not parsing a static JSON manifest.

`defineLedger()` is intentionally typed as a generic identity helper: it returns the exact Zod object map you pass in, rather than widening it to a loose interface. That detail is what allows the generated `.d.ts` file to preserve your literal schema shapes and expose precise metadata inference back to application code.

### The `defineLedger` API

Create a `konto.config.ts` in your project root:

```typescript
import { z } from "zod";
import { defineLedger } from "@konto-ledger/cli";

export default defineLedger({
  transfer: z.object({
    invoice_id: z.string(),
    order_ref: z.string(),
    notes: z.string().optional(),
    tax_class: z.enum(['GST', 'VAT', 'EXEMPT']),
  }),
  hold: z.object({
    reason: z.string(),
  }),
  journal: z.object({
    source: z.enum(['HOLD_COMMIT', 'MANUAL_ADJUSTMENT']),
  }),
  account: z.object({
    status: z.enum(['ACTIVE', 'FROZEN', 'CLOSED']),
  }),
});
```

### Schema Sections

| Key | Applies To | Description |
| --- | --- | --- |
| `transfer` | `transfer()` metadata | Fields required/expected on every transfer operation |
| `hold` | `hold()` metadata | Fields required/expected when creating escrow holds |
| `journal` | `commitHold()` metadata | Fields attached to journals created during hold settlement |
| `account` | Account metadata | Typed metadata for account-level properties |

---

## The `.konto` Proxy (Under the Hood)

When you run `npx @konto-ledger/cli generate`, the generator doesn't output a file to your `src/` directory. It writes directly to `node_modules/.konto/`. This is the exact same pattern used by Prisma.

### What Gets Generated

The generator creates three files inside `node_modules/.konto/`:

#### `package.json`

```json
{
  "name": ".konto",
  "version": "1.0.0",
  "main": "index.js",
  "types": "index.d.ts",
  "type": "module"
}
```

This turns the directory into a valid Node.js package. When TypeScript or Node encounters `import { transfer } from '.konto'`, it resolves to `node_modules/.konto/index.js` (runtime) and `node_modules/.konto/index.d.ts` (types) — no `tsconfig.json` path aliases required.

The developer-facing config import also comes from the package entrypoint:

```typescript
import { defineLedger } from "@konto-ledger/cli";
```

That means `@konto-ledger/cli` must act as both a CLI binary and a normal ESM import surface. The config contract is only truly valid when both of those entrypoints work.

#### `index.d.ts`

The type declaration file completely bridges your Zod schema into TypeScript inferences via a relative module import back to your root project. It dynamically extracts the types:

```typescript
import type config from "../../konto.config";
import type { z } from "zod";

type ExtractMetadata<T> = T extends z.ZodType<any, any, any> ? z.infer<T> : Record<string, any>;
type Config = typeof config;
export type TransferMetadata =
  Config extends { transfer: infer T } ? ExtractMetadata<T> : Record<string, any>;
```

The developer now gets full autocomplete on `metadata.invoice_id`, compile-time errors on `metadata.invoce_id`, and type errors if they forget `order_ref`.

#### `index.js`

The runtime proxy. It implements a zero-configuration singleton (just like `PrismaClient`) and executes your actual Zod schemas against incoming payloads dynamically:

```javascript
import { transfer as coreTransfer } from "@konto-ledger/core";
import { createJiti } from "jiti";
import postgres from "postgres";
import path from "path";

const jiti = createJiti(import.meta.url);
const configPath = path.resolve(process.cwd(), "../../konto.config.ts");
const configModule = await jiti.import(configPath, { default: true });
const config = configModule.default || configModule;

let globalAdapter = null;
function getAdapter() {
  if (globalAdapter) return globalAdapter;
  globalAdapter = postgres(process.env.DATABASE_URL);
  return globalAdapter;
}

export async function transfer(payload) {
  const adapter = getAdapter();
  if (config?.transfer && payload.metadata) {
    payload.metadata = config.transfer.parse(payload.metadata);
  }
  return coreTransfer(adapter, payload);
}
```

There is massive power in this abstraction. The `.konto` layer evaluates the exact same Zod schema you exported, providing an impenetrable wall of runtime validation before funds ever move.

The generated client also intentionally hides the database handle from the public call signature. Application code calls:

```typescript
import { transfer, getBalance } from ".konto";

await transfer({ entries: [...], metadata: {...} });
const { balance } = await getBalance(accountId);
```

The proxy owns adapter lookup internally, either through `setKontoAdapter()` or a lazy `DATABASE_URL`-backed singleton.

### Adapter Integration

The generated `.konto` proxy defaults to a `postgres.js` singleton, but the underlying `KontoQueryExecutor` interface can be satisfied by any first-party adapter:

| Adapter | Package | Status |
| --- | --- | --- |
| `postgres.js` (direct) | — | **Production** |
| Vercel Postgres | `@konto-ledger/adapters/vercel` | **Production** |
| Neon Serverless | `@konto-ledger/adapters/neon` | **Production** |
| Supabase | `@konto-ledger/adapters/supabase` | **Experimental** — throws at runtime |

To use the Neon adapter with the generated client:

```typescript
import { createKontoClient } from '@konto-ledger/adapters/neon';
import { neon } from '@neondatabase/serverless';
import { setKontoAdapter } from '.konto';

setKontoAdapter(createKontoClient(neon(process.env.DATABASE_URL)));
```

### Why `node_modules/` Instead of `src/`?

By default, the generator outputs to `node_modules/.konto` for three reasons:

1. **No `tsconfig.json` modifications** — Putting a file in `src/generated/client.ts` requires you to configure path aliases or adjust `include` patterns. Writing to `node_modules/` leverages Node's built-in module resolution. It Just Works™.
2. **No Git contamination** — `node_modules/` is universally `.gitignore`d. The generated client is ephemeral — it's rebuilt on `npx @konto-ledger/cli generate` and should never be committed.
3. **Established precedent** — Prisma Client uses the exact same pattern (`node_modules/.prisma/client/`). 

### Monorepo Support (`--output`)

If you are using a complex Turborepo or PNPM workspace where `node_modules` is hoisted to the root directory, the default output path may cause resolution errors. 

You can override the output directory using the `--output` flag:

```bash
npx @konto-ledger/cli generate --output ./src/konto-client
```

This will emit the same `index.js`, `index.d.ts`, and `package.json` into your local `src/konto-client` folder, allowing you to explicitly declare it as a local workspace dependency in your app's `package.json`:

```json
"dependencies": {
  ".konto": "file:./src/konto-client"
}
```

---

## Workflow Summary

```
Developer writes konto.config.ts (with Zod)
         │
         ▼
   npx @konto-ledger/cli generate
         │
         ├──▶  Writes proxy package to node_modules/.konto/
         ├──▶  index.d.ts infers Zod types via relative import
         └──▶  index.js binds runtime Zod .parse() & DB Singleton
                  │
                  ▼
   import { transfer } from '.konto'
         │
         ▼
   Full autocomplete. Compile-time safety. Runtime validation. No manual DB argument.
```
