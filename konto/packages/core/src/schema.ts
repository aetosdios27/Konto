import { z } from "zod";

export const TransferEntrySchema = z.object({
  accountId: z.string().uuid(),
  amount: z.bigint().refine((val) => val !== 0n, "Amount cannot be zero"),
});

export const TransferPayloadSchema = z.object({
  idempotencyKey: z.string().optional(),
  entries: z.array(TransferEntrySchema).min(2),
  metadata: z.record(z.unknown()).optional(),
});

export type TransferPayload = z.infer<typeof TransferPayloadSchema>;
