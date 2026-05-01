"use server";

import { revalidatePath } from "next/cache";
import { executeIntent, rejectIntent } from "@konto/core";
import { sql } from "@/lib/db";

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
