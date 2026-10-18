/**
 * T44 — legibility proof on a phone viewport: renders the two data cards of the review's adversarial scene as SVG and
 * screenshots each in headless Chromium at 390×844 (Android-class). No provider, no network, no spend.
 *   npx tsx scripts/qa/director/card-mobile-shot.ts --out-dir=<dir>
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import type { GeneratedScript } from "@/lib/providers/types";
import { dataCardSvg, directorReelPreflight } from "@/lib/video/director/data-card";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const OUT = path.resolve(arg("out-dir") ?? "card-mobile");
fs.mkdirSync(OUT, { recursive: true });
const script: GeneratedScript = { title: "Dos afirmaciones", segments: [
  { text: "En 2019, el 30 % recordó la historia; en 2020, el 70 % recordó el dato.", visualQuery: "people remembering", visualConcepts: ["people remembering"] },
] };
const exe = process.env.REMOTION_BROWSER_EXECUTABLE || "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell";

async function main() {
  const cards = directorReelPreflight(script).cards;
  const browser = await chromium.launch({ executablePath: fs.existsSync(exe) ? exe : undefined });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const out: Record<string, unknown>[] = [];
  for (const c of cards) {
    const svg = dataCardSvg({ text: c.text, figure: c.figure, figures: c.figures });
    const svgPath = path.join(OUT, `card-${c.index}.svg`);
    fs.writeFileSync(svgPath, svg);
    // The card fills the phone screen exactly like a 9:16 Reel frame (object-fit cover is what VerticalReel does).
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#000"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" style="width:390px;height:844px;object-fit:cover;display:block"></body></html>`);
    const png = path.join(OUT, `card-${c.index}-390x844.png`);
    await page.screenshot({ path: png, fullPage: false });
    // Measure the hero line's rendered height on the phone (from the SVG geometry scaled to the viewport).
    const fontSize = Number((svg.match(/font-weight="700"[^>]*font-size="(\d+)"|font-size="(\d+)" font-weight="700"/) ?? [])[1] ?? (svg.match(/font-size="(\d+)" font-weight="700"/) ?? [])[1] ?? 0);
    const heroPx = Math.round(fontSize * (844 / 1920) * 10) / 10;
    out.push({ card: c.index, hero: c.figures.map((f) => f.display).join(" · "), text: c.text, svg: svgPath, png, heroFontPxOnPhone: heroPx, sentenceFontPxOnPhone: Math.round(56 * (844 / 1920) * 10) / 10 });
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT, "cards.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
