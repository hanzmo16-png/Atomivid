/**
 * Auditoría PÚBLICA de solo lectura de la versión vigente (T-20261024 QA-INTERFAZ, Claude). USD 0.
 * Sin credenciales, sin formularios enviados, sin crear cuentas ni trabajos: solo GET de páginas públicas y comprobación de
 * que las privadas redirigen a login. Dos dispositivos: Samsung 390x844 y escritorio 1440x900. Capturas en $OUT.
 */
const fs = require("node:fs"), path = require("node:path");
const { chromium } = require("playwright");
const BASE = process.env.PUBLIC_BASE ?? "https://atomicvid.app";
const OUT = path.resolve(process.env.OUT ?? "public-out"); fs.mkdirSync(OUT, { recursive: true });
const DEVICES = {
  samsung: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36" },
  desktop: { viewport: { width: 1440, height: 900 } },
};
const PUBLIC = ["/", "/login", "/register"];
const PRIVATE = ["/dashboard", "/dashboard/new", "/dashboard/long-form/new", "/dashboard/podcast"];
const rows = []; let fails = 0;
const rec = (r) => { rows.push(r); if (!r.ok) fails++; console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  ${JSON.stringify(r.detail ?? {}).slice(0, 300)}`); };
(async () => {
  const browser = await chromium.launch();
  for (const [dev, opt] of Object.entries(DEVICES)) {
    const ctx = await browser.newContext({ ...opt, locale: "es-MX" }); const p = await ctx.newPage();
    const posts = []; p.on("request", (q) => { if (q.method() !== "GET" && q.method() !== "HEAD") posts.push(`${q.method()} ${q.url()}`); });
    const consoleErrors = []; p.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
    for (const route of PUBLIC) {
      const t0 = Date.now(); const r = await p.goto(BASE + route, { waitUntil: "networkidle" }).catch((e) => ({ status: () => 0, e }));
      const ms = Date.now() - t0; const o = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })).catch(() => ({}));
      await p.screenshot({ path: path.join(OUT, `${dev}${route.replace(/\//g, "_") || "_root"}.png`), fullPage: true }).catch(() => {});
      rec({ name: `[${dev}] GET ${route}`, ok: r.status() >= 200 && r.status() < 400 && o.sw <= o.iw + 1, detail: { status: r.status(), ms, ...o } });
    }
    for (const route of PRIVATE) {
      await p.goto(BASE + route, { waitUntil: "networkidle" }).catch(() => {});
      rec({ name: `[${dev}] ${route} sin sesión → login, sin datos privados`, ok: /\/login/.test(p.url()), detail: { url: p.url() } });
    }
    rec({ name: `[${dev}] la auditoría no envió ninguna petición de escritura de la app`, ok: posts.filter((x) => x.startsWith("POST " + BASE)).length === 0, detail: { nonGet: posts.slice(0, 5) } });
    fs.writeFileSync(path.join(OUT, `${dev}-console-errors.json`), JSON.stringify(consoleErrors, null, 2));
    await ctx.close();
  }
  const h = await fetch(BASE + "/login", { redirect: "manual" });
  const sec = Object.fromEntries(["strict-transport-security", "x-frame-options", "content-security-policy", "x-content-type-options", "referrer-policy"].map((k) => [k, h.headers.get(k)]));
  rec({ name: "cabeceras de seguridad en /login (HSTS presente)", ok: !!sec["strict-transport-security"], detail: sec });
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ base: BASE, at: new Date().toISOString(), fails, rows }, null, 2));
  console.log(`RESULTADO ${rows.length - fails} PASS / ${fails} FAIL`);
  await browser.close(); process.exit(fails ? 1 : 0);
})();
