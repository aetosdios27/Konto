-- 0004_account_name_unique.sql
--
-- Adds a UNIQUE constraint on konto_accounts.name.
--
-- Without this, createAccount() silently creates duplicate accounts
-- with the same name, and any idempotent bootstrap logic (like
-- stripe-ledger's) that relies on catching Postgres 23505 errors
-- will never fire.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = 'konto_accounts'
      AND c.contype = 'u'
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = t.oid
          AND a.attnum = ANY(c.conkey)
          AND a.attname = 'name'
      )
  ) THEN
    ALTER TABLE konto_accounts ADD CONSTRAINT konto_accounts_name_unique UNIQUE (name);
  END IF;
END $$;
