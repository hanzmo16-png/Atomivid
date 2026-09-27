/**
 * Compatibilidad del Preview de voces con el worker de podcast (gratis, sin
 * red): al volver a registrar tts.yml fijado al commit de podcast, las piezas
 * que Hans cree desde el Preview de voces (app de claude/voices-medieval-tts)
 * las procesará el worker NUEVO. Esto lo comprueba:
 *
 * 1. filas con la forma exacta que inserta la app de voces, más los valores
 *    por defecto que pone 0022 (music_choice 'none', long_pilot false,
 *    mix_status null), con voz del catálogo y con una voz propia simulada;
 * 2. el worker de ESTE checkout (scripts/tts-worker.ts, voz de prueba sin
 *    costo) las procesa contra un Supabase simulado en memoria;
 * 3. la app de voces (--voices-app <checkout>, con `next dev`) las muestra
 *    con reproductor y descarga, junto a una pieza anterior (audio.mp3),
 *    y su página «Mi voz» sigue mostrando la voz propia.
 *
 * Uso: npx tsx scripts/ui-verification/voices-preview-compat.ts --voices-app <ruta> --out-dir <dir>
 * (Playwright como en podcast-ui.ts.)
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { ANON_KEY, SERVICE_KEY, createMockSupabase } from "./mock-supabase";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const voicesApp = path.resolve(arg("--voices-app", ""));
const outDir = path.resolve(arg("--out-dir", "evidence/voices-preview-compat"));
const MOCK_PORT = 54330;
const APP_PORT = 3108;
const APP = `http://localhost:${APP_PORT}`;
/* eslint-disable @typescript-eslint/no-explicit-any */
type Page = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const HANS = { id: "a1a1a1a1-0000-4000-8000-0000000000aa", email: "voces@example.com", password: "prueba-local" };
const VOICE_ID = "d0000000-0000-4000-8000-0000000000aa";
const checks: { name: string; status: "ok" | "falla"; detail?: string }[] = [];
const record = (name: string, ok: boolean, detail?: string) => {
  checks.push({ name, status: ok ? "ok" : "falla", detail });
  console.log(`[compat] ${ok ? "OK   " : "FALLA"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  if (!voicesApp || voicesApp === path.resolve("")) throw new Error("Falta --voices-app <checkout de claude/voices-medieval-tts>");
  await mkdir(outDir, { recursive: true });
  const mock = createMockSupabase([HANS]);
  const { concatToMp3 } = await import("../../src/lib/tts/concat");
  const { monoWav16, speechLikeSamples } = await import("../../src/lib/tts/test-audio");

  // Pieza anterior al cambio (la generó el worker de voces: audio.mp3).
  const before = await concatToMp3([{ audio: monoWav16(speechLikeSamples(5, 3)), extension: "wav", pauseAfterMs: 0 }]);
  const ids = { before: "e0000000-0000-4000-8000-000000000001", catalog: "e0000000-0000-4000-8000-000000000002", custom: "e0000000-0000-4000-8000-000000000003" };
  const now = Date.now();
  const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  // Forma exacta del insert de la app de voces (src/lib/tts/requests.ts en claude/voices-medieval-tts) + valores por defecto de 0021/0022.
  const oldRow = (id: string, over: Record<string, unknown>) => ({
    id,
    user_id: HANS.id,
    client_request_id: crypto.randomUUID(),
    language: "es",
    script: "El caballero avanzó por el camino de tierra.\n\nAl fondo, la torre seguía encendida.",
    characters: 81,
    segments_total: 2,
    status: "queued",
    estimated_seconds: 6,
    estimated_usd: 0.0081,
    max_chars_per_month: 6000,
    // Valores por defecto de la base (no los envía la app de voces):
    attempts: 0,
    segments_done: 0,
    max_chars_per_piece: null,
    long_pilot: false,
    music_choice: "none",
    music_track_id: null,
    mix_status: null,
    mix_attempts: 0,
    audio_path: null,
    ...over,
  });
  mock.rows("tts_jobs").push(
    oldRow(ids.before, { title: "Pieza anterior al cambio", voice_choice: "mateo", voice_label: "Mateo", status: "completed", attempts: 1, segments_done: 2, audio_path: `tts/${ids.before}/audio.mp3`, duration_seconds: 5, created_at: iso(60) }),
    oldRow(ids.catalog, { title: "Pieza con voz del catálogo", voice_choice: "mateo", voice_label: "Mateo", created_at: iso(10) }),
    oldRow(ids.custom, { title: "Pieza con mi voz", voice_choice: `custom:${VOICE_ID}`, voice_label: "Hans podcast (simulada)", created_at: iso(5) }),
  );
  mock.files.set(`videos/tts/${ids.before}/audio.mp3`, { body: before.audio, contentType: "audio/mpeg" });
  mock.rows("user_voices").push({ id: VOICE_ID, user_id: HANS.id, name: "Hans podcast (simulada)", status: "ready", provider_voice_id: "voz-simulada-sin-proveedor", created_at: iso(120) });
  await new Promise<void>((r) => mock.server.listen(MOCK_PORT, "127.0.0.1", () => r()));

  const base: NodeJS.ProcessEnv = { ...process.env, NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`, NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, AUDIOVISUAL_STORAGE_RETRY_MS: "0", NEXT_TELEMETRY_DISABLED: "1" };
  for (const k of ["ELEVENLABS_API_KEY", "GH_WORKER_TOKEN", "GH_WORKER_REPO", "VERCEL", "ATOMIVID_RUNTIME", "GITHUB_EVENT_NAME", "TTS_MUSIC_ENABLED", "TTS_LONG_PILOT_EMAILS"]) delete base[k];
  base.VOICE_PROVIDER = "fixture";

  // Worker NUEVO (este checkout), como lo corre tts.yml.
  for (const id of [ids.catalog, ids.custom]) {
    // Asíncrono: el Supabase simulado vive en este mismo proceso y debe seguir respondiendo.
    const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn("npx", ["tsx", "scripts/tts-worker.ts"], { env: { ...base, TTS_JOB_ID: id } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    const row = mock.rows("tts_jobs").find((r) => r.id === id)!;
    record(
      `worker nuevo procesa una fila de la app de voces (${row.voice_choice})`,
      run.status === 0 && row.status === "completed" && row.audio_path === `tts/${id}/narracion.mp3` && row.mix_status === null && mock.files.has(`videos/tts/${id}/narracion.mp3`),
      `estado ${row.status}, audio ${row.audio_path}, mezcla ${row.mix_status}${run.status !== 0 ? `\n${run.stdout}${run.stderr}` : ""}`,
    );
  }

  // App de voces contra el mismo Supabase simulado, con los flags del Preview de voces.
  const env: NodeJS.ProcessEnv = { ...base, NEXT_PUBLIC_SITE_URL: APP, TEXT_TO_SPEECH_ENABLED: "true", VOICE_CATALOG_ENABLED: "true", MY_VOICE_ENABLED: "true", MY_VOICE_ALLOWLIST_EMAILS: HANS.email };
  const app: ChildProcess = spawn("npx", ["next", "dev", "-p", String(APP_PORT)], { cwd: voicesApp, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let appLog = "";
  app.stdout?.on("data", (d) => (appLog += d));
  app.stderr?.on("data", (d) => (appLog += d));
  const stop = () => {
    try {
      if (app.pid) process.kill(-app.pid, "SIGTERM");
    } catch {
      app.kill("SIGTERM");
    }
    mock.server.close();
  };
  try {
    const end = Date.now() + 180_000;
    while (Date.now() < end && !(await fetch(`${APP}/login`).then((r) => r.status < 500).catch(() => false))) await new Promise((r) => setTimeout(r, 2000));
    for (const route of ["/login", "/dashboard", "/dashboard/tts", "/dashboard/voices"]) await fetch(`${APP}${route}`, { redirect: "manual" }).catch(() => null);
    const require = createRequire(import.meta.url);
    const { chromium } = require("playwright") as { chromium: { launch(o: object): Promise<Page> } };
    const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const errors: string[] = [];
    page.on("console", (m: { type(): string; text(): string }) => m.type() === "error" && errors.push(m.text().slice(0, 500)));
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("atomivid_onboarding_completed_v1", "1");
      } catch {}
    });
    page.setDefaultTimeout(120_000);
    page.setDefaultNavigationTimeout(180_000);
    await page.goto(`${APP}/login?redirectedFrom=/dashboard/tts`, { waitUntil: "domcontentloaded" });
    await page.fill('input[name="email"]', HANS.email);
    await page.fill('input[name="password"]', HANS.password);
    await Promise.all([page.waitForURL((u: URL) => u.pathname.startsWith("/dashboard"), { timeout: 180_000, waitUntil: "domcontentloaded" }), page.click('button[type="submit"]')]);
    await page.goto(`${APP}/dashboard/tts`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Texto a voz" }).waitFor({ timeout: 90_000 });
    await page.screenshot({ caret: "initial", path: path.join(outDir, "preview-voces-texto-a-voz.png"), fullPage: true });

    const downloads = page.locator("a", { hasText: /^Descargar MP3$/ });
    const count = await downloads.count();
    record("la app de voces muestra las tres piezas con descarga (anterior + dos del worker nuevo)", count === 3, `${count} enlaces «Descargar MP3»`);
    record("la app de voces muestra un reproductor por pieza", (await page.locator("audio").count()) === 3);
    for (let i = 0; i < count; i++) {
      const href = await downloads.nth(i).getAttribute("href");
      const res = await fetch(new URL(href!, APP));
      const file = path.join(outDir, `descarga-${i + 1}.mp3`);
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
      const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name", "-of", "default=nw=1", file], { encoding: "utf8" });
      record(`descarga ${i + 1} es un MP3 válido`, res.ok && /codec_name=mp3/.test(probe.stdout), probe.stdout.replace(/\n/g, " ").trim());
    }
    const body = await page.innerText("body");
    record("la app de voces no muestra controles de podcast (música, mezcla)", !/podcast con música|Preparar mezcla|Cambiar música/i.test(body));

    await page.goto(`${APP}/dashboard/voices`, { waitUntil: "domcontentloaded" });
    await page.getByText("Hans podcast (simulada)").first().waitFor({ timeout: 90_000 });
    await page.screenshot({ caret: "initial", path: path.join(outDir, "preview-voces-mi-voz.png"), fullPage: true });
    record("«Mi voz» sigue mostrando la voz propia", true);
    record("sin errores en la consola del navegador", errors.length === 0, errors.join(" | ").slice(0, 500));
    await browser.close();
  } catch (err) {
    record("recorrido de la app de voces", false, `${err instanceof Error ? err.message : err}\n${appLog.slice(-3000)}`);
  } finally {
    stop();
  }
  await writeFile(path.join(outDir, "resultado.json"), JSON.stringify({ checks }, null, 2));
  const failed = checks.filter((c) => c.status === "falla").length;
  console.log(`[compat] ${checks.length - failed} OK, ${failed} fallas`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
