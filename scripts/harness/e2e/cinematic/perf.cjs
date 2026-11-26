/**
 * Cinematic UI 1.0 — rendimiento ANTES (producción 890eef5e) vs DESPUÉS (esta rama) del /dashboard autenticado.
 * Mismo arnés local, mismos datos, build de producción en ambos. 3 pasadas por configuración, se informa la mediana.
 *  - Teléfono 390×844: CPU ×4 más lenta y red «4G» simulada (9 Mbps, 150 ms) vía CDP.
 *  - Escritorio 1440×900: sin limitación.
 * Métricas: FCP, LCP, CLS, TBT (suma de tareas largas > 50 ms), bytes transferidos por tipo en los primeros 8 s,
 * memoria JS usada.
 *
 *   PERF_BEFORE=http://127.0.0.1:3301 PERF_AFTER=http://127.0.0.1:3300 E2E_OUT=<dir> node perf.cjs
 */
const fs = require("node:fs"), path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const OUT = path.resolve(process.env.E2E_OUT ?? "perf-out"); fs.mkdirSync(OUT, { recursive: true });
const TARGETS = { antes: process.env.PERF_BEFORE ?? "http://127.0.0.1:3301", despues: process.env.PERF_AFTER ?? "http://127.0.0.1:3300" };
const CONFIGS = {
  "telefono-390x844-cpu4x-4g": { ctx: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, cpu: 4, net: { latency: 150, downloadThroughput: (9e6 / 8), uploadThroughput: (1.5e6 / 8) } },
  "escritorio-1440x900": { ctx: { viewport: { width: 1440, height: 900 } }, cpu: 1, net: null },
};
const RUNS = 3;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function measure(browser, base, cfg) {
  const ctx = await browser.newContext(cfg.ctx);
  const login = await ctx.newPage();
  await login.goto(`${base}/login`); await login.fill("input[name=email]", "pilot-owner@local.test"); await login.fill("input[name=password]", "local-pass-owner-1");
  await Promise.all([login.waitForURL(/\/dashboard/, { timeout: 120000 }), login.click("button[type=submit]")]); await login.close();
  // Sin recorrido de bienvenida (no es parte de la medición): se marca como visto como lo hace la app.
  await ctx.addInitScript(() => { window.__m = { cls: 0, lcp: 0, tbt: 0, fcp: 0 };
    const po = (type, fn) => { try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true }); } catch {} };
    po("layout-shift", (e) => { if (!e.hadRecentInput) window.__m.cls += e.value; });
    po("largest-contentful-paint", (e) => { window.__m.lcp = e.startTime; });
    po("longtask", (e) => { window.__m.tbt += Math.max(0, e.duration - 50); });
    po("paint", (e) => { if (e.name === "first-contentful-paint") window.__m.fcp = e.startTime; }); });
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  await cdp.send("Network.enable"); await cdp.send("Performance.enable");
  // Carga en frío: sin caché del login (peor caso, todo el JS/CSS se descarga).
  await cdp.send("Network.clearBrowserCache"); await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  if (cfg.cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cfg.cpu });
  if (cfg.net) await cdp.send("Network.emulateNetworkConditions", { offline: false, ...cfg.net });
  const bytes = { script: 0, stylesheet: 0, image: 0, media: 0, document: 0, font: 0, other: 0 };
  const types = new Map();
  cdp.on("Network.responseReceived", (e) => types.set(e.requestId, e.type));
  cdp.on("Network.loadingFinished", (e) => { const t = (types.get(e.requestId) || "Other").toLowerCase(); const k = t in bytes ? t : t === "fetch" || t === "xhr" ? "other" : t; bytes[k in bytes ? k : "other"] += e.encodedDataLength; });
  await p.goto(`${base}/dashboard`, { waitUntil: "load", timeout: 180000 });
  await p.waitForTimeout(8000);
  const m = await p.evaluate(() => window.__m);
  const heap = (await cdp.send("Performance.getMetrics")).metrics.find((x) => x.name === "JSHeapUsedSize")?.value ?? 0;
  await ctx.close();
  const total = Object.values(bytes).reduce((a, b) => a + b, 0);
  return { fcp: m.fcp, lcp: m.lcp, cls: m.cls, tbt: m.tbt, kbJS: bytes.script / 1024, kbCSS: bytes.stylesheet / 1024, kbImg: bytes.image / 1024, kbMedia: bytes.media / 1024, kbTotal: total / 1024, heapMB: heap / 1048576 };
}

(async () => {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const report = {};
  for (const [cname, cfg] of Object.entries(CONFIGS)) {
    report[cname] = {};
    for (const [tname, base] of Object.entries(TARGETS)) {
      const runs = []; for (let i = 0; i < RUNS; i++) runs.push(await measure(browser, base, cfg));
      const med = {}; for (const k of Object.keys(runs[0])) med[k] = +median(runs.map((r) => r[k])).toFixed(k === "cls" ? 4 : 1);
      report[cname][tname] = med; console.log(cname, tname, JSON.stringify(med));
    }
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT, "perf.json"), JSON.stringify(report, null, 2));
})().catch((e) => { console.error(e); process.exit(2); });
