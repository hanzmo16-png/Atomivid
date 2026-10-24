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
  // Ningún host externo se resuelve (ni siquiera conexiones especulativas del navegador): solo 127.0.0.1/localhost.
  // Los escenarios con hosts externos se sirven con stubs locales (ctx.route) antes de cualquier resolución.
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME || undefined, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE 127.0.0.2, EXCLUDE localhost"] });
  // (Sin proxy: Chromium no resuelve ningún nombre externo; el runner de CI no define proxy de entorno.)
  // 2. Clickjacking: una página de otro origen intenta incrustar /login.
  const evil = http.createServer((q, s) => { s.setHeader("content-type", "text/html"); s.end(`<!doctype html><iframe id=f src="${BASE}/login" width=800 height=600></iframe>`); });
  await new Promise((r) => evil.listen(0, "127.0.0.2", r));
  const port = evil.address().port;
  { const ctx = await browser.newContext(); const p = await ctx.newPage();
    await p.goto(`http://127.0.0.2:${port}/`); await p.waitForTimeout(3000);
    const frame = p.frames().find((f) => f !== p.mainFrame());
    const loaded = frame ? await frame.evaluate(() => !!document.querySelector("input[name=email]")).catch(() => false) : false;
    await p.screenshot({ path: path.join(OUT, "iframe-bloqueado.png") });
    rec("un sitio ajeno no puede incrustar /login en un iframe (frame-ancestors 'none' + X-Frame-Options DENY)", !loaded, { frameUrl: frame?.url() });
    await ctx.close(); }
  evil.close();
  // 3. Violaciones de CSP en las páginas.
  for (const [dev, opt] of Object.entries({ samsung: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, desktop: { viewport: { width: 1440, height: 900 } } })) {
    const ctx = await browser.newContext(opt); const p = await ctx.newPage(); const enforced = [], reportOnly = [];
    p.on("console", (m) => { const t = m.text(); if (!/Content Security Policy/i.test(t)) return; (/report-only/i.test(t) ? reportOnly : enforced).push(t.slice(0, 220)); });
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
  // 4. Funciones reales frente a la política: cada escenario LEGÍTIMO debe dar 0 violaciones (ni aplicadas ni de informe:
  //    así se evitan falsos positivos y la política puede endurecerse sin romperlas); los CONTROLES NEGATIVOS deben dar la
  //    violación esperada (prueba de que el detector funciona). Todo host externo se intercepta con un stub local: nada
  //    sale del runner, Stripe y Sentry son simulados. Se ejecuta sobre (a) el servidor Next real y (b) una página servida
  //    con las cabeceras calculadas para la forma de PRODUCCIÓN (Supabase https, DSN de Sentry), si PROD_HEADERS_JSON existe.
  const targets = [{ name: "next-local", base: BASE, supabase: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321", sentry: "https://o4500000000000000.ingest.us.sentry.io" }];
  let prodSrv = null;
  if (process.env.PROD_HEADERS_JSON) {
    const hdrs = JSON.parse(process.env.PROD_HEADERS_JSON);
    prodSrv = http.createServer((q, s) => {
      for (const h of hdrs) s.setHeader(h.key, h.value);
      if (q.url.startsWith("/probe/stripe-checkout")) { s.statusCode = 303; s.setHeader("location", "https://checkout.stripe.com/c/pay/cs_test_simulado"); return s.end(); }
      if (q.url.startsWith("/probe/stripe-portal")) { s.statusCode = 303; s.setHeader("location", "https://billing.stripe.com/p/session/test_simulado"); return s.end(); }
      if (q.url.startsWith("/probe/evil")) { s.statusCode = 303; s.setHeader("location", "https://evil.example/collect"); return s.end(); }
      s.setHeader("content-type", "text/html"); s.end("<!doctype html><title>csp</title><body>csp</body>");
    });
    await new Promise((r) => prodSrv.listen(0, "127.0.0.1", r));
    targets.push({ name: "forma-produccion", base: `http://127.0.0.1:${prodSrv.address().port}`, supabase: process.env.PROD_SUPABASE_URL, sentry: process.env.PROD_SENTRY_ORIGIN, page: "/", stripe: true });
  }
  const scenarioRows = [];
  for (const t of targets) for (const [dev, opt] of Object.entries({ samsung: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, desktop: { viewport: { width: 1440, height: 900 } } })) {
    const ctx = await browser.newContext(opt);
    const stub = (body, type = "text/plain") => (r) => r.fulfill({ status: 200, contentType: type, body, headers: { "access-control-allow-origin": "*" } });
    await ctx.route(/^https:\/\/([a-z0-9-]+\.)*(supabase\.co|sentry\.io|stripe\.com|google\.com|evil\.example)\//, stub("stub local"));
    const run = async (name, expect, fn) => {
      const p = await ctx.newPage(); const console_ = [];
      p.on("console", (m) => { const x = m.text(); if (/Content Security Policy/i.test(x)) console_.push({ report: /report-only/i.test(x), text: x.slice(0, 240) }); });
      await p.goto(t.base + (t.page ?? "/login"), { waitUntil: "domcontentloaded" });
      await p.evaluate(() => { window.__v = []; document.addEventListener("securitypolicyviolation", (e) => window.__v.push({ d: e.effectiveDirective, disp: e.disposition, uri: e.blockedURI })); });
      let after = null; try { after = await fn(p); } catch (e) { after = { err: String(e).slice(0, 160) }; }
      await p.waitForTimeout(1200);
      const ev = await p.evaluate(() => window.__v ?? []).catch(() => []);
      // El evento securitypolicyviolation da la disposición exacta; la consola cubre los casos en que la página navega
      // (formularios) y el evento se pierde con el documento.
      const enforced = Math.max(ev.filter((v) => v.disp === "enforce").length, console_.filter((x) => !x.report).length);
      const report = Math.max(ev.filter((v) => v.disp === "report").length, console_.filter((x) => x.report).length);
      const ok = expect === "clean" ? enforced === 0 && report === 0 : expect === "report" ? report > 0 && enforced === 0 : enforced > 0;
      scenarioRows.push({ target: t.name, dev, name, expect, enforced, report, after, ok });
      rec(`[${t.name}/${dev}] ${expect === "clean" ? "función permitida" : "control negativo (" + expect + ")"}: ${name}`, ok, { enforced, report, ev: ev.slice(0, 3), console: console_.slice(0, 2), after });
      await p.close();
    };
    const SB = t.supabase, WS = SB.replace(/^http/, "ws");
    await run("login: Supabase Auth (fetch https)", "clean", (p) => p.evaluate((u) => fetch(`${u}/auth/v1/token?grant_type=password`, { method: "POST", body: "{}" }).then(() => "ok", (e) => String(e)), SB));
    await run("Supabase Realtime (WebSocket)", "clean", (p) => p.evaluate((u) => { try { const w = new WebSocket(`${u}/realtime/v1/websocket?apikey=x&vsn=1.0.0`); setTimeout(() => w.close(), 500); return "ok"; } catch (e) { return String(e); } }, WS));
    await run("Storage firmado: imagen", "clean", (p) => p.evaluate((u) => { const i = new Image(); i.src = `${u}/storage/v1/object/sign/videos/u/thumb.png?token=t`; document.body.append(i); return "ok"; }, SB));
    await run("Storage firmado: video <video>", "clean", (p) => p.evaluate((u) => { const v = document.createElement("video"); v.src = `${u}/storage/v1/object/sign/videos/u/final.mp4?token=t`; v.muted = true; document.body.append(v); v.load(); return "ok"; }, SB));
    await run("Storage firmado: subida PUT (grabación del navegador)", "clean", (p) => p.evaluate((u) => fetch(`${u}/storage/v1/object/upload/sign/videos/u/rec.wav?token=t`, { method: "PUT", body: new Blob(["x"]) }).then(() => "ok", (e) => String(e)), SB));
    await run("vista previa local (blob: en <video> e <img>)", "clean", (p) => p.evaluate(() => { const b = URL.createObjectURL(new Blob(["x"], { type: "video/mp4" })); const v = document.createElement("video"); v.src = b; document.body.append(v); const i = new Image(); i.src = URL.createObjectURL(new Blob(["x"], { type: "image/png" })); document.body.append(i); return "ok"; }));
    await run("Sentry: envío de evento (simulado)", "clean", (p) => p.evaluate((u) => fetch(`${u}/api/1/envelope/`, { method: "POST", body: "{}" }).then(() => "ok", (e) => String(e)), t.sentry));
    await run("API propia (/api/m)", "clean", (p) => p.evaluate(() => fetch("/api/m", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.status, (e) => String(e))));
    if (t.stripe) {
      for (const [k, host] of [["stripe-checkout", "checkout.stripe.com"], ["stripe-portal", "billing.stripe.com"]]) {
        await run(`Stripe simulado: formulario → 303 → ${host}`, "clean", async (p) => {
          const [pop] = await Promise.all([p.waitForEvent("popup", { timeout: 8000 }), p.evaluate((a) => { const f = document.createElement("form"); f.method = "POST"; f.action = a; f.target = "_blank"; document.body.append(f); f.submit(); }, `/probe/${k}`)]);
          await pop.waitForURL(new RegExp(host.replace(/\./g, "\\.")), { timeout: 8000 }).catch(() => {}); const h = new URL(pop.url()).host; await pop.close(); return h;
        });
      }
      await run("control: formulario → 303 → origen no permitido (form-action en redirección, informe)", "report", async (p) => {
        p.evaluate(() => { const f = document.createElement("form"); f.method = "POST"; f.action = "/probe/evil"; f.target = "_blank"; document.body.append(f); f.submit(); }).catch(() => {}); await p.waitForTimeout(2000); return p.url();
      });
      await run("Stripe simulado: formulario directo a checkout.stripe.com", "clean", async (p) => {
        const [pop] = await Promise.all([p.waitForEvent("popup", { timeout: 8000 }), p.evaluate(() => { const f = document.createElement("form"); f.method = "POST"; f.action = "https://checkout.stripe.com/c/pay/cs_test_simulado"; f.target = "_blank"; document.body.append(f); f.submit(); })]);
        await pop.waitForURL(/checkout\.stripe\.com/, { timeout: 8000 }).catch(() => {}); const h = new URL(pop.url()).host; await pop.close(); return h;
      });
      await run("control: formulario directo a origen no permitido (form-action, informe)", "report", async (p) => {
        // target=_blank: el documento de origen sigue vivo y su evento de violación no se pierde con la navegación.
        p.evaluate(() => { const f = document.createElement("form"); f.method = "POST"; f.action = "https://evil.example/collect"; f.target = "_blank"; document.body.append(f); f.submit(); }).catch(() => {}); await p.waitForTimeout(1500); return p.url();
      });
    }
    await run("control: conexión a origen no permitido (connect-src, informe)", "report", (p) => p.evaluate(() => fetch("https://evil.example/x").then(() => "ok", (e) => String(e))));
    await run("control: <object> (object-src 'none', aplicada)", "enforce", (p) => p.evaluate(() => { const o = document.createElement("object"); o.data = "/x.pdf"; document.body.append(o); return "ok"; }));
    await run("control: <base> ajeno (base-uri 'self', aplicada)", "enforce", (p) => p.evaluate(() => { const b = document.createElement("base"); b.href = "https://evil.example/"; document.head.append(b); return "ok"; }));
    await ctx.close();
  }
  prodSrv?.close();
  fs.writeFileSync(path.join(OUT, "csp-scenarios.json"), JSON.stringify(scenarioRows, null, 2));
  await browser.close();
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ base: BASE, fails, rows }, null, 2));
  console.log(`RESULTADO ${rows.length - fails} PASS / ${fails} FAIL`); process.exit(fails ? 1 : 0);
})().catch((e) => { console.log(`FAIL  excepción no controlada: ${String(e?.stack ?? e).slice(0, 600).replace(/\n/g, " | ")}`); process.exit(1); });
process.on("unhandledRejection", (e) => { console.log(`FAIL  promesa rechazada sin control: ${String(e?.stack ?? e).slice(0, 600).replace(/\n/g, " | ")}`); process.exit(1); });
