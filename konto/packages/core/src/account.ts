import type { KontoQueryExecutor } from "@konto-ledger/types";

export interface CreateAccountPayload {
  id?: string;
  name: string;
  currency: string;
  account_type?: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  metadata?: any;
}

export async function createAccount(
  sql: KontoQueryExecutor,
  payload: CreateAccountPayload
): Promise<{ id: string; name: string; currency: string; account_type: string; metadata: any }> {
  const { id, name, currency, account_type = "ASSET", metadata } = payload;
  
  if (id) {
    const result = await sql<any[]>`
      INSERT INTO konto_accounts (id, name, currency, account_type, metadata)
      VALUES (${id}, ${name}, ${currency}, ${account_type}, ${metadata ? sql.json(metadata) : null})
      RETURNING id, name, currency, account_type, metadata
    `;
    return result[0];
  } else {
    const result = await sql<any[]>`
      INSERT INTO konto_accounts (name, currency, account_type, metadata)
      VALUES (${name}, ${currency}, ${account_type}, ${metadata ? sql.json(metadata) : null})
      RETURNING id, name, currency, account_type, metadata
    `;
    return result[0];
  }
}
