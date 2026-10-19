#!/usr/bin/env node
/**
 * Local/CI advisory podcast-script QA. Run with Node >=22.16:
 * node --experimental-strip-types scripts/podcast-editorial-check.mjs --file /private/script.txt --language es
 * No scripts are uploaded, persisted, printed or rewritten; only bounded excerpts enter the JSON report.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { reviewPodcastScript } from "../src/lib/podcast/editorial/preflight.ts";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: node --experimental-strip-types scripts/podcast-editorial-check.mjs --file SCRIPT.txt --language es|en");
    return;
  }
  const option = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const file = option("--file"), lang = option("--language");
  if (!file || !["es", "en"].includes(lang) || args.length !== 4 || args.filter(a => a === "--file" || a === "--language").length !== 2) {
    throw new Error("Expected --file SCRIPT.txt --language es|en. No provider calls performed.");
  }
  const bytes = await readFile(resolve(file));
  if (bytes.length > 160_000) throw new Error("Input exceeds local safety limit; no processing performed.");
  const script = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const report = reviewPodcastScript(script, lang);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
main().catch((error) => { console.error(`Podcast editorial preflight unavailable: ${error.message}`); process.exitCode = 1; });