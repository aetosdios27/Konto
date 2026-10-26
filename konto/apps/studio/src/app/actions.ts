"use server";

import { revalidatePath } from "next/cache";
import { executeIntent, rejectIntent, transfer, hold, commitHold, rollbackHold } from "@konto-ledger/core";
import { sql } from "@/lib/db";
import { randomUUID } from "crypto";

export async function approveIntent(intentId: string) {
  try {
    const result = await executeIntent(sql, intentId);
    revalidatePath("/intents");
    revalidatePath("/accounts");
    revalidatePath("/holds");
    return { success: true, journalId: result.journalId };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function rejectStagedIntent(intentId: string) {
  try {
    await rejectIntent(sql, intentId);
    revalidatePath("/intents");
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Direct Mutations (Studio Command Center) ───────────────────────────────

export async function createAccountAction(name: string, currency: string, accountType: string, initialBalance?: string) {
  try {
    const id = randomUUID();
    await sql`
      INSERT INTO konto_accounts (id, name, currency, account_type)
      VALUES (${id}, ${name}, ${currency}, ${accountType})
    `;

    if (initialBalance && /^\d+$/.test(initialBalance) && BigInt(initialBalance) > 0n) {
      const GENESIS_ACCOUNT_NAME = `__konto_genesis_${currency.toUpperCase()}__`;
      
      const genesisId = randomUUID();
      await sql`
        INSERT INTO konto_accounts (id, name, currency, account_type)
        VALUES (${genesisId}, ${GENESIS_ACCOUNT_NAME}, ${currency}, 'LIABILITY')
        ON CONFLICT (name) DO NOTHING
      `;

      const genesisQuery = await sql`
        SELECT id FROM konto_accounts WHERE name = ${GENESIS_ACCOUNT_NAME}
      `;
      const actualGenesisId = genesisQuery[0].id;

      const entries = [
        { accountId: actualGenesisId, amount: -BigInt(initialBalance) },
        { accountId: id, amount: BigInt(initialBalance) }
      ];
      await transfer(sql, { entries, idempotencyKey: randomUUID() });
    }

    revalidatePath("/");
    revalidatePath("/accounts");
    revalidatePath("/transfers");
    return { success: true, id };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function executeDirectTransferAction(
  entries: { accountId: string; amount: string }[],
  idempotencyKey: string
) {
  try {
    const entriesWithBigInt = entries.map(e => ({ accountId: e.accountId, amount: BigInt(e.amount) }));
    await transfer(sql, { entries: entriesWithBigInt, idempotencyKey });
    revalidatePath("/");
    revalidatePath("/accounts");
    revalidatePath("/transfers");
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function initializeHoldAction(
  accountId: string,
  recipientId: string,
  amount: string,
  idempotencyKey: string,
  ttlMs?: number,
) {
  try {
    await hold(sql, {
      accountId,
      recipientId,
      amount: BigInt(amount),
      ttlMs,
      idempotencyKey,
    });
    revalidatePath("/");
    revalidatePath("/accounts");
    revalidatePath("/holds");
    revalidatePath("/transfers");
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function commitHoldAction(holdId: string) {
  try {
    await commitHold(sql, holdId);
    revalidatePath("/");
    revalidatePath("/accounts");
    revalidatePath("/holds");
    revalidatePath("/transfers");
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function rollbackHoldAction(holdId: string) {
  try {
    await rollbackHold(sql, holdId);
    revalidatePath("/");
    revalidatePath("/accounts");
    revalidatePath("/holds");
    revalidatePath("/transfers");
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
