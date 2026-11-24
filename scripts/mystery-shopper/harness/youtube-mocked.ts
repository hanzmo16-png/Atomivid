/**
 * Arnés LOCAL y SIMULADO (MOCKED) de la misión YouTube Studio. NUNCA cuenta como GO: no hay ATOMIVID real, ni Supabase,
 * ni proveedores; un servidor local imita el DOM de las pantallas reales de Long Form (mismas etiquetas, roles y
 * data-testid) y entrega un MP4 generado con ffmpeg. Sirve para ejecutar de punta a punta, con un navegador real, la
 * lógica de la misión: guardia de gasto, libro, seguimiento de progreso, detección de atascos, reproducción, descarga,
 * ffprobe y biblioteca. USD 0.
 *
 * Uso: npx tsx scripts/mystery-shopper/harness/youtube-mocked.ts <dir-salida> [chrome]
 * Escenarios: ok · atasco (barra quieta) · interruptor-apagado · beta-404 · techo-excede
 */
import http from "node:http";
import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { runYoutubeStudio, YT_LIMITS } from "../youtube-mission";
import type { RealCtx } from "../real-missions";
import { ledgerStore, totals } from "../../../src/lib/mystery-shopper/v3/ledger";
import { mediaCheck, type LiveStep } from "../../../src/lib/mystery-shopper/live";
import { measureVideo } from "../av-check";
import type { StorageApi } from "../../../src/lib/mystery-shopper/jobs";

type Scenario = "ok" | "atasco" | "interruptor-apagado" | "beta-404" | "techo-excede";
const OUT = path.resolve(process.argv[2] || "/tmp/ms-yt-mocked");
const CHROME = process.argv[3] || undefined;
const JOB = "6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f", RID = "7a1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
const BANNER = `<div style="background:#b00;color:#fff;padding:6px;font:bold 14px sans-serif">MOCK LOCAL — no es ATOMIVID real · nunca GO</div>`;

function mp4(): string {
  const f = path.join(OUT, "fixture-3min.mp4");
  if (!existsSync(f)) execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=25:duration=180", "-f", "lavfi", "-i", "sine=frequency=330:duration=180", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart", f]);
  return f;
}

