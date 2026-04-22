import type { KontoQueryExecutor } from "@konto/types";

export interface CreateAccountPayload {
  id?: string;
  name: string;
  currency: string;
  metadata?: any;
}

export async function createAccount(
  sql: KontoQueryExecutor,
  payload: CreateAccountPayload
): Promise<{ id: string; name: string; currency: string; metadata: any }> {
  const { id, name, currency, metadata } = payload;
  
  if (id) {
    const result = await sql<any[]>`
      INSERT INTO konto_accounts (id, name, currency, metadata)
      VALUES (${id}, ${name}, ${currency}, ${metadata ? sql.json(metadata) : null})
      RETURNING id, name, currency, metadata
    `;
    return result[0];
  } else {
    const result = await sql<any[]>`
      INSERT INTO konto_accounts (name, currency, metadata)
      VALUES (${name}, ${currency}, ${metadata ? sql.json(metadata) : null})
      RETURNING id, name, currency, metadata
    `;
    return result[0];
  }
}
