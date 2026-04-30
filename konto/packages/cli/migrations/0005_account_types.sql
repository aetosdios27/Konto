-- 0005_account_types.sql
--
-- Adds standard double-entry account types to the ledger.
-- ASSET and EXPENSE have debit normal balances (balance >= 0 constraint).
-- LIABILITY, EQUITY, and REVENUE have credit normal balances (can be negative).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'konto_accounts' AND column_name = 'account_type'
  ) THEN
    -- Add the column with a default for backwards compatibility
    ALTER TABLE konto_accounts
      ADD COLUMN account_type TEXT NOT NULL DEFAULT 'ASSET'
      CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'));
  END IF;
END $$;
