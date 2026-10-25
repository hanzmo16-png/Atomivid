/**
 * M3-2 — Páginas públicas en teléfonos Android estrechos: el ancho de diseño (innerWidth) debe ser el del dispositivo.
 * Antes de la corrección, la cabecera de la portada (logo + «Planes» + «Iniciar sesión» + CTA) medía ~386 px de
 * contenido mínimo: en 360 px el CTA se salía 1,4 px y el teléfono alejaba la página a 361 px; en 320 px, a 362 px.
 * Solo lectura (sin sesión), USD 0, 127.0.0.1. FALLA (exit 1) mientras exista; PASA (exit 0) con la corrección.
 *
 *   E2E_SCRIPT=qa-aceptacion/m3-public-width.cjs scripts/harness/e2e/infra/run-e2e.sh m3-public-width
 */
const path = require("node:path"), fs = require("node:fs");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:3100";
const OUT = path.resolve(process.env.E2E_OUT ?? "m3-public-width-out"); fs.mkdirSync(OUT, { recursive: true });
const UA = "Mozilla/5.0 (Linux; Android 14; SM-A155M) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const WIDTHS = [320, 360, 412];
const ROUTES = ["/", "/login", "/register", "/forgot-password", "/avisame", "/acceso-anticipado", "/terms", "/privacy"];
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + JSON.stringify(detail ?? null).slice(0, 400)}`); };
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME || undefined });
  try {
    for (const width of WIDTHS) {
      const ctx = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: UA, locale: "es-MX" });
      const p = await ctx.newPage(); p.setDefaultTimeout(60000);
      for (const route of ROUTES) {
        const r = await p.goto(`${BASE}${route}`); await p.waitForLoadState("networkidle").catch(() => {}); await p.waitForTimeout(300);
        const m = await p.evaluate(() => {
          const cw = document.documentElement.clientWidth, out = [];
          for (const el of document.body.querySelectorAll("header *")) { const b = el.getBoundingClientRect(); if (b.width && b.right > cw + 0.5) out.push({ el: el.tagName.toLowerCase(), text: (el.textContent || "").trim().slice(0, 30), right: +b.right.toFixed(1) }); }
          return { iw: innerWidth, sw: document.documentElement.scrollWidth, headerOverflow: out.slice(0, 4) };
        });
        if (route === "/") await p.screenshot({ path: path.join(OUT, `portada-${width}.png`) });
        check(`[${width}px] ${route}: ancho de diseño = ${width} y la cabecera cabe`, r && r.status() < 400 && m.iw === width && m.sw <= width && m.headerOverflow.length === 0, { status: r?.status(), ...m });
      }
      await ctx.close();
    }
  } finally {
    const s = { pass: checks.filter((c) => c.ok).length, fail: checks.filter((c) => !c.ok).length, checks };
    fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(s, null, 2));
    console.log(`RESULTADO ${s.pass} PASS / ${s.fail} FAIL${s.fail ? " — defecto M3-2 presente" : ""}`);
    await browser.close(); process.exit(s.fail ? 1 : 0);
  }
})();
