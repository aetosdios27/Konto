import { createVercelAdapter } from "@konto-ledger/adapters/vercel";

// Automatically uses process.env.POSTGRES_URL
export const db = createVercelAdapter();
