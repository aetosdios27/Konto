import fs from "fs";
import path from "path";
import { LedgerSchema } from "../config";

function parseType(value: string): string {
  let cleanValue = value;
  if (value.endsWith("?")) {
    cleanValue = value.slice(0, -1);
  }

  if (cleanValue.startsWith("enum:[")) {
    const arrString = cleanValue.substring(5); // "['A', 'B']"
    try {
      const parsed = eval(arrString);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => `"${item}"`).join(" | ");
      }
    } catch {
      return "any";
    }
  }

  return cleanValue;
}

function generateInterface(name: string, schema?: Record<string, string>) {
  if (!schema || Object.keys(schema).length === 0) {
    return `export type ${name} = Record<string, any>;`;
  }
  
  let result = `export interface ${name} {\n`;
  for (const [key, value] of Object.entries(schema)) {
    const isOptional = value.endsWith("?");
    const propName = isOptional ? `${key}?` : key;
    const typeName = parseType(value);
    result += `  ${propName}: ${typeName};\n`;
  }
  result += `}`;
  return result;
}

export async function generateClient(schema: LedgerSchema) {
  const dtsContent = `
import {
  transfer as coreTransfer,
  hold as coreHold,
  commitHold as coreCommitHold,
  rollbackHold as coreRollbackHold,
  getAccount as coreGetAccount,
  getBalance as coreGetBalance,
  getJournals as coreGetJournals
} from "@konto/core";
import type { TransferPayload, HoldPayload } from "@konto/core";
import type postgres from "postgres";

${generateInterface("TransferMetadata", schema.transfer)}
${generateInterface("HoldMetadata", schema.hold)}
${generateInterface("JournalMetadata", schema.journal)}
${generateInterface("AccountMetadata", schema.account)}

export type CustomTransferPayload = Omit<TransferPayload, "metadata"> & { metadata?: TransferMetadata };
export type CustomHoldPayload = Omit<HoldPayload, "metadata"> & { metadata?: HoldMetadata };

export declare function transfer(sql: ReturnType<typeof postgres>, payload: CustomTransferPayload): ReturnType<typeof coreTransfer>;

export declare function hold(sql: ReturnType<typeof postgres>, payload: CustomHoldPayload): ReturnType<typeof coreHold>;

export declare function commitHold(sql: ReturnType<typeof postgres>, holdId: string, metadata?: JournalMetadata): ReturnType<typeof coreCommitHold>;

export declare function rollbackHold(sql: ReturnType<typeof postgres>, holdId: string, metadata?: JournalMetadata): ReturnType<typeof coreRollbackHold>;

export { coreGetAccount as getAccount, coreGetBalance as getBalance, coreGetJournals as getJournals };
`;

  const jsContent = `
import { 
  transfer as coreTransfer, 
  hold as coreHold, 
  commitHold as coreCommitHold, 
  rollbackHold as coreRollbackHold, 
  getAccount as coreGetAccount, 
  getBalance as coreGetBalance, 
  getJournals as coreGetJournals 
} from "@konto/core";

export async function transfer(sql, payload) {
  return coreTransfer(sql, payload);
}

export async function hold(sql, payload) {
  return coreHold(sql, payload);
}

export async function commitHold(sql, holdId, metadata) {
  return coreCommitHold(sql, holdId, metadata);
}

export async function rollbackHold(sql, holdId, metadata) {
  return coreRollbackHold(sql, holdId, metadata);
}

export { coreGetAccount as getAccount, coreGetBalance as getBalance, coreGetJournals as getJournals };
`;

  const packageJsonContent = JSON.stringify({
    name: ".konto",
    version: "1.0.0",
    main: "index.js",
    types: "index.d.ts",
    type: "module"
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
