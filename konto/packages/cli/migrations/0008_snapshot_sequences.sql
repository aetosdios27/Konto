LOCK TABLE konto_accounts, konto_entries, konto_balance_snapshots IN ACCESS EXCLUSIVE MODE;

CREATE SEQUENCE konto_entry_sequence AS BIGINT;
ALTER TABLE konto_entries ADD COLUMN entry_sequence BIGINT;
UPDATE konto_entries SET entry_sequence = nextval('konto_entry_sequence');
ALTER TABLE konto_entries ALTER COLUMN entry_sequence SET NOT NULL;
ALTER TABLE konto_entries ADD UNIQUE (entry_sequence);
ALTER SEQUENCE konto_entry_sequence OWNED BY konto_entries.entry_sequence;

-- Old snapshots include reservations and timestamp gaps, so rebuild this derived cache.
DELETE FROM konto_balance_snapshots;
ALTER TABLE konto_balance_snapshots
  ADD COLUMN entry_sequence BIGINT NOT NULL CHECK (entry_sequence >= 0);

DROP INDEX IF EXISTS idx_entries_account_created;
CREATE INDEX idx_entries_account_sequence ON konto_entries(account_id, entry_sequence);
DROP INDEX IF EXISTS idx_balance_snapshots_account;
CREATE INDEX idx_balance_snapshots_account ON konto_balance_snapshots(account_id, entry_sequence DESC);

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
