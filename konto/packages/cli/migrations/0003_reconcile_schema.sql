-- 0003_reconcile_schema.sql
--
-- Reconciliation migration: brings databases provisioned with the original
-- 0001_initial_state.sql up to parity with the canonical schema.sql.
--
-- Every statement is idempotent — safe to run on databases that already
-- have the correct schema (no-op) or on databases with the old schema.

-- ============================================================================
-- 1. konto_journals: add account_id column if missing
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'konto_journals' AND column_name = 'account_id'
  ) THEN
    ALTER TABLE konto_journals
      ADD COLUMN account_id UUID REFERENCES konto_accounts(id) ON DELETE RESTRICT;

    -- Backfill orphaned journals from their first entry's account_id.
    -- If no journals exist (most likely — the old schema never worked with
    -- the current code), this is a no-op.
    UPDATE konto_journals j
    SET account_id = (
      SELECT e.account_id FROM konto_entries e
      WHERE e.journal_id = j.id
      ORDER BY e.created_at ASC
      LIMIT 1
    )
    WHERE j.account_id IS NULL;

    -- Now enforce NOT NULL. If any journal still has NULL account_id
    -- (no entries to backfill from), this will fail — intentionally.
    -- Such orphaned journals require manual intervention.
    ALTER TABLE konto_journals ALTER COLUMN account_id SET NOT NULL;
  END IF;
END $$;

-- ============================================================================
-- 2. konto_holds: add status column if missing
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'konto_holds' AND column_name = 'status'
  ) THEN
    -- DEFAULT 'PENDING' backfills all existing rows correctly — any hold
    -- in the old schema without a status column is implicitly pending.
    ALTER TABLE konto_holds
      ADD COLUMN status TEXT NOT NULL DEFAULT 'PENDING'
      CHECK (status IN ('PENDING', 'COMMITTED', 'ROLLED_BACK'));
  END IF;
END $$;

-- ============================================================================
-- 3. Idempotency key scoping: konto_journals
--    Replace global UNIQUE(idempotency_key) with UNIQUE(account_id, idempotency_key)
-- ============================================================================
DO $$
DECLARE
  old_constraint TEXT;
BEGIN
  -- Find any single-column unique constraint on idempotency_key alone
  SELECT c.conname INTO old_constraint
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  WHERE t.relname = 'konto_journals'
    AND c.contype = 'u'
    AND array_length(c.conkey, 1) = 1
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = t.oid
        AND a.attnum = c.conkey[1]
        AND a.attname = 'idempotency_key'
    );

  IF old_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE konto_journals DROP CONSTRAINT %I', old_constraint);
  END IF;

  -- Add scoped composite unique if not already present
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = 'konto_journals'
      AND c.contype = 'u'
      AND array_length(c.conkey, 1) = 2
  ) THEN
    ALTER TABLE konto_journals ADD UNIQUE (account_id, idempotency_key);
  END IF;
END $$;

-- ============================================================================
-- 4. Idempotency key scoping: konto_holds
--    Replace global UNIQUE(idempotency_key) with UNIQUE(account_id, idempotency_key)
-- ============================================================================
DO $$
DECLARE
  old_constraint TEXT;
BEGIN
  SELECT c.conname INTO old_constraint
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  WHERE t.relname = 'konto_holds'
    AND c.contype = 'u'
    AND array_length(c.conkey, 1) = 1
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = t.oid
        AND a.attnum = c.conkey[1]
        AND a.attname = 'idempotency_key'
    );

  IF old_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE konto_holds DROP CONSTRAINT %I', old_constraint);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = 'konto_holds'
      AND c.contype = 'u'
      AND array_length(c.conkey, 1) = 2
  ) THEN
    ALTER TABLE konto_holds ADD UNIQUE (account_id, idempotency_key);
  END IF;
END $$;

-- ============================================================================
-- 5. Fix ON DELETE CASCADE → ON DELETE RESTRICT on entries→journals FK
-- ============================================================================
DO $$
DECLARE
  fk_name TEXT;
BEGIN
  -- Find CASCADE FK from konto_entries.journal_id → konto_journals.id
  SELECT c.conname INTO fk_name
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  JOIN pg_class ref ON c.confrelid = ref.oid
  WHERE t.relname = 'konto_entries'
    AND ref.relname = 'konto_journals'
    AND c.contype = 'f'
    AND c.confdeltype = 'c';  -- 'c' = CASCADE

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE konto_entries DROP CONSTRAINT %I', fk_name);
    ALTER TABLE konto_entries
      ADD CONSTRAINT konto_entries_journal_id_fkey
      FOREIGN KEY (journal_id) REFERENCES konto_journals(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- ============================================================================
-- 6. Zero-sum deferred constraint trigger
--    CREATE OR REPLACE is idempotent for the function.
--    DROP TRIGGER IF EXISTS + CREATE handles the trigger.
-- ============================================================================
CREATE OR REPLACE FUNCTION check_journal_balance_fn() RETURNS trigger AS $$
DECLARE
  journal_sum BIGINT;
BEGIN
  SELECT SUM(amount) INTO journal_sum FROM konto_entries WHERE journal_id = NEW.journal_id;
  IF journal_sum != 0 THEN
    RAISE EXCEPTION 'Konto: Journal % is unbalanced (sum = %)', NEW.journal_id, journal_sum;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS check_journal_balance ON konto_entries;
CREATE CONSTRAINT TRIGGER check_journal_balance
  AFTER INSERT OR UPDATE ON konto_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_journal_balance_fn();

-- ============================================================================
-- 7. Partial index for scoped idempotency lookups
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_journals_account_idempotency
  ON konto_journals(account_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ============================================================================
-- 8. take_snapshot() stored procedure
-- ============================================================================
CREATE OR REPLACE FUNCTION take_snapshot(p_account_id UUID) RETURNS UUID AS $$
DECLARE
  v_balance BIGINT;
  v_snapshot_id UUID;
BEGIN
  SELECT
    COALESCE(s.balance, 0) + COALESCE(e.entry_sum, 0) - COALESCE(h.hold_sum, 0) INTO v_balance
  FROM konto_accounts a
  LEFT JOIN LATERAL (
    SELECT balance, snapshot_at FROM konto_balance_snapshots WHERE account_id = a.id ORDER BY snapshot_at DESC LIMIT 1
  ) s ON true
  LEFT JOIN LATERAL (
    SELECT SUM(amount) as entry_sum FROM konto_entries WHERE account_id = a.id AND (s.snapshot_at IS NULL OR created_at > s.snapshot_at)
  ) e ON true
  LEFT JOIN LATERAL (
    SELECT SUM(amount) as hold_sum FROM konto_holds WHERE account_id = a.id AND status = 'PENDING' AND (expires_at IS NULL OR NOW() <= expires_at)
  ) h ON true
  WHERE a.id = p_account_id;

  INSERT INTO konto_balance_snapshots (account_id, balance) VALUES (p_account_id, v_balance) RETURNING id INTO v_snapshot_id;
  RETURN v_snapshot_id;
END;
$$ LANGUAGE plpgsql;
