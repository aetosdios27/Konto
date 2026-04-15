# Client Generation

This document explains how Konto's TypeScript SDK generator works — from the developer-facing configuration file to the internal engineering trick that makes `import { transfer } from '.konto'` resolve globally without any `tsconfig.json` modifications.

---

## The Problem

Most ledger libraries accept metadata as `Record<string, any>` or `unknown`. This means a transfer call looks like this:

```typescript
await transfer(sql, {
  entries: [...],
  metadata: {
    invoce_id: "INV-001",  // ← typo. "invoce" instead of "invoice". No error.
    // forgot order_ref entirely. No error.
  },
});
```

This compiles. This deploys. And three months later, an accounting reconciliation fails because 12,000 transfers are missing their `order_ref` field, and 400 have a misspelled `invoce_id` that no downstream system can parse.

The root cause: **the type system had no opinion about what metadata should contain.**

---

## The Solution: `konto.config.ts`

Konto solves this by letting you define your metadata schema once, then generating a typed client that enforces it at compile time.

### The `defineLedger` API

Create a `konto.config.ts` in your project root:

```typescript
import { defineLedger } from "@konto/cli";

export default defineLedger({
  transfer: {
    invoice_id: "string",
    order_ref: "string",
    notes: "string?",
    tax_class: "enum:['GST', 'VAT', 'EXEMPT']",
  },
  hold: {
    reason: "string",
  },
  account: {
    status: "enum:['ACTIVE', 'FROZEN', 'CLOSED']",
  },
});
```

### Supported Type Syntax

| Syntax | Generated TypeScript | Description |
| --- | --- | --- |
| `"string"` | `invoice_id: string;` | Required string field |
| `"number"` | `amount_override: number;` | Required number field |
| `"boolean"` | `is_refund: boolean;` | Required boolean field |
| `"string?"` | `notes?: string;` | Optional string field |
| `"number?"` | `priority?: number;` | Optional number field |
| `"enum:['A', 'B']"` | `tax_class: "A" \| "B";` | Required union/enum field |

**The optionality trap (`?`)**: In real-world ledgers, not every field is required. A transfer might always need an `invoice_id`, but `notes` is contextual. The `?` suffix on any type string generates an optional TypeScript property (`notes?: string`), making the distinction between "must have" and "nice to have" explicit and compiler-enforced.

### Schema Sections

| Key | Applies To | Description |
| --- | --- | --- |
| `transfer` | `transfer()` metadata | Fields required/expected on every transfer operation |
| `hold` | `hold()` metadata | Fields required/expected when creating escrow holds |
| `journal` | `commitHold()` metadata | Fields attached to journals created during hold settlement |
| `account` | Account metadata | Typed metadata for account-level properties |

---

## The `.konto` Proxy (Under the Hood)

When you run `npx @konto/cli generate`, the generator doesn't output a file to your `src/` directory. It writes directly to `node_modules/.konto/`. This is the same pattern used by Prisma Client.

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

#### `index.d.ts`

The type declaration file. This is where the magic happens. It contains:

1. **Custom interfaces** generated from your config:

```typescript
export interface TransferMetadata {
  invoice_id: string;
  order_ref: string;
  notes?: string;
  tax_class: "GST" | "VAT" | "EXEMPT";
}
```

2. **Payload overrides** that replace the generic `metadata` field:

```typescript
export type CustomTransferPayload = Omit<TransferPayload, "metadata"> & {
  metadata?: TransferMetadata;
};
```

3. **Function declarations** with the strict payload types:

```typescript
export declare function transfer(
  sql: ReturnType<typeof postgres>,
  payload: CustomTransferPayload,
): ReturnType<typeof coreTransfer>;
```

The developer now gets full autocomplete on `metadata.invoice_id`, compile-time errors on `metadata.invoce_id`, and type errors if they forget `order_ref`.

#### `index.js`

The runtime proxy. Each function simply delegates to the real `@konto/core` method:

```javascript
import { transfer as coreTransfer } from "@konto/core";

export async function transfer(sql, payload) {
  return coreTransfer(sql, payload);
}
```

There is zero runtime overhead. The `.konto` layer is purely a type-narrowing proxy. At runtime, it's a direct pass-through to the core engine.

### Why `node_modules/` Instead of `src/`?

Three reasons:

1. **No `tsconfig.json` modifications** — Putting a file in `src/generated/client.ts` would require the user to configure path aliases or adjust their `include` patterns. Writing to `node_modules/` leverages Node's built-in module resolution. It Just Works™.

2. **No Git contamination** — `node_modules/` is universally `.gitignore`d. The generated client is ephemeral — it's rebuilt on `npx @konto/cli generate` and should never be committed. This matches the mental model of "generated code belongs in build artifacts, not source."

3. **Established precedent** — Prisma Client uses the exact same pattern (`node_modules/.prisma/client/`). Developers already expect this behavior from code generators in the Node.js ecosystem.

---

## The Config Loading Mechanism

The generator uses [`jiti`](https://github.com/unjs/jiti) to load `konto.config.ts` at runtime. `jiti` is a lightweight TypeScript/ESM loader that can `import()` a `.ts` file without requiring a build step or `ts-node`.

```typescript
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const configModule = await jiti.import(configPath, { default: true });
const schema = configModule.default || configModule;
```

This means the user's config file is a real TypeScript module. They get full IDE support (autocomplete on `defineLedger`, type checking on the schema values) while writing it, and the CLI can load it at runtime without compiling the entire project.

---

## Workflow Summary

```
Developer writes konto.config.ts
         │
         ▼
   npx @konto/cli generate
         │
         ├──▶  jiti loads the .ts config at runtime
         ├──▶  Parser converts string schemas to TS types
         ├──▶  Generator emits index.d.ts + index.js + package.json
         └──▶  Output: node_modules/.konto/
                  │
                  ▼
   import { transfer } from '.konto'
         │
         ▼
   Full autocomplete. Compile-time safety. Zero runtime cost.
```
