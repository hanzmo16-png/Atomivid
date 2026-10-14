/**
 * Offline analyzer for one beat's stored visual-plan response (chatgpt-11).
 *   npx tsx scripts/analyze-visual-plan.ts --response <copy.json> --narration <beats.json> --beat <i> [--cinematic] [--no-reference]
 * Reads local copies only (no network, no provider, no Supabase) and never writes its inputs.
 * Prints sizes/hashes, allow-listed schema issues, bounded key/type shapes and anchor counts — never narration,
 * scene text or unknown key names. Rejected input prints a fixed error code only.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { analyzeVisualPlan, AnalyzerInputError } from "../src/lib/video/long-form/visual-plan-analysis";

/** A saved visual-plan response is a few KB; refuse anything far larger instead of parsing it. */
export const MAX_INPUT_BYTES = 2_000_000;

function readJson(path: string, code: "response_invalid" | "narration_invalid") {
  let bytes: Buffer;
  try { bytes = readFileSync(path); } catch { throw new AnalyzerInputError(code); }
  if (bytes.length > MAX_INPUT_BYTES) throw new AnalyzerInputError(code);
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new AnalyzerInputError(code); }
  return { value, meta: { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } };
}

export function runAnalyzer(argv: { response: string; narration: string; beat: number; cinematic?: boolean; reference?: boolean }) {
  const response = readJson(argv.response, "response_invalid");
  const narration = readJson(argv.narration, "narration_invalid");
  const analysis = analyzeVisualPlan(response.value, narration.value, argv.beat,
    { cinematic: argv.cinematic === true, referenceContract: argv.reference !== false });
  return { inputs: { response: response.meta, narration: narration.meta }, beat: argv.beat, ...analysis };
}

/** CLI result: the analysis, or a fixed error code (never a message, path or stack). */
export function runAnalyzerCli(argv: string[]): { exitCode: number; output: string } {
  const get = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const response = get("--response"), narration = get("--narration"), beatText = get("--beat");
  const beat = beatText !== undefined && /^\d{1,6}$/.test(beatText) ? Number(beatText) : NaN;
  if (!response || !narration) return { exitCode: 2, output: JSON.stringify({ error: "usage" }) };
  if (!Number.isInteger(beat)) return { exitCode: 2, output: JSON.stringify({ error: "beat_out_of_range" }) };
  try {
    return { exitCode: 0, output: JSON.stringify(runAnalyzer({ response, narration, beat,
      cinematic: argv.includes("--cinematic"), reference: !argv.includes("--no-reference") }), null, 2) };
  } catch (error) {
    return error instanceof AnalyzerInputError
      ? { exitCode: 2, output: JSON.stringify({ error: error.code }) }
      : { exitCode: 1, output: JSON.stringify({ error: "internal" }) };
  }
}

if (process.argv[1]?.endsWith("analyze-visual-plan.ts")) {
  const { exitCode, output } = runAnalyzerCli(process.argv.slice(2));
  (exitCode === 0 ? console.log : console.error)(output);
  process.exitCode = exitCode;
}
