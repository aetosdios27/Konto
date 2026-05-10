import { intro, outro, spinner, log } from "@clack/prompts";
import pc from "picocolors";
import fs from "fs";
import path from "path";
import { createJiti } from "jiti";
import { generateClient } from "../generator/generateClient";

export async function generateCommand() {
  intro(pc.bgBlack(pc.white(" KONTO GENERATOR ")));

  const s = spinner();
  s.start("Scanning for konto.config.ts...");

  const cwd = process.cwd();
  const configPath = path.resolve(cwd, "konto.config.ts");

  if (!fs.existsSync(configPath)) {
    s.stop(pc.red("✖ Config not found!"));
    log.error(`Could not locate ${pc.cyan("konto.config.ts")} in your project root.`);
    log.message(
      `Please create one. Example:\n\n` +
      pc.dim(`import { z } from "zod";\n`) +
      pc.dim(`import { defineLedger } from "@konto-ledger/cli";\n\n`) +
      pc.dim(`export default defineLedger({\n`) +
      pc.dim(`  transfer: z.object({\n`) +
      pc.dim(`    invoice_id: z.string(),\n`) +
      pc.dim(`    notes: z.string().optional(),\n`) +
      pc.dim(`  }),\n`) +
      pc.dim(`});`)
    );
    process.exit(1);
  }

  try {
    s.message("Loading configuration...");
    const urlStr = typeof __filename !== "undefined" ? __filename : import.meta.url;
    const jiti = createJiti(urlStr);
    
    // In jiti 2: we use async import Native loader
    const configModule: any = await jiti.import(configPath, { default: true });
    const schema = configModule.default || configModule;

    s.message("Generating strictly typed client explicitly masking ledger primitives...");
    await generateClient(schema);

    s.stop(pc.green("✔ Client generated safely into node_modules/.konto"));
    log.info(pc.cyan("Import your strict client directly using:"));
    log.message(pc.green("import { transfer, hold } from '.konto';"));
    
    outro("Strict DX enabled. You are ready to build.");
  } catch (err: any) {
    s.stop(pc.red("✖ Generation failed!"));
    log.error(err.message);
    process.exit(1);
  }
}
