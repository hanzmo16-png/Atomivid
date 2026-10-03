// Captures REAL ATOMIVID interface components for the teaser (no account, no Supabase, no submit).
// Source: the deployed branch's own components rendered by `next dev` on its built-in visual-QA routes
// (/dev/states, /dev/long-form: real components with fixture data). Only fixture TEXT is changed
// (project title / counters) so the demo tells one coherent story about a real ATOMIVID production
// (DULCE: What Came Home). Element screenshots at 3x (390 px viewport → 1170 px wide).
// usage: node ui_capture.mjs <baseUrl> <outDir>
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const [base, out] = process.argv.slice(2);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, colorScheme: "dark" });
const page = await ctx.newPage();
const meta = {};
const TITLE = "DULCE: What Came Home";

/** Smallest ancestor that is a card (rounded border container) holding `text`. */
async function cardFor(text, { exact = false, nth = 0 } = {}) {
  const el = page.getByText(text, { exact }).nth(nth);
  await el.scrollIntoViewIfNeeded();
  return el.locator("xpath=ancestor::*[contains(concat(' ',normalize-space(@class),' '),' border ') and contains(@class,'rounded')][1]");
}
async function shot(locator, name) {
  await page.waitForTimeout(120);
  await locator.screenshot({ path: `${out}/${name}.png`, animations: "disabled" });
  const box = await locator.boundingBox();
  meta[name] = { w: Math.round(box.width * 3), h: Math.round(box.height * 3) };
}
const replaceText = (from, to) => page.evaluate(([f, t]) => {
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.nodeValue.includes(f)) n.nodeValue = n.nodeValue.split(f).join(t);
}, [from, to]);

// ---------- /dev/states: content-type selector ----------
await page.goto(`${base}/dev/states`, { waitUntil: "networkidle" });
await page.addStyleTag({ content: "nextjs-portal{display:none!important} [data-nextjs-toast]{display:none!important} .fixed{display:none!important}" });
const sel = await cardFor("¿Qué quieres crear?");
await shot(sel, "selector");
const yt = page.getByText("YouTube / Documental").first();
await yt.hover();
await shot(sel, "selector-hover");
const ytBox = await yt.locator("xpath=ancestor::*[self::button or self::a or @role='button' or contains(@class,'rounded')][1]").boundingBox();
const selBox = await sel.boundingBox();
meta.selectorTarget = { x: Math.round((ytBox.x - selBox.x) * 3), y: Math.round((ytBox.y - selBox.y) * 3), w: Math.round(ytBox.width * 3), h: Math.round(ytBox.height * 3) };

// ---------- /dev/long-form: title field typing, confirm, progress, result ----------
await page.goto(`${base}/dev/long-form`, { waitUntil: "networkidle" });
await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
const titleInput = page.locator("input").filter({ hasNot: page.locator("xpath=..//input[@type='checkbox']") }).nth(0);
// The first "Título principal" input of the YouTube presentation block.
const label = page.getByText("Título principal (grande)").first();
await label.scrollIntoViewIfNeeded();
const input = label.locator("xpath=following::input[1]");
const titleCard = label.locator("xpath=ancestor::*[contains(concat(' ',normalize-space(@class),' '),' border ') and contains(@class,'rounded')][1]");
// The character counter is rendered from the fixture's initial value; keep it in step with the typed title.
const setCounter = (n) => titleCard.evaluate((el, k) => {
  for (const e of el.querySelectorAll("*")) if (/^\(\d+\/40\)$/.test(e.textContent.trim()) && ![...e.children].some((c) => /\/40/.test(c.textContent))) e.textContent = `(${k}/40)`;
}, n);
await input.fill("");
await setCounter(0);
await shot(titleCard, "title-000");
for (let i = 1; i <= TITLE.length; i++) {
  await input.fill(TITLE.slice(0, i));
  await setCounter(i);
  await shot(titleCard, `title-${String(i).padStart(3, "0")}`);
}
meta.titleFrames = TITLE.length + 1;
void titleInput;
const confirm = page.getByText("Confirmar y generar video").first();
await confirm.scrollIntoViewIfNeeded();
const confirmBlock = confirm.locator("xpath=ancestor-or-self::button[1]");
await shot(confirmBlock, "confirm");
await confirmBlock.hover();
await shot(confirmBlock, "confirm-hover");

// Progress cards (real component, real stage labels), each as rendered.
const stages = [
  ["queued", "En cola — el trabajo empezará en unos instantes"],
  ["narrating", "Narrando el guion..."],
  ["scenes", "Preparando imágenes y video por escena..."],
  ["render", "Renderizando el documental..."],
];
const BARCARD = "xpath=//div[contains(@class,'bg-accent') and contains(@style,'width')]/" + "ancestor::*[contains(concat(' ',normalize-space(@class),' '),' border ') and contains(@class,'rounded')][1]";
const barCards = page.locator(BARCARD);
const cardByHeading = async (prefix) => {
  const n = await barCards.count();
  for (let i = 0; i < n; i++) { const c = barCards.nth(i); if ((await c.innerText()).trim().startsWith(prefix)) return c; }
  throw new Error(`no progress card for ${prefix}`);
};
await shot(await cardFor("En cola — el trabajo empezará en unos instantes"), "stage-queued");
for (const [name, text] of stages.slice(1)) {
  const c = await cardByHeading(text.replace(/\.\.\.$/, ""));
  await c.scrollIntoViewIfNeeded();
  await shot(c, `stage-${name}`);
}
// ---------- dedicated result (Long Form 16:9 completed) with the real project title ----------
await page.goto(`${base}/dev/states`, { waitUntil: "networkidle" });
await page.addStyleTag({ content: "nextjs-portal{display:none!important} .fixed{display:none!important} video{opacity:0!important}" });
await replaceText("Göbekli Tepe: el misterio de 11,000 años que cambió nuestra historia", TITLE);
await replaceText("Göbekli Tepe: el misterio", TITLE);
// Real metadata of DULCE (English narration, 600 s target) instead of the fixture's "Español · 30s".
await page.evaluate(() => {
  for (const e of document.querySelectorAll("p,span,div")) if (e.children.length === 0 && /^Español · 30s/.test(e.textContent.trim())) e.textContent = e.textContent.replace("Español · 30s", "Inglés · 600s");
});
const resTitle = page.getByText(TITLE).filter({ has: page.locator("xpath=self::h1|self::h2|self::h3") }).first();
const resHeading = (await resTitle.count()) ? resTitle : page.getByRole("heading", { name: TITLE }).first();
await resHeading.scrollIntoViewIfNeeded();
const resCard = resHeading.locator("xpath=ancestor::*[contains(concat(' ',normalize-space(@class),' '),' border ') and contains(@class,'rounded')][1]");
await shot(resCard, "result");
const vid = resCard.locator("video").first();
const vb = await vid.boundingBox();
const rb = await resCard.boundingBox();
meta.resultPlayer = { x: Math.round((vb.x - rb.x) * 3), y: Math.round((vb.y - rb.y) * 3), w: Math.round(vb.width * 3), h: Math.round(vb.height * 3) };
await writeFile(`${out}/meta.json`, JSON.stringify(meta, null, 2));
await browser.close();
console.log(JSON.stringify(meta));
