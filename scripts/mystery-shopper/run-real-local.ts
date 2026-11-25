/**
 * Ejecución REAL de una misión 3.0 desde una máquina de operador (sin Actions): navegador real (MS_CHROME), cuenta QA
 * leída de archivos (nunca de argumentos), libro de gasto en una carpeta local (mismas reglas: reserva atómica, tope
 * acumulado USD 8.50, por módulo y por ejecución). Gasta dinero SOLO si MYSTERY_SHOPPER_REAL_ENABLED=1.
 *
 * Uso: MYSTERY_SHOPPER_REAL_ENABLED=1 MS_RUN_CAP_USD=2 MS_CHROME=/usr/bin/google-chrome \
 *      MS_QA_EMAIL_FILE=... MS_QA_PASSWORD_FILE=... MS_LEDGER_DIR=... \
 *      npx tsx scripts/mystery-shopper/run-real-local.ts <youtube-real|audio-real-es|audio-real-en> <dir-salida> [url]
 */
import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { runYoutubeStudio } from "./youtube-mission";
import { AUDIO_VARIANTS, runAudioReal, type RealCtx } from "./real-missions";
import { ledgerStore, totals } from "../../src/lib/mystery-shopper/v3/ledger";
import { mediaCheck, type LiveStep } from "../../src/lib/mystery-shopper/live";
import { measureVideo } from "./av-check";
import type { StorageApi } from "../../src/lib/mystery-shopper/jobs";

const [mission, outArg, urlArg] = process.argv.slice(2);
const env = process.env;
const BASE = (urlArg || "https://atomicvid.app").replace(/\/$/, "");
const OUT = path.resolve(outArg || "/tmp/ms-real");

function fsBucket(dir: string): StorageApi {
  mkdirSync(dir, { recursive: true });
  return {
    async list(prefix) { const d = path.join(dir, prefix); return { data: existsSync(d) ? readdirSync(d).map((name) => ({ name })) : [], error: null }; },
    async download(p) { const f = path.join(dir, p); return existsSync(f) ? { data: new Blob([readFileSync(f)]), error: null } : { data: null, error: { message: "not found", statusCode: 404 } }; },
    async upload(p, body, o) { const f = path.join(dir, p); if (!o.upsert && existsSync(f)) return { error: { message: "The resource already exists", statusCode: 409 } }; mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, String(body), { flag: o.upsert ? "w" : "wx" }); return { error: null }; },
  };
}

async function main() {
  if (!mission || !["youtube-real", ...Object.keys(AUDIO_VARIANTS)].includes(mission)) throw new Error(`Misión no válida: ${mission}`);
  const email = readFileSync(env.MS_QA_EMAIL_FILE!, "utf8").trim(), password = readFileSync(env.MS_QA_PASSWORD_FILE!, "utf8").trim();
  const redact = (s: string) => s.split(password).join("[REDACTADO]").split(email).join("[QA]");
  mkdirSync(OUT, { recursive: true });
  const real = env.MYSTERY_SHOPPER_REAL_ENABLED === "1";
  const runCap = Number(env.MS_RUN_CAP_USD || 0);
  const jobId = `ms-local-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${mission}`;
  const { chromium } = await import(env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, executablePath: env.MS_CHROME || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "es-MX", acceptDownloads: true });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("pageerror", (e: Error) => consoleErrors.push(redact(e.message).slice(0, 300)));
  const log: string[] = []; const act = (a: string, d = "") => { const l = `${new Date().toISOString()} ${a}: ${redact(d)}`; log.push(l); console.log(l); };
  const dismiss = async () => { const skip = page.getByRole("button", { name: "Omitir" }).first(); if (await skip.isVisible().catch(() => false)) { await skip.click().catch(() => {}); act("overlay", "recorrido de bienvenida omitido"); } };
  // Login real
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Correo electrónico").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await page.waitForURL((u: URL) => /^\/dashboard(\/|$)/.test(u.pathname) || u.searchParams.has("error"), { timeout: 30_000 });
  if (!/^\/dashboard/.test(new URL(page.url()).pathname)) throw new Error(`Login falló: ${new URL(page.url()).searchParams.get("error")}`);
  act("login", "ok"); await dismiss();
  const steps: LiveStep[] = []; const incidents: RealCtx["incidents"] = []; const media: RealCtx["media"] = []; const gates: string[] = []; const critical: string[] = [];
  let spend = 0, n = 0;
  const ledger = ledgerStore(fsBucket(env.MS_LEDGER_DIR || path.join(OUT, "ledger-bucket")));
  const ctx: RealCtx = {
    page, jobId, baseUrl: BASE, out: OUT, real,
    step: async (name, fn) => { const t0 = Date.now(); n++; let r: { state: LiveStep["state"]; detail: string };
      try { r = await fn(); } catch (e) { r = { state: "FAIL", detail: e instanceof Error ? e.message.split("\n")[0] : String(e) }; }
      const shot = `${String(n).padStart(2, "0")}.png`; await page.screenshot({ path: path.join(OUT, shot), fullPage: true }).catch(() => {});
      const s = { n, name, state: r.state, detail: redact(r.detail), screenshot: shot, ms: Date.now() - t0, url: page.url() } as LiveStep; steps.push(s); act(`paso ${n}`, `${name}: ${r.state} — ${s.detail}`);
      writeFileSync(path.join(OUT, "steps.json"), JSON.stringify(steps, null, 1)); return s; },
    goto: async (p) => { const t0 = Date.now(); const res = await page.goto(BASE + p, { waitUntil: "domcontentloaded", timeout: 60_000 }); await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {}); await dismiss(); return { httpStatus: res?.status() ?? null, loadMs: Date.now() - t0 } as never; },
    metrics: async () => ({}) as never, mark: (i, met, ev) => act("criterio", `${i} ${met ? "cumple" : "NO cumple"} — ${ev}`), cIdx: () => -1, act,
    probe: async (file, requested, inLibrary) => { const m = await measureVideo(file, { ffprobe: env.MS_FFPROBE, ffmpeg: env.MS_FFMPEG }); return mediaCheck({ file: path.basename(file), container: m.container, durationSeconds: m.durationSeconds, decodeOk: m.decodeOk, requestedSeconds: requested, meanVolumeDb: m.meanVolumeDb, inLibrary }); },
    media, incidents, setCritical: (x) => { critical.push(redact(x)); }, setHumanGate: (x) => { gates.push(redact(x)); }, addSpend: (u) => { spend = Math.round((spend + u) * 100) / 100; },
    ledger, killSwitch: () => process.env.MYSTERY_SHOPPER_REAL_ENABLED === "1", runCapUsd: runCap, ffprobe: env.MS_FFPROBE, ffmpeg: env.MS_FFMPEG,
  };
  try {
    if (mission === "youtube-real") await runYoutubeStudio(ctx); else await runAudioReal(ctx, AUDIO_VARIANTS[mission]);
  } finally {
    const report = { label: "EJECUCIÓN REAL contra producción (cuenta QA)", mission, jobId, base: BASE, real, runCapUsd: runCap, steps, incidents: incidents.map((i) => ({ kind: i.kind, severity: i.severity, title: i.title, evidence: i.evidence })), media, humanGate: gates, critical, spendUsd: spend, ledger: totals(await ledger.state()), consoleErrors, log };
    writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1));
    await browser.close().catch(() => {});
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
