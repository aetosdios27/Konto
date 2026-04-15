export interface LedgerSchema {
  transfer?: Record<string, string>;
  hold?: Record<string, string>;
  journal?: Record<string, string>;
  account?: Record<string, string>;
}

export function defineLedger(schema: LedgerSchema): LedgerSchema {
  return schema;
}
