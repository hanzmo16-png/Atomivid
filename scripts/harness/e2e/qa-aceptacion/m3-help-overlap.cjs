/**
 * M3-1 — En el teléfono, el botón de ayuda flotante («?», Onboarding.tsx, fixed bottom-5 right-5) tapa la acción principal
 * de las barras fijas inferiores: «Generar video final» (revisión del guion del Reel, la confirmación que lanza la
 * producción) y «Siguiente» (asistente de Podcast). Un toque en el borde derecho del botón abre la ayuda en lugar de actuar.
 * USD 0, 127.0.0.1, mismo arnés que acceptance.cjs. Nunca pulsa «Generar video final» ni «Siguiente»: solo hace hit-test
 * (document.elementFromPoint) en 5 puntos de cada botón. Comprueba además que la ayuda sigue disponible y abre su diálogo.
 * FALLA (exit 1) mientras exista el solape; PASA (exit 0) con la corrección.
 *
 *   E2E_SCRIPT=qa-aceptacion/m3-help-overlap.cjs scripts/harness/e2e/infra/run-e2e.sh m3-help-overlap
 */
const path = require("node:path"), fs = require("node:fs");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const { Client } = require(process.env.HARNESS_PG_MODULE ?? "pg");
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:3100";
const OUT = path.resolve(process.env.E2E_OUT ?? "m3-help-overlap-out"); fs.mkdirSync(OUT, { recursive: true });
const OWNER = { id: "11111111-1111-4111-8111-111111111111", email: "pilot-owner@local.test", password: "local-pass-owner-1" };
const UA = "Mozilla/5.0 (Linux; Android 14; SM-A155M) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const DEVICES = {
  "android-360": { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: UA },
  "android-412": { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625, userAgent: UA },
  // Teléfono en horizontal y tableta pequeña: de 640 a ~765 px la barra fija (max-w-2xl) llega al borde donde flota la ayuda.
  "tablet-640": { viewport: { width: 640, height: 900 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: UA },
  "android-horizontal-740": { viewport: { width: 740, height: 360 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: UA },
  "desktop-1366": { viewport: { width: 1366, height: 768 } },
  "desktop-1440": { viewport: { width: 1440, height: 900 } },
};
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + JSON.stringify(detail ?? null).slice(0, 400)}`); return !!ok; };
const skipTour = (p) => p.getByRole("button", { name: "Omitir" }).click({ timeout: 3000 }).catch(() => {});
async function login(p) {
  await p.goto(`${BASE}/login`); await p.fill("input[name=email]", OWNER.email); await p.fill("input[name=password]", OWNER.password);
  await p.locator("form button[type=submit]").last().click(); await p.waitForURL(/\/dashboard/);
}
/** Qué elemento recibe el toque en 5 puntos del botón (centro, bordes izquierdo/derecho, esquinas derechas). */
const hitTest = (loc) => loc.evaluate((el) => {
  const r = el.getBoundingClientRect(), y = r.top + r.height / 2;
  const pts = [[r.left + r.width / 2, y], [r.left + 6, y], [r.right - 6, y], [r.right - 6, r.top + 6], [r.right - 6, r.bottom - 6]];
  const hits = pts.map(([x, yy]) => { const h = document.elementFromPoint(x, yy); return !h ? "nada" : el.contains(h) ? "self" : `${h.tagName.toLowerCase()}「${(h.getAttribute("aria-label") || h.textContent || "").trim().slice(0, 40)}」`; });
  // <nextjs-portal> es el indicador de `next dev` (esquina inferior izquierda): no existe en producción, se ignora.
  return { rect: [r.left, r.top, r.right, r.bottom].map(Math.round), hits, covered: hits.filter((h) => h !== "self" && !h.startsWith("nextjs-portal")) };
});

(async () => {
  const db = new Client({ connectionString: process.env.HARNESS_PG_URL }); await db.connect();
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME || undefined });
  try {
    // Un Reel en «script_ready» (revisión con la barra «Generar video final»). Si no hay, se crea por la UI con el mock del
    // guion (Material de archivo, 30 s): crear + guion no cobran nada ni renderizan.
    let row = (await db.query("select id from public.video_requests where user_id=$1 and mode='visual' and status='script_ready' order by created_at desc limit 1", [OWNER.id])).rows[0];
    if (!row) {
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } }); const p = await ctx.newPage(); p.setDefaultTimeout(90000);
      await login(p); await skipTour(p); await p.goto(`${BASE}/dashboard/new`); await skipTour(p); await p.getByText("Reel / Short").click();
      const topic = `M3 solape de ayuda ${Date.now()}`;
      await p.fill("#topic", topic); await p.selectOption("#style", { label: "Curiosidades" }).catch(() => {}); await p.getByText("30s", { exact: true }).click().catch(() => {});
      await p.locator("input[name=reel_image_source][value=default]").check().catch(() => {});
      await p.getByRole("button", { name: "Crear solicitud" }).click(); await p.waitForURL(/created=1/); await skipTour(p);
      await p.getByRole("button", { name: "Generar guion" }).first().click(); await p.waitForURL(/\/dashboard\/review\//);
      await p.getByRole("button", { name: "Generar video final" }).waitFor();
      row = (await db.query("select id from public.video_requests where user_id=$1 and topic=$2", [OWNER.id, topic])).rows[0];
      await ctx.close();
    }
    for (const [dev, cfg] of Object.entries(DEVICES)) {
      const ctx = await browser.newContext({ ...cfg, locale: "es-MX" }); const p = await ctx.newPage(); p.setDefaultTimeout(60000);
      await login(p); await skipTour(p);
      for (const [label, url, name] of [["revisión del Reel", `/dashboard/review/${row.id}`, "Generar video final"], ["asistente de Podcast", "/dashboard/podcast", "Siguiente"]]) {
        await p.goto(`${BASE}${url}`); await skipTour(p); await p.waitForLoadState("networkidle").catch(() => {}); await p.waitForTimeout(500);
        const btn = p.getByRole("button", { name, exact: true }).first(); await btn.waitFor();
        await btn.scrollIntoViewIfNeeded(); await p.waitForTimeout(300);
        const h = await hitTest(btn);
        await p.screenshot({ path: path.join(OUT, `${dev}-${label.replace(/\W+/g, "-")}.png`) });
        check(`[${dev}] ${label}: «${name}» recibe el toque en todo su ancho (nada flotante encima)`, h.covered.length === 0, h);
      }
      // La ayuda sigue disponible: visible (tras desplazarse al final si no flota) y abre su diálogo.
      const help = p.getByRole("button", { name: "Ver cómo funciona Atomicvid" });
      await help.scrollIntoViewIfNeeded().catch(() => {});
      const pos = await help.evaluate((el) => getComputedStyle(el).position).catch(() => null);
      await help.click({ timeout: 5000 }).catch(() => {});
      const dialog = await p.getByRole("dialog").first().isVisible({ timeout: 3000 }).catch(() => false);
      check(`[${dev}] la ayuda sigue disponible y abre su diálogo (posición: ${pos})`, dialog, { pos });
      if (!cfg.isMobile) check(`[${dev}] escritorio: la ayuda sigue flotando (position: fixed)`, pos === "fixed", { pos });
      await ctx.close();
    }
  } catch (e) {
    // Una excepción (login, navegación, botón ausente) nunca puede terminar en verde con dispositivos sin medir.
    check("recorrido completo sin excepción", false, String(e).slice(0, 300));
  } finally {
    const s = { pass: checks.filter((c) => c.ok).length, fail: checks.filter((c) => !c.ok).length, checks };
    fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(s, null, 2));
    console.log(`RESULTADO ${s.pass} PASS / ${s.fail} FAIL${s.fail ? " — defecto M3-1 presente" : ""}`);
    await browser.close(); await db.end(); process.exit(s.fail ? 1 : 0);
  }
})();
