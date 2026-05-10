import Stripe from "stripe";
import { transfer } from "@konto-ledger/core";
import { config } from "../config.js";
import { sql } from "../db.js";
import { accounts } from "../bootstrap.js";

const stripe = new Stripe(config.STRIPE_SECRET_KEY);

/**
 * Translates verified Stripe events into double-entry journal entries.
 *
 * Rules enforced on every translation:
 *  - ALL monetary amounts are cast to BigInt (Stripe sends cents as integers)
 *  - The Stripe event ID (evt_...) is used as the idempotencyKey on every
 *    transfer() call, making Stripe retries structurally impossible to
 *    double-process
 */
export async function translateEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "charge.succeeded":
      await handleChargeSucceeded(event);
      break;
    case "payment_intent.succeeded":
      await handlePaymentIntentSucceeded(event);
      break;
    default:
      // Unknown event types are logged but never throw — the webhook
      // handler should not 500 on events we don't handle yet.
      console.log(
        `stripe-ledger: ignoring unhandled event type '${event.type}'`
      );
      break;
  }
}

// ── Shared three-leg journal creation ──────────────────────────────────────

// Simplified P&L model. gross - fee - net = 0 holds because
// Stripe guarantees amount = fee + net on every BalanceTransaction.
// A full balance sheet model would include a receivables account.

async function recordBalanceTransaction(
  balanceTxnId: string,
  eventId: string,
): Promise<void> {
  const balanceTxn = await stripe.balanceTransactions.retrieve(balanceTxnId);

  await transfer(sql, {
    accountId: accounts.stripe_gross_revenue,
    idempotencyKey: eventId,
    entries: [
      {
        accountId: accounts.stripe_gross_revenue,
        amount: BigInt(balanceTxn.amount),     // credit
      },
      {
        accountId: accounts.stripe_fees,
        amount: -BigInt(balanceTxn.fee),        // debit
      },
      {
        accountId: accounts.stripe_available_balance,
        amount: -BigInt(balanceTxn.net),         // debit
      },
    ],
  });
}

// ── charge.succeeded ───────────────────────────────────────────────────────

async function handleChargeSucceeded(event: Stripe.Event): Promise<void> {
  const charge = event.data.object as Stripe.Charge;

  const balanceTxnId = charge.balance_transaction;
  if (!balanceTxnId || typeof balanceTxnId !== "string") {
    throw new Error(
      `stripe-ledger: charge ${charge.id} has no balance_transaction ID`
    );
  }

  await recordBalanceTransaction(balanceTxnId, event.id);
}

// ── payment_intent.succeeded ───────────────────────────────────────────────

async function handlePaymentIntentSucceeded(event: Stripe.Event): Promise<void> {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;

  // PaymentIntents surface the BalanceTransaction through their latest charge.
  // latest_charge is a string ID when not expanded.
  const chargeId = paymentIntent.latest_charge;
  if (!chargeId || typeof chargeId !== "string") {
    throw new Error(
      `stripe-ledger: payment_intent ${paymentIntent.id} has no latest_charge ID`
    );
  }

  const charge = await stripe.charges.retrieve(chargeId);

  const balanceTxnId = charge.balance_transaction;
  if (!balanceTxnId || typeof balanceTxnId !== "string") {
    throw new Error(
      `stripe-ledger: charge ${charge.id} has no balance_transaction ID`
    );
  }

  await recordBalanceTransaction(balanceTxnId, event.id);
}
