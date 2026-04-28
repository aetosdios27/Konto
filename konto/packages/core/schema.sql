-- 1. Accounts (immutable nodes)
CREATE TABLE IF NOT EXISTS konto_accounts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  currency    TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Journals (atomic event wrapper)
CREATE TABLE IF NOT EXISTS konto_journals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES konto_accounts(id) ON DELETE RESTRICT,
  description       TEXT,
  metadata          JSONB,
  idempotency_key   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_journals_account_idempotency
  ON konto_journals(account_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- 3. Entries (the only source of truth - append-only)
CREATE TABLE IF NOT EXISTS konto_entries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id  UUID NOT NULL REFERENCES konto_journals(id) ON DELETE RESTRICT,
  account_id  UUID NOT NULL REFERENCES konto_accounts(id) ON DELETE RESTRICT,
  amount      BIGINT NOT NULL CHECK (amount != 0),   -- positive=credit, negative=debit
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Zero-sum journal constraint
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

-- Critical indexes for performance
CREATE INDEX IF NOT EXISTS idx_entries_account_created
  ON konto_entries(account_id, created_at);

-- 4. Holds (ephemeral double-phase escrow)
CREATE TABLE IF NOT EXISTS konto_holds (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES konto_accounts(id) ON DELETE RESTRICT,
  recipient_id    UUID NOT NULL REFERENCES konto_accounts(id) ON DELETE RESTRICT,
  amount          BIGINT NOT NULL CHECK (amount > 0),
  idempotency_key TEXT,
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMMITTED', 'ROLLED_BACK')),
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, idempotency_key)
);

-- Optimize hold querying for the balance calculation invariant
CREATE INDEX IF NOT EXISTS idx_holds_account ON konto_holds(account_id);
CREATE INDEX IF NOT EXISTS idx_holds_active
  ON konto_holds(account_id, expires_at)
  WHERE status = 'PENDING';

-- 5. Derivation Checkpoints (Performance scaling)
CREATE TABLE IF NOT EXISTS konto_balance_snapshots (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES konto_accounts(id) ON DELETE RESTRICT,
  balance      BIGINT NOT NULL,
  snapshot_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_balance_snapshots_account ON konto_balance_snapshots(account_id, snapshot_at DESC);

-- Stored procedure for secure snapshots
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
