import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase } from "./database";
import { migrate } from "../../cli/src/commands/migrate";

describe.each(["schema", "migrations"])("database immutability (%s)", (source) => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let ownerSql: ReturnType<typeof postgres>;
  let appSql: ReturnType<typeof postgres>;
  const owner = `konto_owner_${randomUUID().replaceAll("-", "")}`;
  const app = `konto_app_${randomUUID().replaceAll("-", "")}`;

  beforeAll(async () => {
    database = await createTestDatabase();
    const sql = database.sql;
    await sql`CREATE ROLE ${sql(owner)} NOLOGIN NOSUPERUSER`;
    await sql`CREATE ROLE ${sql(app)} NOLOGIN NOSUPERUSER`;
    await sql`GRANT USAGE, CREATE ON SCHEMA public TO ${sql(owner)}`;
    ownerSql = postgres(database.url, { max: 1, onnotice: () => {} });
    appSql = postgres(database.url, { max: 1, onnotice: () => {} });
    await ownerSql`SET ROLE ${ownerSql(owner)}`;
    await appSql`SET ROLE ${appSql(app)}`;
    if (source === "schema") {
      await ownerSql.unsafe(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    } else {
      await migrate(ownerSql, { migrationsPath: new URL("../../cli/migrations", import.meta.url).pathname });
    }
    await ownerSql`GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO ${ownerSql(app)}`;
  }, 120000);

  afterAll(async () => {
    await ownerSql?.end();
    await appSql?.end();
    if (database) {
      const sql = database.sql;
      await sql`DROP OWNED BY ${sql(owner)}, ${sql(app)}`;
      await sql`DROP ROLE ${sql(owner)}, ${sql(app)}`;
      await database.close();
    }
  });

  async function fundedJournal() {
    const [alice] = await ownerSql`INSERT INTO konto_accounts (name, currency) VALUES (${randomUUID()}, 'INR') RETURNING id`;
    const [bank] = await ownerSql`INSERT INTO konto_accounts (name, currency) VALUES (${randomUUID()}, 'INR') RETURNING id`;
    const [journal] = await ownerSql`INSERT INTO konto_journals (account_id) VALUES (${alice.id}) RETURNING id`;
    await ownerSql`INSERT INTO konto_entries (journal_id, account_id, amount) VALUES (${journal.id}, ${alice.id}, 1000), (${journal.id}, ${bank.id}, -1000)`;
    return { alice: alice.id, bank: bank.id, journalId: journal.id };
  }

  it("runs as non-superuser roles and permits balanced append-only posting with INSERT/SELECT", async () => {
    const { alice, bank } = await fundedJournal();
    for (const sql of [ownerSql, appSql]) {
      const [role] = await sql`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`;
      expect(role.rolsuper).toBe(false);
    }
    const [privileges] = await appSql`SELECT has_table_privilege(current_user, 'konto_entries', 'INSERT') AS insert, has_table_privilege(current_user, 'konto_entries', 'UPDATE') AS update`;
    expect(privileges).toEqual({ insert: true, update: false });
    const [journal] = await appSql`INSERT INTO konto_journals (account_id) VALUES (${alice}) RETURNING id`;
    await appSql`INSERT INTO konto_entries (journal_id, account_id, amount) VALUES (${journal.id}, ${alice}, 100), (${journal.id}, ${bank}, -100)`;
  });

  for (const role of ["owner", "app"]) {
    for (const table of ["konto_entries", "konto_journals"]) {
      for (const operation of ["UPDATE", "DELETE", "TRUNCATE"]) {
        it(`rejects ${operation} of ${table} as ${role}`, async () => {
          const { journalId } = await fundedJournal();
          const sql = role === "owner" ? ownerSql : appSql;
          const statement = operation === "UPDATE"
            ? table === "konto_entries"
              ? `UPDATE konto_entries SET amount = -amount WHERE journal_id = $1`
              : `UPDATE konto_journals SET description = 'rewritten' WHERE id = $1`
            : operation === "DELETE"
              ? `DELETE FROM ${table} WHERE ${table === "konto_entries" ? "journal_id" : "id"} = $1`
              : `TRUNCATE ${table} CASCADE`;
          await expect(sql.unsafe(statement, operation === "TRUNCATE" ? [] : [journalId])).rejects.toThrow(role === "owner" ? new RegExp(`${table} is append-only`) : /permission denied/i);
          const [rows] = await ownerSql`SELECT COUNT(*)::int AS count, SUM(amount)::text AS total FROM konto_entries WHERE journal_id = ${journalId}`;
          expect(rows).toEqual({ count: 2, total: "0" });
          const journals = await ownerSql`SELECT id FROM konto_journals WHERE id = ${journalId}`;
          expect(journals).toHaveLength(1);
        });
      }
    }
  }

  it("also enforces the deferred zero-sum constraint on DELETE", async () => {
    const { journalId, alice } = await fundedJournal();
    await expect(ownerSql.begin(async (tx) => {
      const triggers = await tx`SELECT 1 FROM pg_trigger WHERE tgrelid = 'konto_entries'::regclass AND tgname = 'enforce_entries_immutable'`;
      if (triggers.length) await tx`ALTER TABLE konto_entries DISABLE TRIGGER enforce_entries_immutable`;
      await tx`DELETE FROM konto_entries WHERE journal_id = ${journalId} AND account_id = ${alice}`;
    })).rejects.toThrow(/unbalanced/i);
  });
});
