/**
 * @konto-ledger/cli — approve command
 *
 * Fetches staged intents from the database. Can approve a single intent via ID,
 * or launch an interactive bulk-approval queue UI.
 *
 * Usage: 
 *   npx @konto-ledger/cli approve <intent_id>
 *   npx @konto-ledger/cli approve
 */

import { intro, outro, log, confirm, select, multiselect, spinner, isCancel } from "@clack/prompts";
import pc from "picocolors";
import postgres from "postgres";
import { executeIntent, rejectIntent } from "@konto-ledger/core";

async function handleSingleIntent(sql: postgres.Sql, intentId: string) {
  const rows = await sql<{
    id: string;
    intent_type: string;
    idempotency_key: string | null;
    payload: any;
    status: string;
    created_at: Date;
    expires_at: Date | null;
  }[]>`
    SELECT id, intent_type, idempotency_key, payload, status, created_at, expires_at
    FROM konto_staged_intents
    WHERE id = ${intentId}
  `;

  if (rows.length === 0) {
    log.error(`Staged intent not found: ${intentId}`);
    process.exit(1);
  }

  const intent = rows[0]!;

  if (intent.status === "PENDING" && intent.expires_at && new Date() > intent.expires_at) {
    await sql`UPDATE konto_staged_intents SET status = 'EXPIRED' WHERE id = ${intentId}`;
    log.error(`Intent ${intentId} has expired.`);
    process.exit(1);
  }

  if (intent.status !== "PENDING") {
    log.error(`Intent ${intentId} is in state '${pc.bold(intent.status)}' — only PENDING intents can be approved.`);
    process.exit(1);
  }

  log.info(pc.bold("Staged Intent Details"));
  log.message(`  ${pc.dim("ID:")}           ${intent.id}`);
  log.message(`  ${pc.dim("Type:")}         ${pc.bold(intent.intent_type)}`);
  
  log.info(pc.bold("Financial Impact"));
  if (intent.intent_type === "TRANSFER") {
    const payload = intent.payload as { accountId: string; entries: Array<{ accountId: string; amount: string }> };
    log.message(`  ${pc.dim("Primary Account:")} ${payload.accountId}`);
    for (const entry of payload.entries) {
      const amount = BigInt(entry.amount);
      const direction = amount < 0n ? pc.red("DEBIT") : pc.green("CREDIT");
      log.message(`  ${direction}  ${entry.accountId}  ${amount.toString()}`);
    }
  } else {
    log.message(`  ${pc.dim("Payload:")} ${JSON.stringify(intent.payload)}`);
  }

  const shouldApprove = await confirm({
    message: `Execute this ${intent.intent_type} intent?`,
    initialValue: false,
  });

  if (isCancel(shouldApprove) || !shouldApprove) {
    await rejectIntent(sql as any, intentId);
    outro(pc.yellow("Intent rejected."));
    return;
  }

  log.step("Executing intent...");
  const result = await executeIntent(sql as any, intentId);
  if (result.journalId) {
    log.success(`Journal created: ${pc.bold(result.journalId)}`);
  }
  outro(pc.green("✓ Intent executed successfully."));
}

async function handleBulkQueue(sql: postgres.Sql) {
  const rows = await sql<{
    id: string;
    intent_type: string;
    payload: any;
    created_at: Date;
    expires_at: Date | null;
  }[]>`
    SELECT id, intent_type, payload, created_at, expires_at 
    FROM konto_staged_intents 
    WHERE status = 'PENDING' 
    ORDER BY created_at ASC
  `;

  if (rows.length === 0) {
    outro(pc.green("No pending intents found. The queue is clear!"));
    return;
  }

  const options = rows.map(r => {
    let summary = r.intent_type;
    if (r.intent_type === "TRANSFER" && r.payload?.entries?.length) {
      const val = BigInt(r.payload.entries[0].amount);
      summary += ` (${val < 0n ? Math.abs(Number(val)) : Number(val)} amt)`;
    }
    
    return {
      value: r.id,
      label: `${summary} — staged at ${r.created_at.toISOString().split("T")[1]}`,
    };
  });

  const selectedIds = await multiselect({
    message: "Select intents to execute/reject (Space to select, Enter to confirm)",
    options: options,
    required: false,
  });

  if (isCancel(selectedIds) || (selectedIds as string[]).length === 0) {
    outro("No intents selected. Queue left untouched.");
    return;
  }

  const ids = selectedIds as string[];

  const action = await select({
    message: `What would you like to do with the ${ids.length} selected intent(s)?`,
    options: [
      { value: "approve", label: "Approve & Execute" },
      { value: "reject", label: "Reject & Cancel" },
    ],
  });

  if (isCancel(action)) {
    outro("Operation cancelled.");
    return;
  }

  const s = spinner();
  s.start(`Processing ${ids.length} intents...`);

  let success = 0;
  let failed = 0;

  for (const id of ids) {
    try {
      if (action === "approve") {
        await executeIntent(sql as any, id);
      } else {
        await rejectIntent(sql as any, id);
      }
      success++;
    } catch (err: any) {
      log.error(`Failed to ${action} intent ${id}: ${err.message}`);
      failed++;
    }
  }

  s.stop(`Completed processing queue.`);
  if (failed > 0) {
    log.warn(`${success} succeeded, ${failed} failed.`);
  } else {
    log.success(`Successfully processed all ${success} intents.`);
  }
  outro(pc.green("Queue processing finished."));
}

export async function approveCommand(intentId?: string) {
  intro(pc.bgBlack(pc.white(" KONTO APPROVE ")));

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    log.error("DATABASE_URL environment variable is not set.");
    process.exit(1);
  }

  const sql = postgres(dbUrl, { max: 5 });

  try {
    if (intentId) {
      await handleSingleIntent(sql, intentId);
    } else {
      await handleBulkQueue(sql);
    }
  } catch (err: any) {
    log.error(`Execution failed: ${err.message}`);
    process.exit(1);
  } finally {
    await sql.end();
  }
}
