import "dotenv/config";

import Fastify from "fastify";
import { config } from "./config.js";
import { bootstrapAccounts } from "./bootstrap.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { apiRoutes } from "./routes/api.js";

const fastify = Fastify({
  logger: true,
});

// ── Raw body parsing ───────────────────────────────────────────────────────
// Stripe webhook signature verification requires the raw, unparsed request
// body as a Buffer. Override Fastify's default JSON parser to preserve it.
fastify.addContentTypeParser(
  "application/json",
  { parseAs: "buffer" },
  (_req, body, done) => {
    done(null, body);
  }
);

// ── BigInt serialization ───────────────────────────────────────────────────
// Fastify's default JSON serializer throws TypeError on BigInt values.
// This must be configured before registering any routes.
fastify.setReplySerializer((payload) =>
  JSON.stringify(payload, (_, v) =>
    typeof v === "bigint" ? v.toString() : v
  )
);

// ── Routes ─────────────────────────────────────────────────────────────────
fastify.register(webhookRoutes);
fastify.register(apiRoutes);

// ── Startup ────────────────────────────────────────────────────────────────
async function start() {
  try {
    await bootstrapAccounts();
    fastify.log.info("stripe-ledger: ledger accounts bootstrapped");

    await fastify.listen({ port: config.PORT, host: "0.0.0.0" });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
