import { z } from "zod";

// Define a mathematically strict, recursive JSON type
const literalSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
type Literal = z.infer<typeof literalSchema>;
type Json = Literal | { [key: string]: Json } | Json[];

const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([literalSchema, z.array(jsonSchema), z.record(jsonSchema)]),
);

export const TransferPayloadSchema = z.object({
  idempotencyKey: z.string().optional(),
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
