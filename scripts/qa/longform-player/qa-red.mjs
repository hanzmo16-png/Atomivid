// Chromium QA for Long Form player continuity. Usage: node qa.mjs <stateDir> <label>
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
import { writeFileSync, readFileSync } from "node:fs";
const [S, LABEL = "run"] = process.argv.slice(2);
const BASE = "http://localhost:3141";
const st = (o) => writeFileSync(S + "/state.json", JSON.stringify({ ...JSON.parse(readFileSync(S + "/state.json", "utf8")), ...o }));
const renders = () => JSON.parse(readFileSync(S + "/state.json", "utf8")).renders;
const res = [];
const ok = (n, c, d = "") => { res.push({ n, pass: !!c, d }); console.log((c ? "PASS " : "FAIL ") + n + (d ? " :: " + d : "")); };
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" }).catch(() => chromium.launch());
const VIEWPORTS = { desktop: { viewport: { width: 1280, height: 800 } }, mobile: { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.6 } };

for (const [vp, opts] of Object.entries(VIEWPORTS)) {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript(() => {
    // Simulated autoplay restriction, armed per test: the NEXT play() call is refused like Chrome's policy does.
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (window.__blockNextPlay) { window.__blockNextPlay = false; return Promise.reject(new DOMException("play() blocked by policy", "NotAllowedError")); }
      return orig.call(this);
    };
  });
  const page = await ctx.newPage();
  const reqs = []; page.on("request", (r) => reqs.push({ m: r.method(), u: r.url(), rsc: r.headers()["rsc"] === "1", t: Date.now() }));
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  const T = (n) => `[${vp}] ${n}`;
  const v = () => page.locator("video");
  const media = () => v().evaluate((el) => ({ src: el.getAttribute("src"), t: el.currentTime, rate: el.playbackRate, paused: el.paused, ended: el.ended, rs: el.readyState }));
  const token = (u) => new URL(u).searchParams.get("token");
  const statusOf = async () => (await page.getByTestId("refresh-status").count()) ? page.getByTestId("refresh-status").getAttribute("data-state") : "idle";
  const waitState = async () => { await page.waitForTimeout(300); await page.waitForFunction(() => !document.querySelector('[data-testid="refresh-links"]')?.disabled, null, { timeout: 30000 }); await page.waitForTimeout(1500); };
  const ready = () => page.waitForFunction(() => { const el = document.querySelector('video'); return el && el.readyState >= 1; }, null, { timeout: 30000 });
  const playTo = async (sec, rate = 1) => {
    await v().evaluate((el, r) => { el.playbackRate = r; return el.play(); }, rate);
    await page.waitForFunction((s) => document.querySelector('video').currentTime >= s, sec, { timeout: 30000 });
  };
  const open = async (q = "v=a&as=u1") => { await page.goto(BASE + "/dev/player-qa?" + q, { waitUntil: "networkidle" }); await ready(); };

  st({ fail: false, failThumb: false, delayMs: 0 });
  await open();

  // 0) No unexpected restarts while simply watching.
  await playTo(2);
  const w0 = await media(); await page.waitForTimeout(2500); const w1 = await media();
  ok(T("sin clic: src estable y reproducción continua"), w0.src === w1.src && w1.t > w0.t && !w1.paused, `${w0.t.toFixed(1)}→${w1.t.toFixed(1)}`);

  // 1) Playing at 1.5x: renew → same object, new token, resumes near the same point at the same speed.
  await playTo(6, 1.5);
  let mark = reqs.length; const r0 = renders();
  const before = await media();
  const thumb0 = await page.locator('img[alt="Miniatura de YouTube"]').getAttribute("src");
  await page.getByTestId("refresh-links").click();
  await waitState("recovered");
  const after = await media();
  const thumb1 = await page.locator('img[alt="Miniatura de YouTube"]').getAttribute("src");
  const dl = await page.getByText("Descargar video").getAttribute("href");
  const dlThumb = await page.getByText("Descargar miniatura").getAttribute("href");
  ok(T("reproduciendo: enlace renovado al mismo objeto"), token(after.src) !== token(before.src) && new URL(after.src).pathname === new URL(before.src).pathname, `${token(before.src)}→${token(after.src)}`);
  ok(T("reproduciendo: posición conservada (no vuelve a 0)"), after.t >= before.t - 0.5 && after.t <= before.t + 6, `antes=${before.t.toFixed(2)} después=${after.t.toFixed(2)}`);
  ok(T("reproduciendo: velocidad 1.5x y sigue reproduciendo"), after.rate === 1.5 && !after.paused, `rate=${after.rate} paused=${after.paused}`);
  ok(T("miniatura y descargas usan los enlaces renovados"), token(thumb1) === token(after.src) && token(thumb1) !== token(thumb0) && token(dl) === token(after.src) && token(dlThumb) === token(after.src));
  ok(T("estado recuperado visible con la posición"), /Continúas en \d+:\d\d/.test((await page.getByTestId("refresh-status").count() ? await page.getByTestId("refresh-status").innerText() : "")));
  ok(T("un solo GET RSC y un solo render del servidor"), reqs.slice(mark).filter((r) => r.rsc).length === 1 && renders() - r0 === 1, `rsc=${reqs.slice(mark).filter((r) => r.rsc).length} renders+${renders() - r0}`);
  await page.screenshot({ path: `${S}/shots/${LABEL}-${vp}-1-recuperado.png`, fullPage: true });

  // 1b) The one-shot listener is gone: a later manual seek is not overridden by a stale restore.
  await v().evaluate((el) => { el.currentTime = 3; });
  await page.waitForTimeout(1200);
  ok(T("limpieza: una búsqueda manual posterior no se sobrescribe"), (await media()).t < 6, `t=${(await media()).t.toFixed(2)}`);

  // 2) Paused at 2x: stays paused at the same position and speed.
  await v().evaluate((el) => { el.pause(); el.playbackRate = 2; el.currentTime = 20; });
  await page.waitForTimeout(400);
  await page.getByTestId("refresh-links").click(); await waitState("recovered");
  const p = await media();
  ok(T("en pausa: sigue en pausa, misma posición y velocidad 2x"), p.paused && Math.abs(p.t - 20) < 0.6 && p.rate === 2, `t=${p.t.toFixed(2)} paused=${p.paused} rate=${p.rate}`);

  // 3) Double click: one refresh.
  await playTo(25, 1);
  mark = reqs.length; const r1 = renders();
  await page.getByTestId("refresh-links").dblclick();
  const busy = await page.getByTestId("refresh-links").isDisabled();
  await waitState("recovered");
  await page.waitForTimeout(800);
  ok(T("doble clic: un solo refresh, botón deshabilitado mientras actualiza"), reqs.slice(mark).filter((r) => r.rsc).length === 1 && renders() - r1 === 1 && busy, `rsc=${reqs.slice(mark).filter((r) => r.rsc).length} renders+${renders() - r1} disabled=${busy}`);
  ok(T("doble clic: reproducción conservada"), !(await media()).paused && (await media()).t >= 24.5);

  // 4) Signing fails: the player keeps playing the current link; recoverable error; retry restores.
  st({ fail: true });
  const f0 = await media();
  await page.getByTestId("refresh-links").click(); await waitState("error");
  const f1 = await media();
  const errText = (await page.getByTestId("refresh-status").count() ? await page.getByTestId("refresh-status").innerText() : "");
  ok(T("firma fallida: el reproductor no se reinicia ni se desmonta"), f1.src === f0.src && !f1.paused && f1.t >= f0.t, `t ${f0.t.toFixed(1)}→${f1.t.toFixed(1)}`);
  ok(T("firma fallida: explica que el video sigue guardado, sin sugerir generar"), /sigue guardado/.test(errText) && /no hace falta volver a producirlo/.test(errText) && !/(genera|generar|Reintentar producción|Iniciar producción)/i.test(errText.replace("volver a producirlo", "")));
  ok(T("firma fallida: botón habilitado para reintentar"), await page.getByTestId("refresh-links").isEnabled());
  await page.screenshot({ path: `${S}/shots/${LABEL}-${vp}-2-error.png`, fullPage: true });
  st({ fail: false });
  const g0 = await media();
  await page.getByTestId("refresh-links").click(); await waitState("recovered");
  const g1 = await media();
  ok(T("reintento tras fallo: nuevo enlace y misma posición"), token(g1.src) !== token(g0.src) && g1.t >= g0.t - 0.5 && !g1.paused, `t ${g0.t.toFixed(1)}→${g1.t.toFixed(1)}`);

  // 5) Browser refuses play(): paused at the saved position + clear "press play" status.
  await page.evaluate(() => { window.__blockNextPlay = true; });
  const b0 = await media();
  await page.getByTestId("refresh-links").click(); await waitState("blocked");
  const b1 = await media();
  ok(T("autoplay bloqueado: en pausa en la posición guardada y lo explica"), b1.paused && Math.abs(b1.t - b0.t) < 1.5 && /pulsa reproducir/.test((await page.getByTestId("refresh-status").count() ? await page.getByTestId("refresh-status").innerText() : "")), `t=${b1.t.toFixed(2)} saved≈${b0.t.toFixed(2)}`);
  await page.screenshot({ path: `${S}/shots/${LABEL}-${vp}-3-bloqueado.png`, fullPage: true });

  // 6) Navigation to another video (another account) DURING the refresh: nothing leaks.
  await open();
  await playTo(10, 1.25);
  st({ delayMs: 2500 });
  await page.getByTestId("refresh-links").click();
  await page.getByTestId("go-b").click();
  await page.waitForURL(/v=b/, { timeout: 30000 }); await ready();
  await page.waitForTimeout(3500); // past the delayed refresh
  st({ delayMs: 0 });
  const n = await media();
  ok(T("navegación durante actualización: el otro video no hereda posición, velocidad ni reproducción"), /\/qa-media\/b\.mp4/.test(n.src) && n.t < 1 && n.rate === 1 && n.paused, `src=${new URL(n.src).pathname} t=${n.t.toFixed(2)} rate=${n.rate} paused=${n.paused}`);
  ok(T("navegación durante actualización: sin estado de actualización arrastrado"), (await statusOf()) === "idle");

  // 7) Account switch: u2 cannot open u1's video (server owner check), and u2's own video starts fresh.
  const e404 = errors.length;
  const resp = await page.goto(BASE + "/dev/player-qa?v=a&as=u2");
  // The deliberate 404 of the owner check logs exactly one "Failed to load resource: 404": expected, not a defect.
  const expected404 = errors.slice(e404).filter((e) => /status of 404/.test(e)).length;
  errors.splice(e404, Math.min(expected404, 1));
  ok(T("otra cuenta: el video ajeno responde 404 (control de propietario del servidor)"), resp.status() === 404, "status=" + resp.status());
  await open("v=b&as=u2");
  const fresh = await media();
  ok(T("otra cuenta: su propio video arranca limpio"), fresh.t < 1 && fresh.rate === 1 && fresh.paused);

  // Global: no production endpoint, no POST, no external traffic, no runtime errors.
  const bad = reqs.filter((r) => /\/api\/generate\/|\/render\b|\/resume\b/.test(new URL(r.u).pathname) || !["GET", "HEAD"].includes(r.m));
  const ext = reqs.filter((r) => !["localhost", "127.0.0.1"].includes(new URL(r.u).hostname));
  ok(T("cero render/resume, cero POST: ningún cobro posible"), bad.length === 0, JSON.stringify(bad.map((r) => r.m + " " + r.u)));
  ok(T("cero tráfico externo"), ext.length === 0, JSON.stringify(ext.map((r) => r.u)));
  ok(T("sin errores de página/consola"), errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  writeFileSync(`${S}/${LABEL}-${vp}-requests.json`, JSON.stringify(reqs.map((r) => r.m + " " + new URL(r.u).pathname + new URL(r.u).search.replace(/token=[^&]+/, "token=…") + (r.rsc ? " [RSC]" : "")), null, 1));
  await ctx.close();
}
writeFileSync(`${S}/${LABEL}-results.json`, JSON.stringify(res, null, 1));
console.log(`${res.filter((r) => r.pass).length}/${res.length} PASS (${LABEL})`);
await browser.close();
