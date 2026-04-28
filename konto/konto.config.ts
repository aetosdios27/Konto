import { z } from "zod";
import { defineLedger } from "@konto/cli";

export default defineLedger({
  transfer: z.object({
    invoice_id: z.string(),
    notes: z.string().optional(),
  }),
  hold: z.object({
    reason: z.enum(["AUTH_ONLY", "ESCROW"]),
  }),
  journal: z.object({
    source: z.enum(["HOLD_COMMIT", "MANUAL_ADJUSTMENT"]),
  }),
  account: z.object({
    status: z.enum(["ACTIVE", "FROZEN"]),
  }),
});
