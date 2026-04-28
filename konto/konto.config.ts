import { z } from "zod";
import { defineLedger } from "@konto/cli";

export default defineLedger({
  transfer: z.object({
    invoice_id: z.string(),
    notes: z.string().optional(),
  }),
  account: z.object({
    status: z.enum(["ACTIVE", "FROZEN"]),
  }),
});
