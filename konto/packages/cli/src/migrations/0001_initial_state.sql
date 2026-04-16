-- 0. PlPgSQL UUIDv7 Function
CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid AS $$
BEGIN
  RETURN (
    lpad(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint), 12, '0') ||
    '7' ||
    substr(md5(random()::text), 1, 3) ||
    '8' ||
    substr(md5(random()::text), 1, 3) ||
    substr(md5(random()::text), 1, 12)
  )::uuid;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- 1. Accounts (immutable nodes)
CREATE TABLE IF NOT EXISTS konto_accounts (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  name        TEXT NOT NULL,
  currency    TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Journals (atomic event wrapper)
CREATE TABLE IF NOT EXISTS konto_journals (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  description       TEXT,
  metadata          JSONB,
  idempotency_key   TEXT UNIQUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Entries (the only source of truth - append-only)
CREATE TABLE IF NOT EXISTS konto_entries (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  journal_id  UUID NOT NULL REFERENCES konto_journals(id) ON DELETE CASCADE,
  account_id  UUID NOT NULL REFERENCES konto_accounts(id) ON DELETE RESTRICT,
  amount      BIGINT NOT NULL CHECK (amount != 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Critical indexes for performance
CREATE INDEX IF NOT EXISTS idx_entries_account_created
  ON konto_entries(account_id, created_at);

CREATE INDEX IF NOT EXISTS idx_journals_idempotency
  ON konto_journals(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Row Level Security (optional but recommended)
ALTER TABLE konto_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE konto_journals ENABLE ROW LEVEL SECURITY;
ALTER TABLE konto_entries ENABLE ROW LEVEL SECURITY;

-- 4. Holds (ephemeral double-phase escrow)
CREATE TABLE IF NOT EXISTS konto_holds (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  account_id      UUID NOT NULL REFERENCES konto_accounts(id) ON DELETE RESTRICT,
  recipient_id    UUID NOT NULL REFERENCES konto_accounts(id) ON DELETE RESTRICT,
  amount          BIGINT NOT NULL CHECK (amount > 0),
  idempotency_key TEXT UNIQUE,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Optimize hold querying for the balance calculation invariant
CREATE INDEX IF NOT EXISTS idx_holds_account ON konto_holds(account_id);
ALTER TABLE konto_holds ENABLE ROW LEVEL SECURITY;

-- 5. Derivation Checkpoints (Performance scaling)
CREATE TABLE IF NOT EXISTS konto_balance_snapshots (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  account_id   UUID NOT NULL REFERENCES konto_accounts(id) ON DELETE RESTRICT,
  balance      BIGINT NOT NULL,
  snapshot_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_balance_snapshots_account ON konto_balance_snapshots(account_id, snapshot_at DESC);
ALTER TABLE konto_balance_snapshots ENABLE ROW LEVEL SECURITY;
