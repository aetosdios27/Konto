import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { config } from "../config.js";
import { translateEvent } from "../services/translator.js";

const stripe = new Stripe(config.STRIPE_SECRET_KEY);

export async function webhookRoutes(fastify: FastifyInstance) {
  fastify.post("/webhooks/stripe", async (request, reply) => {
    const sig = request.headers["stripe-signature"];
    if (!sig) {
      return reply.status(400).send({ error: "Missing stripe-signature header" });
    }

    // The raw body is preserved as a Buffer by the custom content-type
    // parser configured in server.ts. Stripe's constructEvent() requires
    // the raw unparsed body for HMAC signature verification.
    const rawBody = request.body as Buffer;

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        rawBody,
        sig,
        config.STRIPE_WEBHOOK_SECRET
      );
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Webhook signature verification failed";
      fastify.log.warn({ err }, "stripe-ledger: webhook verification failed");
      return reply.status(400).send({ error: message });
    }

    // Never process an unverified payload — if we reach here, the event
    // has been cryptographically verified against the webhook secret.
    try {
      await translateEvent(event);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Translation error";
      fastify.log.error({ err, eventId: event.id }, "stripe-ledger: translation failed");
      return reply.status(500).send({ error: message });
    }

    return reply.status(200).send({ received: true });
  });
}
