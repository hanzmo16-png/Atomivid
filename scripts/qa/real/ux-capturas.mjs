// USD 0, SOLO LECTURA: capturas de la experiencia del cliente en PRODUCCIÓN con la sesión del dueño (Simple UX 1.0,
// «antes/después»): inicio/historial, crear, Podcast y Facturación en Samsung 390×844 y escritorio. No pulsa nada que cree,
// autorice o cobre. Mide desplazamiento horizontal, enlaces de la cabecera y avisos visibles. Capturas a $EVID (cifrado).
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const APP = process.env.POD_UI_URL || "https://atomivid.vercel.app", EVID = process.env.EVID;
const HOST = new URL(APP).hostname;
const stateFor = () => { const st = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8")); st.cookies = (st.cookies ?? []).map((c) => ({ ...c, domain: HOST })); st.origins = []; return st; };
fs.mkdirSync(EVID, { recursive: true });
const TAG = process.env.UX_TAG || "antes";
const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || undefined });
const DEVICES = { samsung: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true }, escritorio: { viewport: { width: 1366, height: 900 } } };
for (const [label, opts] of Object.entries(DEVICES)) {
  const ctx = await browser.newContext({ ...opts, storageState: stateFor() });
  await ctx.addInitScript(() => { try { localStorage.setItem("atomivid_onboarding_completed_v1", "1"); } catch {} });
  const p = await ctx.newPage(); p.setDefaultTimeout(60000);
  for (const [name, route] of [["inicio", "/dashboard"], ["crear", "/dashboard/new"], ["podcast", "/dashboard/podcast"], ["facturacion", "/dashboard/billing"]]) {
    try {
      const r = await p.goto(`${APP}${route}`); await p.waitForLoadState("networkidle").catch(() => {});
      const info = await p.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        header: [...document.querySelectorAll("header a, header button, header summary")].filter((a) => a.getBoundingClientRect().width > 0).map((a) => (a.textContent || "").trim()).filter(Boolean),
        alerts: [...document.querySelectorAll("[role=alert], [role=status]")].map((a) => (a.textContent || "").trim().slice(0, 80)).filter(Boolean).length,
        h1: document.querySelector("h1")?.textContent?.trim() ?? null,
      }));
      console.log(`UX ${TAG} ${label} ${name} ${JSON.stringify({ status: r?.status() ?? null, ...info })}`);
      await p.screenshot({ path: path.join(EVID, `${TAG}-${label}-${name}.png`), fullPage: true });
    } catch (e) { console.log(`UX_ERROR ${TAG} ${label} ${name} ${String(e?.message ?? e).slice(0, 200)}`); }
  }
  await ctx.close();
}
await browser.close();
console.log("RESULT ux-capturas: ok");
