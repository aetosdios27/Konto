---
"@konto-ledger/cli": minor
"@konto-ledger/adapters": minor
"@konto-ledger/core": patch
---

### S++ Tier CLI Overhaul
- **Interactive Init**: Rebuilt `init` command using `@clack/prompts` wizard for seamless ORM integration.
- **Migration Concurrency**: The `migrate` engine now supports `-- konto:no-transaction` for zero-downtime `CONCURRENTLY` indexes.
- **Bulk Escrow Queue**: Rebuilt the `approve` command with an interactive multiselect UI for bulk queue approvals.
- **Monorepo Output**: Added `--output` flag to `generate` for custom AST output paths.

### Prisma & Drizzle Adapters
- Shipped `@konto-ledger/adapters/prisma` and `@konto-ledger/adapters/drizzle` sidecar wrappers for frictionless ORM integration.
