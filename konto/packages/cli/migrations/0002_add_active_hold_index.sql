CREATE INDEX IF NOT EXISTS idx_holds_active
  ON konto_holds(account_id, expires_at)
  WHERE status = 'PENDING';
