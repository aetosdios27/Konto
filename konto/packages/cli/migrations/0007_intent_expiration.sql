-- 0007_intent_expiration.sql
--
-- Adds expires_at TTL to konto_staged_intents, mirroring the existing
-- konto_holds.expires_at pattern. Prevents stale PENDING intents from
-- accumulating as financial state debt.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'konto_staged_intents' AND column_name = 'expires_at'
  ) THEN
    ALTER TABLE konto_staged_intents ADD COLUMN expires_at TIMESTAMPTZ;
  END IF;
END $$;
