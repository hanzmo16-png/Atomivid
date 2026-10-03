// Renders ATOMIVID brand frames for the teaser with the REAL identity of the app:
// - LogoMark: the exact SVG of src/components/ui/Logo.tsx (three orbits + nucleus, accent #7c6aef)
// - tokens from src/app/globals.css (canvas #08080c, ink #f5f5f7, ink-muted #a3a3b0, accent #7c6aef,
//   accent-soft / accent-border), Geist (the app's font) and the landing hero's violet glow
// - pill style of the landing's "Beta pública" badge.
// Outputs PNG frames (end card animation) and still overlays. Deterministic: animations are paused and
// stepped frame by frame. usage: node brand_render.mjs <outDir> <geist.woff2>
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright";

const [out, fontPath] = process.argv.slice(2);
await mkdir(`${out}/end`, { recursive: true });
const font = (await readFile(fontPath)).toString("base64");
const FPS = 30, END_S = 2.0;

const MARK = (size) => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" class="mark">
  <g stroke="#7c6aef" stroke-width="1.3" stroke-linecap="round">
    <ellipse class="orb o1" cx="12" cy="12" rx="10" ry="4.1" pathLength="100"/>
    <ellipse class="orb o2" cx="12" cy="12" rx="10" ry="4.1" transform="rotate(60 12 12)" pathLength="100"/>
    <ellipse class="orb o3" cx="12" cy="12" rx="10" ry="4.1" transform="rotate(120 12 12)" pathLength="100"/>
  </g>
  <circle class="nuc" cx="12" cy="12" r="2.6" fill="#7c6aef"/>
</svg>`;

const BASE_CSS = `
@font-face { font-family: Geist; src: url(data:font/woff2;base64,${font}) format("woff2"); font-weight: 100 900; }
:root { --canvas:#08080c; --ink:#f5f5f7; --muted:#a3a3b0; --accent:#7c6aef; --accent-soft:rgba(124,106,239,.14); --accent-border:rgba(124,106,239,.35); }
* { margin:0; box-sizing:border-box; }
html,body { width:1080px; height:1920px; background:transparent; font-family:Geist, sans-serif; -webkit-font-smoothing:antialiased; }
`;

const END_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
body { background: var(--canvas); overflow:hidden; }
.glow { position:absolute; inset:0;
  background: radial-gradient(60% 34% at 50% 30%, rgba(124,106,239,.30), rgba(124,106,239,0) 70%),
              radial-gradient(50% 30% at 85% 92%, rgba(40,70,160,.22), rgba(40,70,160,0) 70%); }
.wrap { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; }
.markbox { margin-top:470px; filter: drop-shadow(0 0 38px rgba(124,106,239,.55)); animation: spin 2s linear both; }
.orb { stroke-dasharray:100; stroke-dashoffset:100; animation: draw .7s cubic-bezier(.2,.7,.2,1) both; }
.o2 { animation-delay:.12s } .o3 { animation-delay:.24s }
.nuc { transform-origin:12px 12px; transform:scale(0); animation: pop .35s cubic-bezier(.3,1.6,.5,1) .45s both; }
.word { margin-top:56px; font-weight:600; font-size:168px; letter-spacing:-.035em; color:var(--ink); line-height:1;
  opacity:0; transform:translateY(26px); animation: up .45s cubic-bezier(.2,.7,.2,1) .38s both; }
.tag { margin-top:40px; font-weight:500; font-size:66px; letter-spacing:-.02em; color:var(--muted);
  opacity:0; transform:translateY(20px); animation: up .45s cubic-bezier(.2,.7,.2,1) .62s both; }
.pill { margin-top:58px; font-weight:500; font-size:44px; color:#b9adff; padding:16px 40px; border-radius:999px;
  border:2px solid var(--accent-border); background:var(--accent-soft);
  opacity:0; transform:translateY(16px); animation: up .4s cubic-bezier(.2,.7,.2,1) .86s both; }
@keyframes draw { to { stroke-dashoffset:0 } }
@keyframes pop { to { transform:scale(1) } }
@keyframes up { to { opacity:1; transform:none } }
@keyframes spin { from { transform:rotate(-8deg) scale(.96) } to { transform:rotate(6deg) scale(1) } }
</style></head><body><div class="glow"></div><div class="wrap">
<div class="markbox">${MARK(300)}</div>
<div class="word">Atomivid</div>
<div class="tag">Tu idea. Tu video.</div>
<div class="pill">Próximamente.</div>
</div></body></html>`;

/** App-header lockup (Logo.tsx: mark + "Atomivid" semibold) on transparent, for the UI segment. */
const LOCKUP_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
html,body{width:600px;height:120px}
.l{display:flex;align-items:center;gap:22px;padding:20px;}
.l span{font-weight:600;font-size:64px;letter-spacing:-.03em;color:var(--ink)}
</style></head><body><div class="l">${MARK(80)}<span>Atomivid</span></div></body></html>`;

/** "Hecho con Atomivid" badge in the landing pill style, transparent, for the results montage. */
const BADGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
html,body{width:900px;height:160px}
.b{display:inline-flex;align-items:center;gap:20px;margin:20px;padding:18px 40px 18px 28px;border-radius:999px;
  border:2px solid var(--accent-border);background:rgba(8,8,12,.72);backdrop-filter:blur(8px);}
.b span{font-weight:600;font-size:52px;letter-spacing:-.02em;color:var(--ink)}
.b em{font-style:normal;color:#b9adff}
</style></head><body><div class="b">${MARK(64)}<span>Hecho con <em>Atomivid</em></span></div></body></html>`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
await page.setContent(END_HTML, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
await page.evaluate(() => document.getAnimations().forEach((a) => a.pause()));
const n = Math.round(END_S * FPS);
for (let i = 0; i < n; i++) {
  const ms = (i / FPS) * 1000;
  await page.evaluate((t) => document.getAnimations().forEach((a) => { a.currentTime = t; }), ms);
  await page.screenshot({ path: `${out}/end/${String(i).padStart(3, "0")}.png` });
}
for (const [html, name, w, h] of [[LOCKUP_HTML, "lockup", 600, 120], [BADGE_HTML, "badge", 900, 160]]) {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await p.setContent(html, { waitUntil: "load" });
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: `${out}/${name}.png`, omitBackground: true });
  await p.close();
}
await browser.close();
console.log(`end card ${n} frames + lockup + badge`);
