/**
 * T44 — legibility proof on a phone viewport: renders the two data cards of the review's adversarial scene as SVG and
 * screenshots each with the repo's own headless Chromium (the Remotion browser; `npx remotion browser ensure`) at
 * 390×844 (Android-class), scale 2. No extra dependency, no provider, no network, no spend.
 *   npx tsx scripts/qa/director/card-mobile-shot.ts --out-dir=<dir> [--browser=<chromium executable>]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GeneratedScript } from "@/lib/providers/types";
import { dataCardSvg, directorReelPreflight } from "@/lib/video/director/data-card";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const OUT = path.resolve(arg("out-dir") ?? "card-mobile");
fs.mkdirSync(OUT, { recursive: true });
const script: GeneratedScript = { title: "Dos afirmaciones", segments: [
  { text: "En 2019, el 30 % recordó la historia; en 2020, el 70 % recordó el dato.", visualQuery: "people remembering", visualConcepts: ["people remembering"] },
] };

/** The Chromium the render itself uses (REMOTION_BROWSER_EXECUTABLE), else Remotion's downloaded browser, else a system one. */
function findBrowser(): string {
  const candidates = [arg("browser"), process.env.REMOTION_BROWSER_EXECUTABLE, process.env.CHROME_PATH,
    ...(fs.existsSync("/opt/pw-browsers") ? fs.readdirSync("/opt/pw-browsers").filter((d) => d.startsWith("chromium")).map((d) => path.join("/opt/pw-browsers", d, "chrome-linux", fs.existsSync(path.join("/opt/pw-browsers", d, "chrome-linux", "headless_shell")) ? "headless_shell" : "chrome")) : []),
    path.join(os.homedir(), ".cache/remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell"),
    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"];
  const found = candidates.find((c) => c && fs.existsSync(c));
  if (!found) throw new Error("no Chromium executable found: pass --browser=<path> or set REMOTION_BROWSER_EXECUTABLE");
  return found;
}

function main() {
  const browser = findBrowser();
  const cards = directorReelPreflight(script).cards;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "card-mobile-"));
  const out: Record<string, unknown>[] = [];
  for (const c of cards) {
    const svg = dataCardSvg({ text: c.text, figure: c.figure, figures: c.figures });
    const svgPath = path.join(OUT, `card-${c.index}.svg`);
    fs.writeFileSync(svgPath, svg);
    // The card fills the phone screen exactly like a 9:16 Reel frame (object-fit cover is what VerticalReel does).
    const html = path.join(work, `card-${c.index}.html`);
    fs.writeFileSync(html, `<!doctype html><html><body style="margin:0;background:#000"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" style="width:390px;height:844px;object-fit:cover;display:block"></body></html>`);
    const png = path.join(OUT, `card-${c.index}-390x844.png`);
    execFileSync(browser, ["--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=390,844", "--force-device-scale-factor=2", `--screenshot=${png}`, `file://${html}`], { stdio: ["ignore", "ignore", "pipe"], timeout: 60_000 });
    if (!fs.existsSync(png) || fs.statSync(png).size === 0) throw new Error(`screenshot failed for card ${c.index}`);
    // The hero line's rendered height on the phone (from the SVG geometry scaled to the viewport).
    const fontSize = Number((svg.match(/font-size="(\d+)" font-weight="700"/) ?? [])[1] ?? 0);
    out.push({ card: c.index, hero: c.figures.map((f) => f.display).join(" · "), text: c.text, svg: svgPath, png, browser,
      heroFontPxOnPhone: Math.round(fontSize * (844 / 1920) * 10) / 10, sentenceFontPxOnPhone: Math.round(56 * (844 / 1920) * 10) / 10 });
  }
  fs.writeFileSync(path.join(OUT, "cards.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 1));
}
try { main(); } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