function server(sc: Scenario) {
  let scriptPolls = 0, confirmedAt = 0;
  const page = (title: string, body: string, status = 200) => ({ status, html: `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${title}</title></head><body>${BANNER}<main>${body}</main></body></html>` });
  const route = (u: URL, method: string): { status: number; html?: string; redirect?: string; file?: string } => {
    if (u.pathname === "/dashboard/long-form/new") {
      if (sc === "beta-404") return page("404", "<h1>No encontramos esa página</h1>", 404);
      return page("Nuevo", `<h1>Nuevo video de YouTube</h1><form method="post" action="/create">
        <label for="topic">¿De qué trata tu video?</label><input id="topic" name="topic" required>
        <label for="language">Idioma de la narración</label><select id="language" name="language"><option value="es">Español</option><option value="en">Inglés</option></select>
        <label for="duration_minutes">Duración (minutos)</label><input id="duration_minutes" name="duration_minutes" type="number" min="3" max="30">
        <button type="submit">Crear y revisar guion</button><p>Escribir el guion tarda unos minutos y usa créditos del proveedor.</p></form>`);
    }
    if (u.pathname === "/create" && method === "POST") return { status: 303, redirect: `/dashboard?script_job=${JOB}` };
    if (u.pathname === `/dashboard/long-form/jobs/${JOB}`) {
      scriptPolls++;
      const done = scriptPolls >= 3;
      return page("Preparación", `<h1>Preparación del documental</h1><div><span>${done ? "Guion listo" : "Preparando guion"}</span><p>3 min · ${done ? "completado" : `investigando (${scriptPolls})`}</p>
        ${done ? `<a href="/dashboard/long-form/configure/${RID}">Revisar y configurar producción</a>` : ""}</div>`);
    }
    if (u.pathname === `/dashboard/long-form/configure/${RID}`) {
      const techo = sc === "techo-excede" ? "USD 1.95" : "USD 1.20";
      return page("Configurar", `<h1>Configurar producción</h1><fieldset><legend>Estrategia visual</legend>
        <label><input type="radio" name="strategy" value="ai" checked><b>Más imágenes IA</b> <span>subtotal USD 1.60</span></label>
        <label><input type="radio" name="strategy" value="stock"><b>Material de archivo</b> <span>~USD 0.95</span></label></fieldset>
        <label for="reel_voice_picker">Selecciona una voz</label><select id="reel_voice_picker"><option value="v1">Voz profesional (es-LATAM)</option></select>
        <details><summary>Ver plan y costos detallados</summary><dl>
        <div><dt>Duración pedida</dt><dd>3 min 00 s</dd></div><div><dt>Costo estimado de proveedores</dt><dd>USD 0.95</dd></div>
        <div><dt>Límite autorizado por producción</dt><dd>USD 5.00</dd></div><div><dt>Guion ya gastado</dt><dd>USD 0.31</dd></div>
        <div><dt>Techo que se autorizaría</dt><dd>${techo}</dd></div></dl></details>
        <button type="button" onclick="fetch('/confirm',{method:'POST'}).then(()=>location.href='/dashboard/videos/${RID}')">Confirmar y generar video</button>`);
    }
    if (u.pathname === "/confirm" && method === "POST") { confirmedAt = Date.now(); return { status: 200, html: "{}" }; }
    if (u.pathname === `/dashboard/videos/${RID}`) {
      const s = (Date.now() - confirmedAt) / 1000;
      const done = sc === "ok" && s > 6;
      const pct = sc === "atasco" ? 35 : Math.min(95, Math.round(s * 15));
      if (!done) return page("Video", `<h1>${"QA"}</h1><span>Generando</span><p data-testid="long-form-stage">${pct < 40 ? "Narración" : "Montaje"}</p>
        <div role="progressbar" aria-label="Progreso de la producción" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"></div><p>${pct}%</p>`);
      return page("Video", `<h1>QA</h1><span>Listo</span><div data-testid="result-actions"><button type="button" data-testid="play-video" onclick="document.querySelector('video').play()">Reproducir</button>
        <a href="/files/${RID}.mp4" download>Descargar video</a></div><video data-testid="result-video" src="/files/${RID}.mp4" controls preload="metadata" width="640"></video>`);
    }
    if (u.pathname === "/dashboard") return page("Panel", `<h1>¿Qué quieres crear hoy?</h1>${confirmedAt ? `<a href="/dashboard/videos/${RID}">QA Mystery Shopper (video)</a>` : ""}`);
    if (u.pathname === `/files/${RID}.mp4`) return { status: 200, file: mp4() };
    return page("404", "<h1>No encontramos esa página</h1>", 404);
  };
  return http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    req.resume(); req.on("end", () => {
      const r = route(u, req.method ?? "GET");
      if (r.redirect) { res.writeHead(r.status, { Location: r.redirect }); res.end(); return; }
      if (r.file) {
        const buf = readFileSync(r.file); const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
        if (range) { const a = Number(range[1]), b = range[2] ? Number(range[2]) : buf.length - 1; res.writeHead(206, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Range": `bytes ${a}-${b}/${buf.length}`, "Content-Length": b - a + 1 }); res.end(buf.subarray(a, b + 1)); return; }
        res.writeHead(200, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": buf.length }); res.end(buf); return;
      }
      res.writeHead(r.status, { "Content-Type": "text/html; charset=utf-8" }); res.end(r.html);
    });
  });
}

function fsBucket(dir: string): StorageApi {
  mkdirSync(dir, { recursive: true });
  return {
    async list(prefix) { const d = path.join(dir, prefix); return { data: existsSync(d) ? (await import("node:fs")).readdirSync(d).map((name) => ({ name })) : [], error: null }; },
    async download(p) { const f = path.join(dir, p); return existsSync(f) ? { data: new Blob([readFileSync(f)]), error: null } : { data: null, error: { message: "not found", statusCode: 404 } }; },
    async upload(p, body, o) { const f = path.join(dir, p); if (!o.upsert && existsSync(f)) return { error: { message: "The resource already exists", statusCode: 409 } }; mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, String(body)); return { error: null }; },
  };
}

