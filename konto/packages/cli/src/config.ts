import type { z } from "zod";

export interface LedgerSchema {
  transfer?: z.AnyZodObject;
  hold?: z.AnyZodObject;
  journal?: z.AnyZodObject;
  account?: z.AnyZodObject;
}

export function defineLedger<const T extends LedgerSchema>(schema: T): T {
  return schema;
}
