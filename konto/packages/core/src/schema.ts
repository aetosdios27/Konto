import { z } from "zod";

// Define a mathematically strict, recursive JSON type
const literalSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
type Literal = z.infer<typeof literalSchema>;
type Json = Literal | { [key: string]: Json } | Json[];

export const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([literalSchema, z.array(jsonSchema), z.record(jsonSchema)]),
);

export const TransferPayloadSchema = z.object({
  accountId: z.string().uuid(),
  idempotencyKey: z.string().max(100).optional(),
  entries: z
    .array(
      z.object({
        accountId: z.string().uuid(),
        amount: z.bigint(), // Rejects floats and standard numbers entirely
      }),
    )
    .min(2),
  // Metadata is now strictly verified as serializable JSON at runtime
  metadata: z.record(jsonSchema).optional(),
});

export type TransferPayload = z.infer<typeof TransferPayloadSchema>;

export const HoldPayloadSchema = z.object({
  idempotencyKey: z.string().max(100).optional(),
  accountId: z.string().uuid(),
  recipientId: z.string().uuid(),
  amount: z.bigint(),
  ttlMs: z.number().int().positive().optional(),
  metadata: z.record(jsonSchema).optional(),
});

export type HoldPayload = z.infer<typeof HoldPayloadSchema>;
