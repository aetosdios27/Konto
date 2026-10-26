# @konto-ledger/types

## 0.2.0

### Minor Changes

- d00be24: Fix snapshot accounting by caching posted entries only at a locked BIGINT sequence
  cutoff. Use sequence cutoffs for every balance calculation and the snapshot daemon.
  Export transferInTx, commitHoldInTx, and rollbackHoldInTx for atomic ledger and
  application-event writes, and execute staged intents without nested transactions.

  Reject UPDATE, DELETE, and TRUNCATE on journals and entries at the database level,
  and enforce deferred zero-sum checks on deletion. Apply CLI migrations 0008 and
  0009 before deploying the updated core; old derived snapshots are discarded while
  posted entries remain intact.

  Use flat parameterized journal queries across adapters, bind Drizzle arrays and
  dates safely, and require a Neon WebSocket Pool for interactive transactions.
  Supabase remains unsupported. Add real PostgreSQL adapter integration tests and
  concurrent property tests for balance and snapshot invariants.
