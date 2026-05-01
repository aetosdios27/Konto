"use server";

import { revalidatePath } from "next/cache";
import { executeIntent, rejectIntent, transfer, hold } from "@konto/core";
import { sql } from "@/lib/db";
import { randomUUID } from "crypto";

export async function approveIntent(intentId: string) {
  try {
    const result = await executeIntent(sql as any, intentId);
    revalidatePath("/intents");
    revalidatePath("/accounts");
    revalidatePath("/holds");
    return { success: true, journalId: result.journalId };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function rejectStagedIntent(intentId: string) {
  try {
    await rejectIntent(sql as any, intentId);
    revalidatePath("/intents");
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ── Direct Mutations (Studio Command Center) ───────────────────────────────

export async function createAccountAction(name: string, currency: string, accountType: string) {
  try {
    const id = randomUUID();
    await (sql as any)`
      INSERT INTO konto_accounts (id, name, currency, account_type)
      VALUES (${id}, ${name}, ${currency}, ${accountType})
    `;
    revalidatePath("/");
    revalidatePath("/accounts");
    revalidatePath("/transfers");
    return { success: true, id };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function executeDirectTransferAction(
  entries: { accountId: string; amount: string }[],
  idempotencyKey: string
) {
  try {
    const entriesWithBigInt = entries.map(e => ({ accountId: e.accountId, amount: BigInt(e.amount) }));
    await transfer(sql as any, { entries: entriesWithBigInt, idempotencyKey });
    revalidatePath("/");
    revalidatePath("/accounts");
    revalidatePath("/transfers");
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function initializeHoldAction(
  accountId: string,
  recipientId: string,
  amount: string,
  idempotencyKey: string,
  expiresAt?: Date,
) {
  try {
    await hold(sql as any, {
      accountId,
      recipientId,
      amount: BigInt(amount),
      expiresAt,
      idempotencyKey,
    });
    revalidatePath("/");
    revalidatePath("/accounts");
    revalidatePath("/holds");
    revalidatePath("/transfers");
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
