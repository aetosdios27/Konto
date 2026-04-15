import postgres from "postgres";
import { KontoAccountNotFoundError } from "./errors";

// Task 1: Fetch Account
export async function getAccount(
  sql: ReturnType<typeof postgres>,
  accountId: string,
): Promise<{ id: string; name: string; currency: string } | null> {
  const result = await sql<{ id: string; name: string; currency: string }[]>`
    SELECT id, name, currency
    FROM konto_accounts
    WHERE id = ${accountId}
  `;

  const row = result[0];
  if (!row) {
    return null;
  }

  return row;
}

// Task 2: Fetch Secure Liquid Balance
export async function getBalance(
  sql: ReturnType<typeof postgres>,
  accountId: string,
): Promise<{ accountId: string; balance: bigint; currency: string }> {
  // Join to get accounts, explicitly convert sums to TEXT mathematically checking for BigInt float decay boundaries
  const result = await sql<
    { id: string; currency: string; entries_sum: string; holds_sum: string }[]
  >`
    SELECT 
      a.id,
      a.currency,
      COALESCE(e.total, 0)::text AS entries_sum,
      COALESCE(h.total, 0)::text AS holds_sum
    FROM konto_accounts a
    LEFT JOIN (
      SELECT account_id, SUM(amount) as total
      FROM konto_entries
      WHERE account_id = ${accountId}
      GROUP BY account_id
    ) e ON e.account_id = a.id
    LEFT JOIN (
      SELECT account_id, SUM(amount) as total
      FROM konto_holds
      WHERE account_id = ${accountId}
      GROUP BY account_id
    ) h ON h.account_id = a.id
    WHERE a.id = ${accountId}
  `;

  const row = result[0];
  if (!row) {
    throw new KontoAccountNotFoundError(`konto: account not found: ${accountId}`);
  }

  const entriesSum = BigInt(row.entries_sum);
  const holdsSum = BigInt(row.holds_sum);
  
  // Explicit logic resolving B_a = Sum(Entries) - Sum(Holds)
  const balance = entriesSum - holdsSum;

  return {
    accountId: row.id,
    balance,
    currency: row.currency,
  };
}

// Task 3: Fetch Paginated Journals rigorously
export interface GetJournalsOptions {
  limit?: number;
  cursorId?: string;
  cursorDate?: Date;
  from?: Date;
  to?: Date;
}

export interface JournalEntry {
  accountId: string;
  amount: bigint;
}

export interface JournalWithEntries {
  id: string;
  description: string | null;
  metadata: any | null;
  idempotencyKey: string | null;
  createdAt: Date;
  entries: JournalEntry[];
}

export async function getJournals(
  sql: ReturnType<typeof postgres>,
  accountId: string,
  options: GetJournalsOptions = {},
): Promise<JournalWithEntries[]> {
  const limit = options.limit ?? 50;

  // Utilize json_agg recursively to avoid N+1, explicitly decay BigInt payload elements to TEXT inside the aggregation logic to dodge precision decay flaws.
  // Use lateral joins logically isolated to the journal batch being addressed.
  
  const journals = await sql<any[]>`
    SELECT 
      j.id,
      j.description,
      j.metadata,
      j.idempotency_key,
      j.created_at,
      e.agg_entries as entries
    FROM konto_journals j
    JOIN LATERAL (
      SELECT 
        json_agg(
          json_build_object(
            'accountId', account_id,
            'amount', amount::text
          )
        ) as agg_entries
      FROM konto_entries
      WHERE journal_id = j.id
    ) e ON true
    WHERE j.id IN (
      SELECT journal_id FROM konto_entries WHERE account_id = ${accountId}
    )
    ${options.from ? sql`AND j.created_at >= ${options.from}` : sql``}
    ${options.to ? sql`AND j.created_at <= ${options.to}` : sql``}
    ${
      options.cursorId && options.cursorDate
        ? sql`AND (j.created_at, j.id) < (${options.cursorDate}, ${options.cursorId}::uuid)`
        : sql``
    }
    ORDER BY j.created_at DESC, j.id DESC
    LIMIT ${limit}
  `;

  return journals.map((j) => ({
    id: j.id,
    description: j.description,
    metadata: j.metadata,
    idempotencyKey: j.idempotency_key,
    createdAt: j.created_at,
    entries: j.entries.map((ent: any) => ({
      accountId: ent.accountId,
      amount: BigInt(ent.amount),
    })),
  }));
}
