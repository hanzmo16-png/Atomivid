/**
 * PREPARED, PAID (needs CONFIRM=IMAGE-COMPARE-0.40): controlled Recraft vs OpenAI comparison on 4 equivalent historical
 * scenes of e8048599 with the SAME documentary prompt. Hard limit: 4 Recraft (USD 0.035 + 0.005 style) + 4 OpenAI
 * (USD 0.05) = USD 0.345 at list price; 8 calls maximum, never retried (disableRetries). Idempotent: a file already
 * present in comparisons/ is not regenerated. Output: PNGs + a labeled contact sheet in ./comparison (uploaded as a
 * GitHub artifact the owner can download). DRY=1 only prints prompts, readiness and the cost.
 */
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";
const log = (t: string, v: unknown) => console.log(t, JSON.stringify(v));
const SCENES = [
  { id: "pass", intent: "Narrow coastal pass of Thermopylae between steep cliffs and the sea at dawn, 480 BC, wide establishing shot" },
  { id: "phalanx", intent: "Spartan hoplites in a locked shield wall, bronze round shields, crimson cloaks, spears leveled, medium shot, 480 BC" },
  { id: "huns", intent: "Hun horse archers galloping across an open steppe with composite bows, dust rising, 5th century AD, wide shot" },
  { id: "herodotus", intent: "Ancient Greek manuscript pages on a scholar's desk under candlelight, archival close-up, no legible modern text" },
];
async function exists(p: string) { try { await access(p); return true; } catch { return false; } }
async function main() {
  const dry = process.env.DRY === "1";
  if (!dry && process.env.CONFIRM !== "IMAGE-COMPARE-0.40") throw Error("confirmation missing");
  const [{ documentaryImagePrompt }, { recraftImageProvider, recraftEstimatedCostUsd }, { openaiImageProvider, ESTIMATED_COST_USD }] = await Promise.all([
    import("../src/lib/video/long-form/visual-intents"), import("../src/lib/providers/image/recraft"), import("../src/lib/providers/image/openai")]);
  const out = path.resolve("comparison"); await mkdir(out, { recursive: true });
  const cost = SCENES.length * (recraftEstimatedCostUsd({}) + Number(ESTIMATED_COST_USD));
  log("COMPARE", { dry, scenes: SCENES.length, listPriceUsd: Math.round(cost * 1e4) / 1e4, recraftReady: !!process.env.FAL_KEY, openaiReady: !!process.env.OPENAI_API_KEY, prompts: SCENES.map((s) => documentaryImagePrompt(s.intent).slice(0, 140)) });
  if (dry) return;
  const providers = [["recraft", recraftImageProvider], ["openai", openaiImageProvider]] as const;
  const tiles: { image: Buffer; label: string }[] = [];
  for (const s of SCENES) for (const [name, p] of providers) {
    const file = path.join(out, `${s.id}-${name}.png`);
    if (!(await exists(file))) {
      try {
        const asset = await p.generateImage({ prompt: documentaryImagePrompt(s.intent), aspectRatio: "16:9", disableRetries: true } as never);
        const buf = (asset as { buffer?: Buffer }).buffer; if (!buf) throw Error("no image bytes");
        await writeFile(file, buf); log("IMAGE", { scene: s.id, provider: name, bytes: buf.length, costUsd: (asset as { costUsd?: number }).costUsd ?? null });
      } catch (e) { log("IMAGE", { scene: s.id, provider: name, error: String(e).slice(0, 200) }); continue; }
    }
    tiles.push({ image: await readFile(file), label: `${s.id} · ${name}` });
  }
  if (tiles.length) {
    const { buildContactSheet } = await import("./lib/contact-sheet");
    const sheet = await buildContactSheet(tiles, { columns: 2, tileWidth: 640, tileHeight: 360, title: "e8048599 · Recraft (izq.) vs OpenAI (der.) · mismo prompt" });
    await writeFile(path.join(out, "contact-sheet.jpg"), sheet as never);
    log("COMPARE", { images: tiles.length, sheet: "comparison/contact-sheet.jpg (artifact)" });
  }
}
main().catch((e) => { console.log("FAILED", String(e).slice(0, 400)); process.exitCode = 1; });
