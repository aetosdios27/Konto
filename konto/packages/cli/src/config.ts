import type { z } from "zod";

export interface LedgerSchema {
  transfer?: z.ZodObject<any>;
  hold?: z.ZodObject<any>;
  journal?: z.ZodObject<any>;
  account?: z.ZodObject<any>;
}

export function defineLedger(schema: LedgerSchema): LedgerSchema {
  return schema;
}
