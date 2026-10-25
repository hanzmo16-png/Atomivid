/**
 * Reproducción del defecto P1-1 (docs/qa-aceptacion/RECRAFT-MOVIL-P1.md). USD 0, 127.0.0.1.
 * FALLA (exit 1) mientras el formulario de Reel, con «Imágenes IA con Recraft» seleccionado, ensanche el diseño por encima
 * del ancho del teléfono; PASA (exit 0) cuando se corrija. No envía nada: solo abre el formulario.
 * Además identifica qué elemento fuerza el ancho (ocultándolos uno a uno) y guarda capturas a tamaño de pantalla.
 *
 *   E2E_OUT=<dir> E2E_BASE=http://127.0.0.1:3100 node recraft-mobile-repro.cjs
 */
const path = require("node:path"), fs = require("node:fs");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:3100";
const OUT = path.resolve(process.env.E2E_OUT ?? "recraft-repro-out"); fs.mkdirSync(OUT, { recursive: true });
const PHONES = { "samsung-s24-390": { width: 390, height: 844 }, "pixel-7-412": { width: 412, height: 915 }, "iphone-se-375": { width: 375, height: 667 } };
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME || undefined });
  const rows = [];
  for (const [name, viewport] of Object.entries(PHONES)) {
    const ctx = await browser.newContext({ viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }); const p = await ctx.newPage(); p.setDefaultTimeout(60000);
    await p.goto(`${BASE}/login`); await p.fill("input[name=email]", "pilot-owner@local.test"); await p.fill("input[name=password]", "local-pass-owner-1");
    await p.locator("form button[type=submit]").last().click(); await p.waitForURL(/\/dashboard/);
    await p.goto(`${BASE}/dashboard/new`); await p.getByRole("button", { name: "Omitir" }).click({ timeout: 4000 }).catch(() => {});
    await p.getByText("Reel / Short").click(); await p.waitForTimeout(800);
    const hasRecraft = (await p.locator("input[name=reel_image_source][value=recraft]").count()) > 0;
    if (!hasRecraft) { rows.push({ name, skipped: "la cuenta no tiene Recraft habilitado en este entorno" }); await ctx.close(); continue; }
    await p.locator("input[name=reel_image_source][value=recraft]").check(); await p.waitForTimeout(600);
    const withRecraft = await p.evaluate(() => innerWidth);
    await p.screenshot({ path: path.join(OUT, `${name}-recraft.png`) });
    const culprits = await p.evaluate(async () => {
      const fs = document.querySelector("input[name=reel_image_source][value=recraft]").closest("fieldset"); const base = innerWidth, out = [];
      for (const el of fs.querySelectorAll("select,input,label,p,div")) {
        const prev = el.style.display; el.style.display = "none"; await new Promise((r) => setTimeout(r, 40)); const w = innerWidth; el.style.display = prev; await new Promise((r) => setTimeout(r, 40));
        if (w < base) out.push({ el: `${el.tagName.toLowerCase()}${el.getAttribute("name") ? `[name=${el.getAttribute("name")}]` : ""}`, text: (el.textContent || "").trim().slice(0, 70), widthWhenHidden: w });
      }
      return out.slice(0, 6);
    });
    await p.locator("input[name=reel_image_source][value=default]").check(); await p.waitForTimeout(600);
    const withArchive = await p.evaluate(() => innerWidth);
    await p.screenshot({ path: path.join(OUT, `${name}-archivo.png`) });
    rows.push({ name, device: viewport.width, withRecraft, withArchive, ok: withRecraft === viewport.width && withArchive === viewport.width, culprits });
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT, "recraft-mobile-repro.json"), JSON.stringify(rows, null, 2));
  for (const r of rows) console.log(r.skipped ? `SKIP  ${r.name}: ${r.skipped}` : `${r.ok ? "PASS" : "FAIL"}  ${r.name}: ancho de diseño con Recraft ${r.withRecraft} px / con archivo ${r.withArchive} px (dispositivo ${r.device} px)${r.ok ? "" : " — fuerzan el ancho: " + r.culprits.map((c) => `${c.el} «${c.text.slice(0, 40)}»`).join("; ")}`);
  const tested = rows.filter((r) => !r.skipped);
  if (!tested.length) { console.log("RESULTADO sin dispositivos evaluables (Recraft no habilitado)"); process.exit(2); }
  const failed = tested.filter((r) => !r.ok).length;
  console.log(`RESULTADO ${tested.length - failed}/${tested.length} PASS${failed ? " — defecto P1-1 presente" : " — P1-1 corregido"}`);
  process.exit(failed ? 1 : 0);
})();
