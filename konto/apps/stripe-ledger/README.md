# @konto/stripe-ledger

A standalone Fastify sidecar service that listens to Stripe webhooks, cryptographically verifies their signatures, and translates Stripe financial events into mathematically correct double-entry journal entries using `@konto/core`.

Every monetary value flows through as `BigInt`. Every webhook is signature-verified before processing. Every journal entry is idempotent by design. No UUIDs are hardcoded anywhere — account IDs are resolved dynamically from the database on every startup.

---

## Architecture

```
Stripe ──webhook──▶ POST /webhooks/stripe
                         │
                    ┌─────▼──────┐
                    │  Verify    │  stripe.webhooks.constructEvent()
                    │  Signature │  raw Buffer + Stripe-Signature header
                    └─────┬──────┘
                          │ 400 if invalid
                    ┌─────▼──────┐
                    │ Translator │  event.type dispatch
                    └─────┬──────┘
                          │
               ┌──────────▼──────────┐
               │ recordBalanceTxn()  │  Fetch BalanceTransaction from Stripe
               │                    │  Build three-leg journal entry
               │                    │  transfer() with idempotencyKey = evt_...
               └──────────┬─────────┘
                          │
                    ┌─────▼──────┐
                    │ @konto/core│  Atomic, zero-sum, double-entry insert
                    │ transfer() │  into PostgreSQL
                    └────────────┘
```

---

## Ledger Accounts

Three accounts are bootstrapped idempotently on every server startup:

| Account Name                | Currency | Role |
|-----------------------------|----------|------|
| `stripe_gross_revenue`      | USD      | Credits the full charge amount (before Stripe's cut) |
| `stripe_fees`               | USD      | Debits the Stripe processing fee |
| `stripe_available_balance`  | USD      | Debits the net amount available for payout |

Account IDs are never hardcoded. The bootstrap creates them if they don't exist (catching Postgres `23505` unique constraint violations for idempotency) and resolves their UUIDs into a module-level singleton that the rest of the codebase imports.

---

## The Three-Leg Journal Entry

When a `charge.succeeded` or `payment_intent.succeeded` event arrives, the translator fetches the Stripe `BalanceTransaction` to get the exact fee breakdown, then creates a single atomic journal entry with three legs:

```
┌─────────────────────────┬─────────┬───────────────────────────────┐
│ Account                 │ Amount  │ Direction                     │
├─────────────────────────┼─────────┼───────────────────────────────┤
│ stripe_gross_revenue    │ +amount │ Credit (revenue recognized)   │
│ stripe_fees             │ -fee    │ Debit  (platform cost)        │
│ stripe_available_balance│ -net    │ Debit  (funds available)      │
└─────────────────────────┴─────────┴───────────────────────────────┘
```

**Zero-sum proof:** Stripe guarantees `amount = fee + net` on every `BalanceTransaction`. Therefore `amount - fee - net = 0`, satisfying Konto's `assertValidEntries()` check. This is a simplified P&L model — a full balance sheet would include a receivables account.

---

## Supported Stripe Events

| Event Type                   | Handler                          | Description |
|------------------------------|----------------------------------|-------------|
| `charge.succeeded`           | `handleChargeSucceeded()`        | Direct charge flow. Extracts `balance_transaction` from the Charge object. |
| `payment_intent.succeeded`   | `handlePaymentIntentSucceeded()` | Modern Payment Intents flow. Retrieves the `latest_charge`, then extracts its `balance_transaction`. |
| Any other event              | Logged and ignored               | Returns 200 without throwing — the webhook endpoint never 500s on unrecognized events. |

Both handlers converge on the same `recordBalanceTransaction()` function, which ensures identical three-leg journal structure regardless of the originating event type.

---

## Idempotency

Every `transfer()` call uses the Stripe event ID (`evt_...`) as its `idempotencyKey`. Konto checks this key inside the transaction before inserting:

```sql
SELECT id FROM konto_journals
WHERE account_id = $1 AND idempotency_key = $2
LIMIT 1
```

If a match exists, Konto throws `KontoDuplicateTransactionError` and the transaction is rolled back. This makes Stripe's automatic webhook retries structurally impossible to double-process — no external state tracking, no Redis, no deduplication table. The ledger itself is the deduplication layer.

---

## Webhook Security

Every incoming webhook payload is verified using `stripe.webhooks.constructEvent()` with:
- The **raw request body** as a `Buffer` (not parsed JSON — parsing and re-serializing would break the HMAC)
- The `Stripe-Signature` header
- The `STRIPE_WEBHOOK_SECRET` from environment config

Fastify's default JSON content-type parser is overridden with a custom parser that stores the raw body as a Buffer:

```ts
fastify.addContentTypeParser(
  "application/json",
  { parseAs: "buffer" },
  (_req, body, done) => done(null, body)
);
```

If verification fails for any reason (invalid signature, expired timestamp, malformed payload), the endpoint returns `400` immediately. No unverified payload is ever processed.

---

## BigInt Serialization

Konto uses `BigInt` exclusively for all monetary values. Fastify's default `JSON.stringify` throws `TypeError: Do not know how to serialize a BigInt` when encountering one.

A custom reply serializer is configured on the Fastify instance **before any routes are registered**:

```ts
fastify.setReplySerializer((payload) =>
  JSON.stringify(payload, (_, v) =>
    typeof v === "bigint" ? v.toString() : v
  )
);
```

This ensures all BigInt values in API responses are serialized as strings (e.g., `"15000"` instead of `15000n`).

---

## API Endpoints

### `POST /webhooks/stripe`

Stripe webhook receiver. Verifies the signature, dispatches to the translator, and returns:
- `200 { received: true }` on success
- `400 { error: "..." }` on verification failure
- `500 { error: "..." }` on translation failure

### `GET /api/balance`

Returns the current balance of the `stripe_available_balance` account.

**Response:**
```json
{
  "accountId": "uuid",
  "currency": "USD",
  "available": "15000",
  "held": "0",
  "total": "15000"
}
```

All monetary fields are BigInt values serialized as strings. `available` and `total` reflect the net liquid balance computed by `getBalance()` (snapshot + entries - holds). `held` is always `"0"` because this sidecar does not use Konto's hold system.

### `GET /api/journals`

Returns recent journal entries touching the `stripe_available_balance` account.

**Query parameters:**
- `limit` — Number of journals to return (default: `20`, max: `100`)

**Response:**
```json
{
  "journals": [
    {
      "id": "uuid",
      "description": null,
      "metadata": {},
      "idempotencyKey": "evt_...",
      "createdAt": "2026-04-29T10:00:00.000Z",
      "entries": [
        { "accountId": "uuid", "amount": "10000" },
        { "accountId": "uuid", "amount": "-287" },
        { "accountId": "uuid", "amount": "-9713" }
      ]
    }
  ],
  "nextCursor": "2026-04-29T09:55:00.000Z_uuid"
}
```

`nextCursor` is `null` when there are no more results. It is derived from the last journal's `createdAt` timestamp and `id` when the result set fills the requested limit.

---

## Environment Variables

| Variable                | Required | Default | Description |
|-------------------------|----------|---------|-------------|
| `STRIPE_SECRET_KEY`     | ✓        | —       | Stripe API secret key (`sk_live_...` or `sk_test_...`) |
| `STRIPE_WEBHOOK_SECRET` | ✓        | —       | Webhook endpoint signing secret (`whsec_...`) |
| `DATABASE_URL`          | ✓        | —       | PostgreSQL connection string |
| `PORT`                  | ✗        | `3001`  | Port the server listens on |

All required variables are validated at startup using Zod. If any are missing or invalid, the server exits immediately with a formatted error listing every failing variable:

```
stripe-ledger: missing or invalid environment variables:
  ✗ STRIPE_SECRET_KEY: STRIPE_SECRET_KEY is required
  ✗ DATABASE_URL: DATABASE_URL is required
```

---

## Project Structure

```
apps/stripe-ledger/
├── package.json              # @konto/stripe-ledger manifest
├── tsconfig.json             # Extends root tsconfig (strict: true)
├── README.md                 # This file
└── src/
    ├── server.ts             # Fastify entry: raw body parser, BigInt serializer, startup
    ├── config.ts             # Zod-validated environment config
    ├── db.ts                 # postgres.js connection → KontoQueryExecutor
    ├── bootstrap.ts          # Idempotent ledger account creation + singleton registry
    ├── routes/
    │   ├── webhooks.ts       # POST /webhooks/stripe — signature verification
    │   └── api.ts            # GET /api/balance, GET /api/journals
    └── services/
        └── translator.ts     # Stripe event → Konto journal entry translation
```

---

## Database Connection

The service uses `postgres` (Postgres.js) directly — no adapter wrapper. Postgres.js's tagged-template API natively satisfies the `KontoQueryExecutor` interface that `@konto/core` requires:

| KontoQueryExecutor method | Postgres.js equivalent |
|---------------------------|------------------------|
| `` sql<T[]>`...` ``       | Tagged template query  |
| `sql.begin(cb)`           | Scoped transaction     |
| `sql.json(value)`         | JSON serialization     |
| `sql.unsafe(query)`       | Raw SQL execution      |

This is the correct choice for a long-running Node.js process. The HTTP-based Vercel and Neon adapters are designed for serverless/edge runtimes and would add unnecessary overhead here.

---

## Scripts

```bash
pnpm dev        # Start with tsx watch (hot reload)
pnpm build      # Production build via tsup (ESM)
pnpm start      # Run production build
pnpm typecheck  # tsc --noEmit
```

---

## Invariants

These properties hold at all times and must never be violated:

1. **No hardcoded UUIDs** — Account IDs are resolved from the database at startup
2. **BigInt everywhere** — No `number` type is used for any monetary value
3. **Idempotency via Stripe event ID** — The `idempotencyKey` on every `transfer()` is the `evt_...` ID, never a random value
4. **Zero-sum journals** — Every journal entry sums to exactly `0n` across all legs
5. **Verified-only processing** — No Stripe event is processed without successful `constructEvent()` verification
6. **No modifications outside `apps/stripe-ledger/`** — This package does not touch `@konto/core`, `@konto/adapters`, `@konto/types`, or any other workspace package