async function runScenario(sc: Scenario, chromium: { launch: (o: object) => Promise<{ newContext: (o: object) => Promise<{ newPage: () => Promise<RealCtx["page"]> }>; close: () => Promise<void> }> }) {
  const out = path.join(OUT, sc); mkdirSync(out, { recursive: true });
  const srv = server(sc); await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await (await browser.newContext({ viewport: { width: 412, height: 915 }, locale: "es-MX", acceptDownloads: true })).newPage();
  const steps: LiveStep[] = [], acts: string[] = [], incidents: RealCtx["incidents"] = [], media: RealCtx["media"] = [], gates: string[] = [], critical: string[] = [];
  let spend = 0, n = 0;
  const ledger = ledgerStore(fsBucket(path.join(out, "ledger-bucket")));
  const ctx: RealCtx = {
    page, jobId: `ms-mocked-${sc}`, baseUrl: base, out, real: true,
    step: async (name, fn) => { const t0 = Date.now(); n++; let r: { state: LiveStep["state"]; detail: string }; try { r = await fn(); } catch (e) { r = { state: "FAIL", detail: e instanceof Error ? e.message.split("\n")[0] : String(e) }; }
      const shot = `${String(n).padStart(2, "0")}.png`; await page.screenshot({ path: path.join(out, shot) }).catch(() => {});
      const s = { n, name, state: r.state, detail: r.detail, screenshot: shot, ms: Date.now() - t0, url: page.url() } as LiveStep; steps.push(s); console.log(`[${sc}] paso ${n} ${name}: ${r.state} — ${r.detail}`); return s; },
    goto: async (p) => { const res = await page.goto(base + p, { waitUntil: "domcontentloaded" }); return { httpStatus: res?.status() ?? null } as never; },
    metrics: async () => ({}) as never, mark: () => {}, cIdx: () => 0, act: (a, d) => { acts.push(`${a}: ${d ?? ""}`); },
    probe: async (file, requested, inLibrary) => { const m = await measureVideo(file); return mediaCheck({ file: path.basename(file), container: m.container, durationSeconds: m.durationSeconds, decodeOk: m.decodeOk, requestedSeconds: requested, meanVolumeDb: m.meanVolumeDb, inLibrary }); },
    media, incidents, setCritical: (x) => { critical.push(x); }, setHumanGate: (x) => { gates.push(x); }, addSpend: (u) => { spend = Math.round((spend + u) * 100) / 100; },
    ledger, killSwitch: () => sc !== "interruptor-apagado", runCapUsd: 2,
  };
  await runYoutubeStudio(ctx, { ...YT_LIMITS, pollMs: 1500, scriptTimeoutMs: 60_000, renderTimeoutMs: sc === "atasco" ? 20_000 : 90_000, stallMs: sc === "atasco" ? 8_000 : 60_000 });
  await browser.close(); srv.close();
  const report = { label: "MOCKED — arnés local simulado, sin ATOMIVID ni proveedores reales; NUNCA cuenta como GO", scenario: sc, steps, incidents: incidents.map((i) => ({ kind: i.kind, severity: i.severity, title: i.title })), media, humanGate: gates, critical, acts, simulatedLedger: totals(await ledger.state()), simulatedSpendUsd: spend, realSpendUsd: 0 };
  writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 1));
  return report;
}

const main = async () => {
  mkdirSync(OUT, { recursive: true }); mp4();
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright"); // playwright no es dependencia de la app
  const all = [];
  for (const sc of ["ok", "atasco", "interruptor-apagado", "beta-404", "techo-excede"] as Scenario[]) all.push(await runScenario(sc, chromium as never));
  const summary = all.map((r) => ({ scenario: r.scenario, steps: r.steps.map((s) => `${s.state} ${s.name}`), incidents: r.incidents.map((i) => `${i.severity} ${i.title}`), simulatedLedger: r.simulatedLedger, realSpendUsd: 0 }));
  writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ label: all[0].label, summary }, null, 1));
  console.log(JSON.stringify(summary, null, 1));
};
main().catch((e) => { console.error(e); process.exit(1); });
