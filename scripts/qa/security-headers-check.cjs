/**
 * Regresión de encabezados de seguridad contra un servidor Next en marcha (USD 0, sin escrituras).
 *  1. Cada ruta responde con CSP aplicada (frame-ancestors 'none'), CSP en modo informe, X-Frame-Options DENY, nosniff y
 *     Referrer-Policy.
 *  2. Un sitio ajeno NO puede incrustar la app en un iframe (clickjacking).
 *  3. Las páginas cargan sin NINGUNA violación de la CSP aplicada (las del modo informe se listan, no bloquean).
 * Opcional: SECURITY_LOGIN_EMAIL/SECURITY_LOGIN_PASSWORD (cuenta LOCAL del arnés) recorre también el panel con sesión.
 *
 *   BASE=http://127.0.0.1:3000 OUT=security-out node scripts/qa/security-headers-check.cjs
 */
const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const OUT = path.resolve(process.env.OUT ?? "security-out"); fs.mkdirSync(OUT, { recursive: true });
const PUBLIC = ["/", "/login", "/register"], PRIVATE = ["/dashboard", "/dashboard/new", "/dashboard/podcast", "/dashboard/long-form/new"];
const rows = []; let fails = 0;
const rec = (name, ok, detail) => { rows.push({ name, ok: !!ok, detail }); if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + JSON.stringify(detail ?? null).slice(0, 300)}`); };
(async () => {
  for (const route of [...PUBLIC, "/api/m", "/_next/static/does-not-exist.js"]) {
    const r = await fetch(BASE + route, { redirect: "manual" });
    const h = (k) => r.headers.get(k) ?? "";
    rec(`headers ${route} (${r.status})`, /frame-ancestors 'none'/.test(h("content-security-policy")) && /default-src 'self'/.test(h("content-security-policy-report-only"))
      && h("x-frame-options") === "DENY" && h("x-content-type-options") === "nosniff" && h("referrer-policy") === "strict-origin-when-cross-origin",
      { csp: h("content-security-policy"), xfo: h("x-frame-options"), nosniff: h("x-content-type-options"), ref: h("referrer-policy") });
  }
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME || undefined });
  // 2. Clickjacking: una página de otro origen intenta incrustar /login.
  const evil = http.createServer((q, s) => { s.setHeader("content-type", "text/html"); s.end(`<!doctype html><iframe id=f src="${BASE}/login" width=800 height=600></iframe>`); });
  await new Promise((r) => evil.listen(0, "127.0.0.1", r));
  const port = evil.address().port;
  { const ctx = await browser.newContext(); const p = await ctx.newPage();
    await p.goto(`http://localhost:${port}/`); await p.waitForTimeout(3000);
    const frame = p.frames().find((f) => f !== p.mainFrame());
    const loaded = frame ? await frame.evaluate(() => !!document.querySelector("input[name=email]")).catch(() => false) : false;
    await p.screenshot({ path: path.join(OUT, "iframe-bloqueado.png") });
    rec("un sitio ajeno no puede incrustar /login en un iframe (frame-ancestors 'none' + X-Frame-Options DENY)", !loaded, { frameUrl: frame?.url() });
    await ctx.close(); }
  evil.close();
  // 3. Violaciones de CSP en las páginas.
  for (const [dev, opt] of Object.entries({ samsung: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, desktop: { viewport: { width: 1440, height: 900 } } })) {
    const ctx = await browser.newContext(opt); const p = await ctx.newPage(); const enforced = [], reportOnly = [];
    p.on("console", (m) => { const t = m.text(); if (!/Content Security Policy/i.test(t)) return; (/Report Only|report-only/i.test(t) ? reportOnly : enforced).push(t.slice(0, 220)); });
    const routes = [...PUBLIC];
    if (process.env.SECURITY_LOGIN_EMAIL) {
      await p.goto(`${BASE}/login`); await p.fill("input[name=email]", process.env.SECURITY_LOGIN_EMAIL); await p.fill("input[name=password]", process.env.SECURITY_LOGIN_PASSWORD ?? "");
      await p.locator("form button[type=submit]").last().click(); await p.waitForURL(/\/dashboard/); routes.push(...PRIVATE);
    }
    for (const route of routes) { await p.goto(BASE + route, { waitUntil: "networkidle" }).catch(() => {}); await p.screenshot({ path: path.join(OUT, `${dev}${route.replace(/\//g, "_") || "_root"}.png`) }); }
    rec(`[${dev}] ${routes.length} páginas sin violaciones de la CSP aplicada`, enforced.length === 0, enforced.slice(0, 5));
    fs.writeFileSync(path.join(OUT, `${dev}-csp-report-only.json`), JSON.stringify([...new Set(reportOnly)], null, 2));
    console.log(`INFO  [${dev}] avisos de la CSP en modo informe (no bloquean): ${new Set(reportOnly).size}`);
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ base: BASE, fails, rows }, null, 2));
  console.log(`RESULTADO ${rows.length - fails} PASS / ${fails} FAIL`); process.exit(fails ? 1 : 0);
})();
