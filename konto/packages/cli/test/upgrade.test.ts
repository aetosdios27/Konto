import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { describe, it, expect } from "vitest";
import { createTestDatabase } from "../../core/test/database";
import { migrate } from "../src/commands/migrate";
import { createAccount, transfer, hold, rollbackHold, getBalance } from "@konto-ledger/core";

describe("forward ledger upgrades", () => {
  it("preserves posted history and discards corrupt legacy snapshots when upgrading through 0009", async () => {
    const database = await createTestDatabase();
    const migrationsPath = new URL("../migrations", import.meta.url).pathname;
    const legacyPath = await mkdtemp(new URL(".migrations-", import.meta.url).pathname);
    const sql = database.sql;
    try {
      const files = (await readdir(migrationsPath)).filter((file) => file.endsWith(".sql") && file < "0008").sort();
      for (const file of files) await writeFile(`${legacyPath}/${file}`, await readFile(`${migrationsPath}/${file}`));
      await migrate(sql, { migrationsPath: legacyPath });
      const alice = await createAccount(sql, { name: "Alice", currency: "INR" });
      const bob = await createAccount(sql, { name: "Bob", currency: "INR" });
      const bank = await createAccount(sql, { name: "Bank", currency: "INR", account_type: "EQUITY" });
      const [journal] = await sql`INSERT INTO konto_journals (account_id) VALUES (${bank.id}) RETURNING id`;
      await sql`INSERT INTO konto_entries (journal_id, account_id, amount) VALUES (${journal.id}, ${bank.id}, -1000), (${journal.id}, ${alice.id}, 1000)`;
      const [held] = await sql`INSERT INTO konto_holds (account_id, recipient_id, amount) VALUES (${alice.id}, ${bob.id}, 250) RETURNING id`;
      await sql`SELECT take_snapshot(${alice.id})`;
      const [legacy] = await sql`SELECT balance::text FROM konto_balance_snapshots WHERE account_id = ${alice.id}`;
      expect(legacy.balance).toBe("750");
      const before = await sql`SELECT id, journal_id, account_id, amount::text, created_at FROM konto_entries ORDER BY id`;
      const upgraded = await migrate(sql, { migrationsPath });
      expect(upgraded.applied).toEqual(["0008_snapshot_sequences.sql", "0009_ledger_immutability.sql"]);
      expect(await sql`SELECT id FROM konto_balance_snapshots`).toHaveLength(0);
      expect(await sql`SELECT id, journal_id, account_id, amount::text, created_at FROM konto_entries ORDER BY id`).toEqual(before);
      expect((await getBalance(sql, alice.id)).balance).toBe(750n);
      await sql`SELECT take_snapshot(${alice.id})`;
      await rollbackHold(sql, held.id);
      await transfer(sql, { accountId: alice.id, entries: [{ accountId: alice.id, amount: -100n }, { accountId: bob.id, amount: 100n }] });
      const { holdId } = await hold(sql, { accountId: alice.id, recipientId: bob.id, amount: 100n });
      expect((await getBalance(sql, alice.id)).balance).toBe(800n);
      await rollbackHold(sql, holdId);
      expect((await getBalance(sql, alice.id)).balance).toBe(900n);
      expect(await migrate(sql, { migrationsPath })).toEqual({ applied: [] });
      await expect(sql`UPDATE konto_entries SET amount = -amount WHERE journal_id = ${journal.id}`).rejects.toThrow(/append.only/i);
    } finally {
      await rm(legacyPath, { recursive: true, force: true });
      await database.close();
    }
  }, 120000);
});
