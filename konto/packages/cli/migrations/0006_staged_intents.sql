-- 0006_staged_intents.sql
--
-- Adds the konto_staged_intents table for the Agent Authorization Profile.
-- MCP mutation tools stage intents here; human operators approve and execute them
-- via `npx @konto/cli approve <intent_id>`.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'konto_staged_intents'
  ) THEN
    CREATE TABLE konto_staged_intents (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      intent_type     TEXT NOT NULL CHECK (intent_type IN ('TRANSFER', 'COMMIT_HOLD', 'ROLLBACK_HOLD')),
      idempotency_key TEXT UNIQUE,
      payload         JSONB NOT NULL,
      status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'EXECUTED', 'REJECTED', 'EXPIRED')),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      executed_at     TIMESTAMPTZ
    );

    CREATE INDEX idx_staged_intents_status ON konto_staged_intents (status) WHERE status = 'PENDING';
  END IF;
END $$;
