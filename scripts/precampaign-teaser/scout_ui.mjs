// Screenshots of the deployed ATOMIVID app (public pages only; no login, no account, no form submit).
// usage: node scout_ui.mjs <baseUrl> <outDir>
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const [base, out] = process.argv.slice(2);
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const pages = ["/", "/login", "/register", "/pricing"];
const shots = [];
for (const [name, viewport, scale] of [["mobile", { width: 390, height: 844 }, 3], ["desktop", { width: 1440, height: 900 }, 2]]) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: scale, colorScheme: "dark" });
  const page = await ctx.newPage();
  for (const p of pages) {
    try {
      const res = await page.goto(base + p, { waitUntil: "networkidle", timeout: 45000 });
      await page.waitForTimeout(1500);
      const file = `${out}/${name}${p === "/" ? "-home" : p.replace(/\//g, "-")}.png`;
      await page.screenshot({ path: file });
      await page.screenshot({ path: file.replace(".png", "-full.png"), fullPage: true });
      shots.push({ page: p, viewport: name, status: res?.status() ?? null, finalUrl: page.url(), file });
    } catch (e) {
      shots.push({ page: p, viewport: name, error: String(e).slice(0, 200) });
    }
  }
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(shots, null, 2));
