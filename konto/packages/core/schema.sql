-- 1. Accounts (immutable nodes)
CREATE TABLE IF NOT EXISTS konto_accounts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  account_type TEXT NOT NULL DEFAULT 'ASSET' CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
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
  entry_sequence BIGINT NOT NULL UNIQUE,
  journal_id  UUID NOT NULL REFERENCES konto_journals(id) ON DELETE RESTRICT,
  account_id  UUID NOT NULL REFERENCES konto_accounts(id) ON DELETE RESTRICT,
  amount      BIGINT NOT NULL CHECK (amount != 0),   -- positive=credit, negative=debit
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE SEQUENCE konto_entry_sequence AS BIGINT;
ALTER SEQUENCE konto_entry_sequence OWNED BY konto_entries.entry_sequence;

CREATE OR REPLACE FUNCTION assign_entry_sequence_fn() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM public.konto_accounts WHERE id = NEW.account_id FOR UPDATE;
  NEW.entry_sequence := nextval('public.konto_entry_sequence');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

CREATE TRIGGER assign_entry_sequence
  BEFORE INSERT ON konto_entries
  FOR EACH ROW EXECUTE FUNCTION assign_entry_sequence_fn();

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
CREATE INDEX IF NOT EXISTS idx_entries_account_sequence
  ON konto_entries(account_id, entry_sequence);

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
  entry_sequence BIGINT NOT NULL CHECK (entry_sequence >= 0),
  snapshot_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_balance_snapshots_account ON konto_balance_snapshots(account_id, entry_sequence DESC);

-- Stored procedure for secure snapshots
CREATE OR REPLACE FUNCTION take_snapshot(p_account_id UUID) RETURNS UUID AS $$
DECLARE
  v_balance BIGINT;
  v_entry_sequence BIGINT;
  v_snapshot_id UUID;
BEGIN
  PERFORM 1 FROM konto_accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Konto: account not found: %', p_account_id;
  END IF;

  SELECT COALESCE(SUM(amount), 0), COALESCE(MAX(entry_sequence), 0)
    INTO v_balance, v_entry_sequence
    FROM konto_entries WHERE account_id = p_account_id;

  INSERT INTO konto_balance_snapshots (account_id, balance, entry_sequence)
    VALUES (p_account_id, v_balance, v_entry_sequence)
    RETURNING id INTO v_snapshot_id;
  RETURN v_snapshot_id;
END;
$$ LANGUAGE plpgsql;

-- 6. Staged Intents (Agent Authorization Profile)
CREATE TABLE IF NOT EXISTS konto_staged_intents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_type     TEXT NOT NULL CHECK (intent_type IN ('TRANSFER', 'COMMIT_HOLD', 'ROLLBACK_HOLD')),
  idempotency_key TEXT UNIQUE,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'EXECUTED', 'REJECTED', 'EXPIRED')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  executed_at     TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_staged_intents_status
  ON konto_staged_intents (status) WHERE status = 'PENDING';
