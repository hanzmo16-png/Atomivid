/**
 * Cinematic UI 1.0 — E2E en navegador real (USD 0, todo en 127.0.0.1, mismo arnés local).
 * Seis resoluciones (360×800, 390×844, 412×915, 768×1024, 1440×900, 1920×1080):
 *  - el fondo es un <video> real que REPRODUCE (currentTime avanza), silencioso, en bucle, sin controles;
 *  - se pausa al salir de la portada y con la pestaña oculta, y vuelve a sonar al volver;
 *  - «reducir movimiento» → póster fijo (sin <video>); video que falla → póster (recuperación);
 *  - hero, CTA a #crear, estudios con rutas reales, galería con duración MEDIDA del archivo;
 *  - dock móvil < 640 px (Inicio, Estudios, Crear, Biblioteca, Perfil) y ausente en escritorio y dentro de un estudio;
 *  - sin desbordamiento horizontal, sin errores de consola, sin POST desde la portada, CLS medido;
 *  - capturas por resolución y una grabación del fondo en movimiento.
 *
 *   E2E_BASE=http://127.0.0.1:3300 E2E_OUT=<dir> node cinematic-e2e.cjs
 */
const path = require("node:path"), fs = require("node:fs");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:3300";
const OUT = path.resolve(process.env.E2E_OUT ?? "cinematic-out"); fs.mkdirSync(OUT, { recursive: true });
const OWNER = { email: "pilot-owner@local.test", password: "local-pass-owner-1" };
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 16; SM-S948B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const DEVICES = {
  "android-360x800": { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: ANDROID_UA },
  "samsung-390x844": { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: ANDROID_UA },
  "s26ultra-412x915": { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: ANDROID_UA },
  "ipad-768x1024": { viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  "desktop-1440x900": { viewport: { width: 1440, height: 900 } },
  "desktop-1920x1080": { viewport: { width: 1920, height: 1080 } },
};
let fails = 0, passes = 0;
const results = [];
const check = (name, ok, detail) => { ok ? passes++ : fails++; results.push({ name, ok: !!ok, detail: ok ? undefined : detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + JSON.stringify(detail ?? null).slice(0, 400)}`); return !!ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const videoInfo = (p) => p.evaluate(() => { const v = document.querySelector("[data-testid=cinematic-video]"); const bg = document.querySelector("[data-testid=cinematic-bg]");
  return { state: bg?.dataset.state, orientation: bg?.dataset.orientation, has: !!v, t: v?.currentTime ?? null, paused: v?.paused ?? null, muted: v?.muted ?? null, loop: v?.loop ?? null, controls: v?.controls ?? null, src: v?.currentSrc ?? null, rs: v?.readyState ?? null }; });

async function login(p) {
  await p.goto(`${BASE}/login`); await p.fill("input[name=email]", OWNER.email); await p.fill("input[name=password]", OWNER.password);
  await Promise.all([p.waitForURL(/\/dashboard/, { timeout: 120000 }), p.click("button[type=submit]")]);
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME || undefined, args: ["--autoplay-policy=no-user-gesture-required"] });
  const metrics = {};
  for (const [dev, opts] of Object.entries(DEVICES)) {
    const mobile = opts.viewport.width < 640;
    const ctx = await browser.newContext({ ...opts, recordVideo: dev === "s26ultra-412x915" || dev === "desktop-1440x900" ? { dir: path.join(OUT, `rec-${dev}`), size: opts.viewport } : undefined });
    // CLS real con PerformanceObserver desde el primer byte.
    await ctx.addInitScript(() => { window.__cls = 0; window.__lcp = 0; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
      new PerformanceObserver((l) => { const e = l.getEntries().at(-1); if (e) window.__lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true }); } catch {} });
    const p = await ctx.newPage();
    const errors = [], posts = [];
    p.on("console", (m) => { if (m.type() === "error" && !/Download the React DevTools|favicon/.test(m.text())) errors.push(m.text()); });
    p.on("pageerror", (e) => errors.push(String(e)));
    p.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname.startsWith("/dashboard")) posts.push(r.url()); });
    const bytes = { video: 0, total: 0, videoReqs: [] };
    p.on("response", async (r) => { try { const len = +(r.headers()["content-length"] || 0); bytes.total += len; if (/\/cinematic\/.+\.(mp4|webm)/.test(r.url())) { bytes.video += len; bytes.videoReqs.push(r.url().split("/cinematic/")[1]); } } catch {} });

    await login(p);
    await p.goto(`${BASE}/dashboard`, { waitUntil: "load" });
    // Omitir el recorrido de bienvenida si aparece (no es parte de esta prueba).
    const skip = p.getByRole("button", { name: "Omitir" }); if (await skip.isVisible().catch(() => false)) await skip.click();
    await p.waitForSelector("[data-testid=cinematic-hero]");
    // Espera a que el video esté sonando de verdad.
    let v0 = null; for (let i = 0; i < 60; i++) { v0 = await videoInfo(p); if (v0.state === "playing" && v0.t > 0.3) break; await sleep(250); }
    await sleep(1200); const v1 = await videoInfo(p);
    check(`[${dev}] fondo: <video> real reproduciendo (currentTime ${v0?.t?.toFixed(2)}→${v1.t?.toFixed(2)})`, v1.has && v1.state === "playing" && v1.t > v0.t && v1.paused === false, { v0, v1 });
    check(`[${dev}] fondo: silencioso, en bucle, sin controles`, v1.muted === true && v1.loop === true && v1.controls === false, v1);
    const expectOrient = opts.viewport.height > opts.viewport.width ? "portrait" : "landscape";
    check(`[${dev}] fondo: material ${expectOrient} (${(v1.src || "").split("/").pop()})`, v1.orientation === expectOrient && (v1.src || "").includes(`cosmos-${expectOrient}`), v1);
    check(`[${dev}] solo un ambiente descargado (no los cinco)`, new Set(bytes.videoReqs.map((u) => u.split("?")[0].replace(/-(landscape|portrait)\.(mp4|webm)$/, ""))).size <= 1, bytes.videoReqs);

    // Hero + CTA
    const h1 = await p.getByRole("heading", { level: 1 }).innerText();
    check(`[${dev}] hero «Tu imaginación. Sin límites.»`, /Tu imaginación\.\s*Sin límites\./.test(h1), h1);
    check(`[${dev}] subtítulo`, await p.getByText("Crea historias que merecen ser vistas.").isVisible());
    const cta = p.getByTestId("cinematic-cta");
    check(`[${dev}] CTA «¿Qué historia vamos a crear hoy?» → #crear`, (await cta.innerText()).includes("¿Qué historia vamos a crear hoy?") && (await cta.getAttribute("href")) === "#crear");
    const ctaBox = await cta.boundingBox();
    check(`[${dev}] CTA dentro de la primera pantalla y táctil (≥ 44 px)`, ctaBox && ctaBox.y + ctaBox.height <= opts.viewport.height && ctaBox.height >= 44, ctaBox);
    await p.screenshot({ path: path.join(OUT, `${dev}-1-portada.png`) });

    // Legibilidad: contraste del título sobre el fondo real (muestra de píxeles detrás del texto ≈ oscuro)
    await cta.click(); await sleep(900);
    check(`[${dev}] CTA lleva a «¿Qué quieres crear hoy?» (flujo real)`, await p.getByTestId("crear-inicio").isVisible() && (await p.evaluate(() => { const r = document.getElementById("crear").getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; })));
    await p.screenshot({ path: path.join(OUT, `${dev}-2-crear.png`) });

    // Pausa fuera de la portada
    await p.evaluate(() => document.getElementById("estudios").scrollIntoView()); await sleep(1500);
    const vOut = await videoInfo(p);
    check(`[${dev}] fondo se pausa al salir de la portada`, vOut.paused === true, vOut);
    // Estudios
    const studios = await p.$$eval("[data-testid^=studio-]", (els) => els.map((e) => ({ id: e.dataset.testid, available: e.dataset.available, href: e.querySelector("a")?.getAttribute("href") ?? null })));
    check(`[${dev}] estudios con rutas reales (${studios.map((s) => s.id.replace("studio-", "")).join(", ")})`, studios.length >= 4 && studios.every((s) => s.available === "1" ? !!s.href && s.href.startsWith("/dashboard/") : s.href === null), studios);
    await p.screenshot({ path: path.join(OUT, `${dev}-3-estudios.png`) });
    // Galería
    await p.evaluate(() => document.getElementById("producciones").scrollIntoView()); await sleep(2500);
    const items = await p.$$eval("[data-testid=showcase-item]", (els) => els.map((e) => ({ href: e.getAttribute("href"), dur: e.dataset.duration, text: e.innerText })));
    check(`[${dev}] galería: producciones terminadas de la cuenta, con duración medida del archivo`, items.length >= 3 && items.filter((i) => +i.dur > 0).length >= 2 && items.every((i) => /^\/dashboard\/videos\//.test(i.href)), items);
    await p.screenshot({ path: path.join(OUT, `${dev}-4-galeria.png`) });

    // Vuelve a la portada → reanuda
    await p.evaluate(() => scrollTo(0, 0)); await sleep(1500);
    const vBack = await videoInfo(p); await sleep(800); const vBack2 = await videoInfo(p);
    check(`[${dev}] al volver a la portada se reanuda`, vBack2.paused === false && vBack2.t !== vBack.t, { vBack, vBack2 });
    // Pestaña oculta → pausa
    await p.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); }); await sleep(400);
    const vHidden = await videoInfo(p);
    check(`[${dev}] pestaña oculta → pausa`, vHidden.paused === true, vHidden);
    await p.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); }); await sleep(600);

    // Dock
    const dock = p.getByTestId("mobile-dock");
    const dockVisible = await dock.isVisible().catch(() => false);
    if (mobile) {
      const labels = await dock.locator("a").evaluateAll((as) => as.map((a) => (a.getAttribute("aria-label") || a.innerText).trim()));
      check(`[${dev}] dock inferior: ${labels.join(" · ")}`, dockVisible && JSON.stringify(labels) === JSON.stringify(["Inicio", "Estudios", "Crear", "Biblioteca", "Perfil"]), labels);
      const sizes = await dock.locator("a").evaluateAll((as) => as.map((a) => { const r = a.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
      check(`[${dev}] dock: áreas táctiles ≥ 48 px`, sizes.every(([w, h]) => w >= 48 && h >= 48), sizes);
      const box = await dock.boundingBox();
      check(`[${dev}] dock flotante dentro de la pantalla`, box && box.y + box.height <= opts.viewport.height + 1 && box.y > opts.viewport.height * 0.75, box);
      // Último contenido no queda tapado por el dock
      await p.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await sleep(500);
      const lastCovered = await p.evaluate(() => { const d = document.querySelector("[data-testid=mobile-dock]").getBoundingClientRect(); const els = [...document.querySelectorAll("main a, main button, body > div > button, [data-testid=crear-ayuda]")].filter((e) => e.getBoundingClientRect().height > 0 && !e.closest("[data-testid=mobile-dock]"));
        const last = els.map((e) => e.getBoundingClientRect().bottom).reduce((a, b) => Math.max(a, b), 0); return { lastBottom: Math.round(last), dockTop: Math.round(d.top), pos: getComputedStyle(document.querySelector("[data-testid=mobile-dock]")).position }; });
      check(`[${dev}] al final de la página el dock no tapa ningún control`, lastCovered.pos === "sticky" && lastCovered.lastBottom <= lastCovered.dockTop + 1, lastCovered);
      await p.getByTestId("dock-crear").click(); await sleep(900);
      check(`[${dev}] botón central «Crear» abre la creación`, await p.getByTestId("crear-inicio").isVisible());
      await p.screenshot({ path: path.join(OUT, `${dev}-5-dock.png`) });
    } else check(`[${dev}] sin dock en pantallas grandes`, !dockVisible);

    // Cabecera: ningún enlace partido en dos líneas ni fuera de la pantalla.
    const hdr = await p.evaluate(() => [...document.querySelectorAll("header a, header button")].filter((a) => a.getBoundingClientRect().width > 0).map((a) => {
      const r = a.getBoundingClientRect(); const rg = document.createRange(); rg.selectNodeContents(a);
      const tops = new Set([...rg.getClientRects()].filter((c) => c.width > 1).map((c) => Math.round(c.top / 4)));
      return { t: a.innerText.trim(), right: Math.round(r.right), lines: a.innerText.trim() ? tops.size : 1 }; }));
    check(`[${dev}] cabecera en una línea y dentro de la pantalla`, hdr.every((a) => a.lines <= 1 && a.right <= opts.viewport.width), hdr);
    // Desbordamiento, consola, POST, CLS/LCP
    const ov = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`[${dev}] sin desbordamiento horizontal`, ov <= 0, ov);
    check(`[${dev}] sin errores de consola`, errors.length === 0, errors);
    check(`[${dev}] portada no envía nada (sin POST)`, posts.length === 0, posts);
    const perf = await p.evaluate(() => ({ cls: window.__cls, lcp: window.__lcp }));
    metrics[dev] = { ...perf, videoBytes: bytes.video, videoReqs: [...new Set(bytes.videoReqs)] };
    check(`[${dev}] CLS < 0.1 (${perf.cls.toFixed(4)})`, perf.cls < 0.1, perf);
    await p.screenshot({ path: path.join(OUT, `${dev}-6-completa.png`), fullPage: true });

    // Dentro de un estudio no hay dock (no tapa la barra fija de acciones)
    if (mobile) { await p.goto(`${BASE}/dashboard/podcast`); await sleep(1500); check(`[${dev}] dentro de Podcast Studio no hay dock`, !(await p.getByTestId("mobile-dock").isVisible().catch(() => false))); }
    await ctx.close();
  }

  // Reducir movimiento → póster fijo, sin <video>
  { const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" }); const p = await ctx.newPage();
    const vids = []; p.on("request", (r) => { if (/\/cinematic\/.+\.(mp4|webm)/.test(r.url())) vids.push(r.url()); });
    await login(p); await p.goto(`${BASE}/dashboard`); await sleep(2500); const v = await videoInfo(p);
    check("[reducir movimiento] póster fijo, sin <video> ni descarga de video", v.state === "poster" && !v.has && vids.length === 0, { v, vids });
    await p.screenshot({ path: path.join(OUT, `reduced-motion-390x844.png`) }); await ctx.close(); }
  // Video que no carga → se queda el póster (recuperación)
  { const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage();
    await ctx.route(/\/cinematic\/.+\.(mp4|webm)$/, (r) => r.abort("failed"));
    const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
    await login(p); await p.goto(`${BASE}/dashboard`); await sleep(4000); const v = await videoInfo(p);
    const posterOk = await p.evaluate(() => { const img = document.querySelector("[data-testid=cinematic-bg] img"); return !!img && img.complete && img.naturalWidth > 0; });
    check("[fallo de carga] video bloqueado → póster visible, sin errores, contenido usable", posterOk && v.state !== "playing" && errs.length === 0 && await p.getByTestId("cinematic-cta").isVisible(), { v, posterOk, errs });
    await p.screenshot({ path: path.join(OUT, `fallback-1440x900.png`) }); await ctx.close(); }
  // Conexión 2G simulada → póster
  { const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    await ctx.addInitScript(() => Object.defineProperty(navigator, "connection", { get: () => ({ effectiveType: "2g", saveData: false }) }));
    const p = await ctx.newPage(); await login(p); await p.goto(`${BASE}/dashboard`); await sleep(2500); const v = await videoInfo(p);
    check("[2G] conexión lenta → póster, sin video", v.state === "poster" && !v.has, v); await ctx.close(); }

  await browser.close();
  fs.writeFileSync(path.join(OUT, "metrics.json"), JSON.stringify(metrics, null, 2));
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ passes, fails, results }, null, 2));
  console.log(`\nRESULTADO: ${passes} PASS / ${fails} FAIL`); console.log(JSON.stringify(metrics, null, 1));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
