/**
 * @konto/cli — approve command
 *
 * Fetches a staged intent from the database, displays the financial
 * impact in the terminal, prompts for human confirmation, and executes
 * the intent via @konto/core's executeIntent().
 *
 * Usage: npx @konto/cli approve <intent_id>
 */

import { intro, outro, log, confirm, isCancel } from "@clack/prompts";
import pc from "picocolors";
import postgres from "postgres";
import { executeIntent, rejectIntent } from "@konto/core";

export async function approveCommand(intentId: string) {
  intro(pc.bgBlack(pc.white(" KONTO APPROVE ")));

  if (!intentId) {
    log.error("Missing intent ID. Usage: npx @konto/cli approve <intent_id>");
    process.exit(1);
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    log.error("DATABASE_URL environment variable is not set.");
    process.exit(1);
  }

  const sql = postgres(dbUrl, { max: 2 });

  try {
    // Fetch the intent
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

    // Check if expired
    if (
      intent.status === "PENDING" &&
      intent.expires_at &&
      new Date() > intent.expires_at
    ) {
      await sql`
        UPDATE konto_staged_intents
        SET status = 'EXPIRED'
        WHERE id = ${intentId}
      `;
      log.error(
        `Intent ${intentId} has expired (expired at ${intent.expires_at.toISOString()}).`,
      );
      process.exit(1);
    }

    if (intent.status !== "PENDING") {
      log.error(
        `Intent ${intentId} is in state '${pc.bold(intent.status)}' — only PENDING intents can be approved.`,
      );
      process.exit(1);
    }

    // Display the intent details
    log.info(pc.bold("Staged Intent Details"));
    log.message(`  ${pc.dim("ID:")}           ${intent.id}`);
    log.message(`  ${pc.dim("Type:")}         ${pc.bold(intent.intent_type)}`);
    log.message(`  ${pc.dim("Created:")}      ${intent.created_at.toISOString()}`);
    if (intent.expires_at) {
      const remaining = intent.expires_at.getTime() - Date.now();
      const hoursLeft = Math.max(0, Math.round(remaining / (1000 * 60 * 60) * 10) / 10);
      log.message(`  ${pc.dim("Expires:")}      ${intent.expires_at.toISOString()} ${pc.yellow(`(${hoursLeft}h remaining)`)}`);
    }
    if (intent.idempotency_key) {
      log.message(`  ${pc.dim("Idempotency:")}  ${intent.idempotency_key}`);
    }

    // Display the financial impact
    log.info(pc.bold("Financial Impact"));

    if (intent.intent_type === "TRANSFER") {
      const payload = intent.payload as {
        accountId: string;
        entries: Array<{ accountId: string; amount: string }>;
      };
      log.message(`  ${pc.dim("Primary Account:")} ${payload.accountId}`);
      for (const entry of payload.entries) {
        const amount = BigInt(entry.amount);
        const direction = amount < 0n ? pc.red("DEBIT") : pc.green("CREDIT");
        log.message(`  ${direction}  ${entry.accountId}  ${amount.toString()}`);
      }
    } else if (intent.intent_type === "COMMIT_HOLD") {
      const payload = intent.payload as {
        holdId: string;
        holdDetails?: { accountId: string; recipientId: string; amount: string };
      };
      log.message(`  ${pc.dim("Hold ID:")}       ${payload.holdId}`);
      if (payload.holdDetails) {
        log.message(`  ${pc.dim("Sender:")}        ${payload.holdDetails.accountId}`);
        log.message(`  ${pc.dim("Recipient:")}     ${payload.holdDetails.recipientId}`);
        log.message(`  ${pc.dim("Amount:")}        ${payload.holdDetails.amount}`);
      }
    } else if (intent.intent_type === "ROLLBACK_HOLD") {
      const payload = intent.payload as {
        holdId: string;
        holdDetails?: { accountId: string; amount: string };
      };
      log.message(`  ${pc.dim("Hold ID:")}       ${payload.holdId}`);
      if (payload.holdDetails) {
        log.message(`  ${pc.dim("Account:")}       ${payload.holdDetails.accountId}`);
        log.message(`  ${pc.dim("Released:")}      ${payload.holdDetails.amount}`);
      }
    }

    // Prompt for confirmation
    const shouldApprove = await confirm({
      message: `Execute this ${intent.intent_type} intent?`,
      initialValue: false,
    });

    if (isCancel(shouldApprove) || !shouldApprove) {
      // Reject the intent
      await rejectIntent(sql as any, intentId);
      outro(pc.yellow("Intent rejected."));
      await sql.end();
      return;
    }

    // Execute
    log.step("Executing intent...");
    const result = await executeIntent(sql as any, intentId);

    if (result.journalId) {
      log.success(`Journal created: ${pc.bold(result.journalId)}`);
    }
    outro(pc.green("✓ Intent executed successfully."));
  } catch (err: any) {
    log.error(`Execution failed: ${err.message}`);
    process.exit(1);
  } finally {
    await sql.end();
  }
}
