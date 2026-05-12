# @konto-ledger/cli

The command-line interface and typed client generator for Konto ledgers.

This CLI tool provisions your PostgreSQL database with the necessary schema and dynamically generates a strictly-typed `.konto` client based on your `konto.config.ts` business rules.

## Installation

```bash
npm install @konto-ledger/cli
```

## Usage

Initialize a new ledger configuration via interactive wizard:
```bash
npx @konto-ledger/cli init
```
*Supports automatic adapter scaffolding for Prisma, Drizzle, Vercel, Neon, and Supabase.*

Apply migrations to your database:
```bash
npx @konto-ledger/cli migrate
```
*Supports zero-downtime indexing: Use `-- konto:no-transaction` in your `.sql` files to run `CONCURRENTLY` operations.*

Generate the strongly-typed client:
```bash
npx @konto-ledger/cli generate [--output ./src/konto-client]
```
*Defaults to `node_modules/.konto` but can be overridden for monorepo support.*

Approve staged financial intents (interactive bulk queue):
```bash
npx @konto-ledger/cli approve
```
*Pass an ID (`approve <id>`) to execute a single intent, or omit it to launch the interactive queue.*

For the full documentation and setup guide, please visit the main repository:

**[GitHub: aetosdios27/Konto](https://github.com/aetosdios27/Konto)**
