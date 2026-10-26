CREATE OR REPLACE FUNCTION check_journal_balance_fn() RETURNS trigger AS $$
DECLARE
  journal_sum NUMERIC;
  affected_journals UUID[];
  affected_journal UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    affected_journals := ARRAY[NEW.journal_id];
  ELSIF TG_OP = 'DELETE' THEN
    affected_journals := ARRAY[OLD.journal_id];
  ELSE
    affected_journals := ARRAY[OLD.journal_id, NEW.journal_id];
  END IF;

  FOREACH affected_journal IN ARRAY affected_journals LOOP
    SELECT COALESCE(SUM(amount), 0) INTO journal_sum
      FROM konto_entries WHERE journal_id = affected_journal;
    IF journal_sum <> 0 THEN
      RAISE EXCEPTION 'Konto: Journal % is unbalanced (sum = %)', affected_journal, journal_sum;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS check_journal_balance ON konto_entries;
CREATE CONSTRAINT TRIGGER check_journal_balance
  AFTER INSERT OR UPDATE OR DELETE ON konto_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_journal_balance_fn();

CREATE OR REPLACE FUNCTION reject_ledger_mutation_fn() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Konto: % is append-only; % is forbidden', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_entries_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON konto_entries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_mutation_fn();

CREATE TRIGGER enforce_journals_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON konto_journals
  FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_mutation_fn();
