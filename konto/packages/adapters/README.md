# @konto-ledger/adapters

Provider-specific PostgreSQL adapters for the Konto ledger engine.

This package provides inversion-of-control wrappers for popular serverless database providers, ensuring that Konto's highly contested ledger math executes safely and efficiently across different connection pool models.

## Installation

```bash
npm install @konto-ledger/adapters
```

## Supported Providers

- **Prisma ORM** (`@prisma/client`) - *Sidecar Mode*
- **Drizzle ORM** (`drizzle-orm`) - *Sidecar Mode*
- **Vercel Postgres** (`@vercel/postgres`)
- **Neon Serverless** (`@neondatabase/serverless`)
- **Supabase** (In development)

## Usage Example (Prisma Sidecar)

Use Konto securely alongside your existing Prisma ORM app without breaking your connection pooling:

```typescript
import { createPrismaAdapter } from '@konto-ledger/adapters/prisma';
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
export const db = createPrismaAdapter(prisma);
```

For the full documentation and setup guide, please visit the main repository:

**[GitHub: aetosdios27/Konto](https://github.com/aetosdios27/Konto)**

## PostgreSQL integration tests

`pnpm --filter @konto-ledger/adapters test --run` generates a test-only Prisma
client and tests Prisma with its pg driver, Drizzle with pg and postgres.js, Neon,
and Vercel against PostgreSQL 16. The serverless drivers use a local WebSocket TCP
relay to the same database, so these tests exercise real PostgreSQL transactions
without requiring cloud credentials. Supabase remains unsupported and is excluded.
Set `KONTO_TEST_DATABASE_URL` as described in `CONTRIBUTING.md` to reuse an existing
server; every adapter still gets a separate throwaway database.

Neon requires `createNeonAdapter(new Pool({ connectionString }))` from
`@neondatabase/serverless`. The HTTP `neon()` batch client cannot provide the
interactive transactions required for ledger mutations. The caller owns the pool
and must close it when done.
