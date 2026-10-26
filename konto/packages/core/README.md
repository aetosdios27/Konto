# @konto-ledger/core

Strictly-typed double-entry ledger primitives for PostgreSQL. 

This is the core engine for Konto, providing mathematically correct, zero-sum financial mutations. It handles row-level locking, balance derivation, and staged intent execution natively in the database.

## Installation

```bash
npm install @konto-ledger/core
```

## Quick Start

You typically do not use `@konto-ledger/core` by itself. It is designed to be used alongside the generated `.konto` client and a database adapter.

For the full documentation, architecture details, and setup guide, please visit the main repository:

**[GitHub: aetosdios27/Konto](https://github.com/aetosdios27/Konto)**

## Caller-owned transactions

Use `transferInTx`, `commitHoldInTx`, or `rollbackHoldInTx` on an existing
transaction handle to commit a ledger mutation and an application event together.
These functions never open a transaction or savepoint. The caller must commit or
roll back the transaction, and must let errors abort it. Deferred zero-sum checks
run when that outer transaction commits. Use the default PostgreSQL `READ COMMITTED`
isolation level. Stronger isolation levels are outside this concurrency contract.

```ts
import { transferInTx } from "@konto-ledger/core";

await sql.begin(async (tx) => {
  const { journalId } = await transferInTx(tx, {
    accountId: senderId,
    entries: [
      { accountId: senderId, amount: -100n },
      { accountId: recipientId, amount: 100n },
    ],
  });
  await tx`INSERT INTO app_events (journal_id) VALUES (${journalId})`;
});
```

The existing `transfer`, `commitHold`, and `rollbackHold` functions continue to
own their transactions. Apply CLI migrations through `0009` before using the
sequence-based balance queries in this version. Snapshots cache posted entries;
active holds are deducted only when calculating the available balance.

The database rejects `UPDATE`, `DELETE`, and `TRUNCATE` on journals and entries,
including statements run by the table owner. Corrections require compensating
entries in a new journal. Application roles should have only the required grants;
the insert trigger assigns sequences while holding the account lock using its
owner's privileges. As with all PostgreSQL triggers, a database administrator or
table owner with DDL access can disable or remove these protections. Restrict DDL
access to the migration role and use a separate application role in production.
