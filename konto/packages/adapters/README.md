# @konto-ledger/adapters

Provider-specific PostgreSQL adapters for the Konto ledger engine.

This package provides inversion-of-control wrappers for popular serverless database providers, ensuring that Konto's highly contested ledger math executes safely and efficiently across different connection pool models.

## Installation

```bash
npm install @konto-ledger/adapters
```

## Supported Providers

- **Vercel Postgres** (`@vercel/postgres`)
- **Neon Serverless** (`@neondatabase/serverless`)
- **Supabase** (In development)

## Usage Example (Vercel)

```typescript
import { createVercelAdapter } from '@konto-ledger/adapters/vercel';
import { sql } from '@vercel/postgres';

export const db = createVercelAdapter(sql);
```

For the full documentation and setup guide, please visit the main repository:

**[GitHub: aetosdios27/Konto](https://github.com/aetosdios27/Konto)**
