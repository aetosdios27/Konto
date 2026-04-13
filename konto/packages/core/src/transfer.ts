import postgres from "postgres";
import { TransferPayload } from "./schema";
import { KontoUnbalancedTransactionError } from "./errors";

export async function transfer(
  db: ReturnType<typeof postgres>,
  payload: TransferPayload,
): Promise<{ journalId: string }> {
  // TODO: Full locking + derived balance implementation starts here
  console.log("✅ Transfer called with payload:", payload);

  // Use db so TypeScript doesn't complain
  if (!db) {
    throw new KontoUnbalancedTransactionError();
  }

  // Temporary stub
  return { journalId: `temp-${Date.now()}` };
}
