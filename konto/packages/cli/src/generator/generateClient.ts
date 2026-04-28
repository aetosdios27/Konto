import fs from "fs";
import path from "path";
import { LedgerSchema } from "../config";

export async function generateClient(schema: LedgerSchema) {
  const dtsContent = `
import {
  transfer as coreTransfer,
  hold as coreHold,
  commitHold as coreCommitHold,
  rollbackHold as coreRollbackHold,
  getAccount as coreGetAccount,
  getBalance as coreGetBalance,
  getJournals as coreGetJournals,
  createAccount as coreCreateAccount
} from "@konto/core";
import type { TransferPayload, HoldPayload } from "@konto/core";
import type postgres from "postgres";
import type { z } from "zod";
import type config from "../../konto.config";

type Config = typeof config;
type ExtractMetadata<T> = T extends z.ZodType<any, any, any> ? z.infer<T> : Record<string, any>;

export type TransferMetadata = Config extends { transfer: infer T } ? ExtractMetadata<T> : Record<string, any>;
export type HoldMetadata = Config extends { hold: infer T } ? ExtractMetadata<T> : Record<string, any>;
export type JournalMetadata = Config extends { journal: infer T } ? ExtractMetadata<T> : Record<string, any>;
export type AccountMetadata = Config extends { account: infer T } ? ExtractMetadata<T> : Record<string, any>;

export type CustomTransferPayload = Omit<TransferPayload, "metadata"> & { metadata?: TransferMetadata };
export type CustomHoldPayload = Omit<HoldPayload, "metadata"> & { metadata?: HoldMetadata };
export type CustomCreateAccountPayload = { id?: string, metadata?: AccountMetadata };

export declare function setKontoAdapter(executor: any): void;

export declare function createAccount(payload?: CustomCreateAccountPayload): ReturnType<typeof coreCreateAccount>;

export declare function transfer(payload: CustomTransferPayload): ReturnType<typeof coreTransfer>;

export declare function hold(payload: CustomHoldPayload): ReturnType<typeof coreHold>;

export declare function commitHold(holdId: string, metadata?: JournalMetadata): ReturnType<typeof coreCommitHold>;

export declare function rollbackHold(holdId: string, metadata?: JournalMetadata): ReturnType<typeof coreRollbackHold>;

export declare function getAccount(accountId: string): ReturnType<typeof coreGetAccount>;
export declare function getBalance(accountId: string): ReturnType<typeof coreGetBalance>;
export declare function getJournals(accountId: string, opts?: any): ReturnType<typeof coreGetJournals>;
`;

  const jsContent = `
import { 
  transfer as coreTransfer, 
  hold as coreHold, 
  commitHold as coreCommitHold, 
  rollbackHold as coreRollbackHold, 
  getAccount as coreGetAccount, 
  getBalance as coreGetBalance, 
  getJournals as coreGetJournals,
  createAccount as coreCreateAccount
} from "@konto/core";
import { createJiti } from "jiti";
import path from "path";
import postgres from "postgres";
import { fileURLToPath } from "url";

const jiti = createJiti(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(__dirname, "../../konto.config.ts");

const configModule = await jiti.import(configPath, { default: true });
const config = configModule.default || configModule;

// Internal singleton connection
let globalAdapter = null;
function getAdapter() {
  if (globalAdapter) return globalAdapter;
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Please set it or call setKontoAdapter().");
  }
  globalAdapter = postgres(process.env.DATABASE_URL);
  return globalAdapter;
}

export function setKontoAdapter(adapter) {
  globalAdapter = adapter;
}

export async function createAccount(payload = {}) {
  const adapter = getAdapter();
  if (config?.account && payload.metadata) {
    payload.metadata = config.account.parse(payload.metadata);
  }
  return coreCreateAccount(adapter, payload);
}

export async function transfer(payload) {
  const adapter = getAdapter();
  if (config?.transfer && payload.metadata) {
    payload.metadata = config.transfer.parse(payload.metadata);
  }
  return coreTransfer(adapter, payload);
}

export async function hold(payload) {
  const adapter = getAdapter();
  if (config?.hold && payload.metadata) {
    payload.metadata = config.hold.parse(payload.metadata);
  }
  return coreHold(adapter, payload);
}

export async function commitHold(holdId, metadata) {
  const adapter = getAdapter();
  let finalMetadata = metadata;
  if (config?.journal && metadata) {
    finalMetadata = config.journal.parse(metadata);
  }
  return coreCommitHold(adapter, holdId, finalMetadata);
}

export async function rollbackHold(holdId, metadata) {
  const adapter = getAdapter();
  let finalMetadata = metadata;
  if (config?.journal && metadata) {
    finalMetadata = config.journal.parse(metadata);
  }
  return coreRollbackHold(adapter, holdId, finalMetadata);
}

export async function getAccount(accountId) {
  return coreGetAccount(getAdapter(), accountId);
}

export async function getBalance(accountId) {
  return coreGetBalance(getAdapter(), accountId);
}

export async function getJournals(accountId, opts) {
  return coreGetJournals(getAdapter(), accountId, opts);
}
`;

  const packageJsonContent = JSON.stringify({
    name: ".konto",
    version: "1.0.0",
    main: "index.js",
    types: "index.d.ts",
    type: "module",
    dependencies: {
      "jiti": "^2.6.1",
      "postgres": "^3.4.5"
    }
  }, null, 2);

  const nodeModulesPath = path.resolve(process.cwd(), "node_modules");
  if (!fs.existsSync(nodeModulesPath)) {
    fs.mkdirSync(nodeModulesPath, { recursive: true });
  }
  
  const targetDir = path.join(nodeModulesPath, ".konto");
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  fs.writeFileSync(path.join(targetDir, "index.d.ts"), dtsContent.trim() + "\\n");
  fs.writeFileSync(path.join(targetDir, "index.js"), jsContent.trim() + "\\n");
  fs.writeFileSync(path.join(targetDir, "package.json"), packageJsonContent + "\\n");
}
