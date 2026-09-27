/**
 * Verificación de la interfaz REAL de «Texto a voz» (podcast) en móvil y
 * escritorio, sin servicios externos ni gasto:
 * - Supabase simulado en memoria (mock-supabase.ts);
 * - la app con `next dev` (flags de prueba, piloto con una cuenta ficticia);
 * - el worker corre en el mismo proceso de la app (sin credenciales de
 *   GitHub) con la voz de prueba sin costo (tono), y usa la unión,
 *   masterización y mezcla reales con ffmpeg;
 * - Chromium (Playwright) recorre la página y guarda capturas.
 *
 * Uso (Playwright no es dependencia del repositorio):
 *   npm i --no-save playwright@1.56.1 && npx playwright install chromium
 *   npx tsx scripts/ui-verification/podcast-ui.ts --out-dir evidence/podcast-ui
 * o, con un Chromium ya instalado: PW_CHROMIUM_PATH=<ruta> NODE_PATH=<node_modules con playwright> …
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { ANON_KEY, SERVICE_KEY, createMockSupabase } from "./mock-supabase";

const args = process.argv.slice(2);
const outDir = path.resolve(args.includes("--out-dir") ? args[args.indexOf("--out-dir") + 1] : "evidence/podcast-ui");
const MOCK_PORT = 54329;
const APP_PORT = 3107;
const APP = `http://localhost:${APP_PORT}`;

// Playwright no es dependencia del repositorio (se instala aparte, ver el encabezado): tipos mínimos locales.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Page = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const PILOT = { id: "a1a1a1a1-0000-4000-8000-000000000001", email: "piloto@example.com", password: "prueba-local" };
const OTHER = { id: "b2b2b2b2-0000-4000-8000-000000000002", email: "otra@example.com", password: "prueba-local" };

type Check = { name: string; status: "ok" | "falla" | "pendiente"; detail?: string };
const checks: Check[] = [];
const record = (name: string, ok: boolean, detail?: string) => {
  checks.push({ name, status: ok ? "ok" : "falla", detail });
  console.log(`[ui] ${ok ? "OK   " : "FALLA"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const pending = (name: string, detail: string) => {
  checks.push({ name, status: "pendiente", detail });
  console.log(`[ui] PEND  ${name} — ${detail}`);
};

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, stepMs = 1000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

async function seed(mock: ReturnType<typeof createMockSupabase>) {
  const { concatToMp3, mixToMp3 } = await import("../../src/lib/tts/concat");
  const { monoWav16, speechLikeSamples } = await import("../../src/lib/tts/test-audio");
  const { pickMusicBed } = await import("../../src/lib/tts/music-beds");
  const parts = [0, 1].map((i) => ({ audio: monoWav16(speechLikeSamples(6, 40 + i)), extension: "wav", pauseAfterMs: i === 0 ? 650 : 0 }));
  const narration = await concatToMp3(parts);
  const bed = pickMusicBed("documentary", "seed-mix");
  const mix = await mixToMp3({ narration: narration.audio, bed });
  const put = (key: string, body: Buffer) => mock.files.set(`videos/${key}`, { body, contentType: "audio/mpeg" });
  const now = Date.now();
  const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  const base = (id: string, over: Record<string, unknown>) => ({
    id,
    user_id: PILOT.id,
    client_request_id: crypto.randomUUID(),
    language: "es",
    voice_choice: "miguel",
    voice_label: "Miguel",
    script: "Primer párrafo de prueba.\n\nSegundo párrafo de prueba.",
    characters: 51,
    segments_total: 2,
    segments_done: 0,
    status: "queued",
    attempts: 0,
    mix_attempts: 0,
    music_choice: "none",
    long_pilot: false,
    max_chars_per_month: 25000,
    max_chars_per_piece: 25000,
    estimated_seconds: 60,
    ...over,
  });
  const done = (id: string) => ({ audio_path: `tts/${id}/narracion.mp3`, duration_seconds: Math.round(narration.durationSeconds * 10) / 10 });
  const ids = {
    withMix: "c0000000-0000-4000-8000-000000000001",
    noMusic: "c0000000-0000-4000-8000-000000000002",
    paused: "c0000000-0000-4000-8000-000000000003",
    mixFailed: "c0000000-0000-4000-8000-000000000004",
    processing: "c0000000-0000-4000-8000-000000000005",
    otherUser: "c0000000-0000-4000-8000-000000000006",
  };
  const jobs = [
    base(ids.withMix, { title: "Episodio con música", status: "completed", music_choice: "documentary", music_track_id: bed.id, mix_status: "completed", mix_path: `tts/${ids.withMix}/podcast-con-musica.mp3`, mix_duration_seconds: Math.round(mix.durationSeconds * 10) / 10, created_at: iso(50), ...done(ids.withMix) }),
    base(ids.noMusic, { title: "Episodio sin música", status: "completed", created_at: iso(40), ...done(ids.noMusic) }),
    base(ids.paused, { title: "Episodio pausado", status: "failed", segments_done: 1, segments_total: 2, attempts: 1, error_message: "Se generaron 1 de 2 fragmentos en esta ejecución. Pulsa «Reanudar» para continuar: lo ya generado se conserva y no se vuelve a cobrar.", created_at: iso(30) }),
    base(ids.mixFailed, { title: "Episodio con mezcla fallida", status: "completed", music_choice: "suspense", mix_status: "failed", mix_attempts: 1, mix_error: "No se pudo preparar la versión con música. La narración está lista y se conserva; puedes reintentar la mezcla sin volver a generar la voz.", created_at: iso(20), ...done(ids.mixFailed) }),
    base(ids.processing, { title: "Episodio en proceso", status: "processing", segments_done: 12, segments_total: 40, attempts: 1, long_pilot: true, characters: 4000, created_at: iso(10) }),
    base(ids.otherUser, { title: "Pieza de otra cuenta", user_id: OTHER.id, status: "completed", created_at: iso(5), ...done(ids.otherUser) }),
  ];
  mock.rows("tts_jobs").push(...jobs);
  for (const id of [ids.withMix, ids.noMusic, ids.mixFailed, ids.otherUser]) put(`tts/${id}/narracion.mp3`, narration.audio);
  put(`tts/${ids.withMix}/podcast-con-musica.mp3`, mix.audio);
  mock.rows("user_voices").push({ id: "d0000000-0000-4000-8000-000000000001", user_id: PILOT.id, name: "Voz simulada", status: "ready", provider_voice_id: "voz-simulada-sin-proveedor", created_at: iso(100) });
  return ids;
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const mock = createMockSupabase([PILOT, OTHER]);
  const ids = await seed(mock);
  await new Promise<void>((r) => mock.server.listen(MOCK_PORT, "127.0.0.1", () => r()));
  console.log(`[ui] Supabase simulado en :${MOCK_PORT}`);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    NEXT_PUBLIC_SITE_URL: APP,
    TEXT_TO_SPEECH_ENABLED: "true",
    TTS_MUSIC_ENABLED: "true",
    VOICE_CATALOG_ENABLED: "true",
    MY_VOICE_ENABLED: "true",
    MY_VOICE_ALLOWLIST_EMAILS: PILOT.email,
    TTS_LONG_PILOT_EMAILS: PILOT.email,
    TTS_LONG_PILOT_MAX_CHARS_PER_PIECE: "25000",
    TTS_LONG_PILOT_MAX_CHARS_PER_MONTH: "25000",
    AUDIOVISUAL_STORAGE_RETRY_MS: "0",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  for (const k of ["ELEVENLABS_API_KEY", "GH_WORKER_TOKEN", "GH_WORKER_REPO", "VERCEL", "ATOMIVID_RUNTIME", "NEXT_PUBLIC_SENTRY_DSN", "SENTRY_DSN"]) delete env[k];
  // Voz de prueba sin costo aunque apareciera una clave en algún .env local.
  env.VOICE_PROVIDER = "fixture";
  // Grupo de procesos propio: al terminar se detiene también el servidor hijo de `npx next dev`.
  const app: ChildProcess = spawn("npx", ["next", "dev", "-p", String(APP_PORT)], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
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
    const ready = await waitFor(async () => (await fetch(`${APP}/login`)).status < 500, 180_000, 2000);
    if (!ready) throw new Error(`la app no arrancó:\n${appLog.slice(-3000)}`);

    const require = createRequire(import.meta.url);
    const { chromium } = require("playwright") as { chromium: { launch(o: object): Promise<Page> } };
    // Local: el Chromium preinstalado (PW_CHROMIUM_PATH); en CI, el que instala Playwright.
    const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
    const views = { escritorio: { viewport: { width: 1280, height: 900 } }, movil: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } };

    // Precompila las rutas (next dev compila en la primera visita).
    for (const route of ["/login", "/dashboard", "/dashboard/tts"]) await fetch(`${APP}${route}`, { redirect: "manual" }).catch(() => null);
    const consoleErrors: string[] = [];
    const login = async (page: Page, user: typeof PILOT) => {
      page.on("console", (m: { type(): string; text(): string }) => {
        if (m.type() === "error") consoleErrors.push(m.text().slice(0, 4000));
      });
      page.on("pageerror", (e: Error) => consoleErrors.push(`pageerror: ${e.message.slice(0, 300)}`));
      // El recorrido de bienvenida (onboarding, ajeno a este cambio) tapa la página en cuentas nuevas: se marca como visto,
      // igual que tras pulsar «Omitir».
      await page.addInitScript(() => {
        try {
          window.localStorage.setItem("atomivid_onboarding_completed_v1", "1");
        } catch {}
      });
      page.setDefaultTimeout(120_000);
      page.setDefaultNavigationTimeout(180_000);
      await page.goto(`${APP}/login?redirectedFrom=/dashboard/tts`, { waitUntil: "domcontentloaded" });
      await page.fill('input[name="email"]', user.email);
      await page.fill('input[name="password"]', user.password);
      await Promise.all([page.waitForURL((u: URL) => u.pathname.startsWith("/dashboard"), { timeout: 180_000, waitUntil: "domcontentloaded" }), page.click('button[type="submit"]')]);
      await page.goto(`${APP}/dashboard/tts`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "Texto a voz" }).waitFor({ timeout: 90_000 }).catch(async (err: unknown) => {
        await page.screenshot({ caret: "initial", path: path.join(outDir, `error-${user.email}.png`), fullPage: true });
        console.error(`[ui] no apareció la página: ${page.url()}\n${(await page.innerText("body").catch(() => "")).slice(0, 1500)}\n--- app ---\n${appLog.slice(-4000)}`);
        throw err;
      });
    };
    const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    const text = (words: number) => Array.from({ length: words }, (_, i) => (i % 12 === 11 ? "valle." : ["la", "niebla", "cubría", "el", "puente", "de", "piedra", "mientras", "el", "caballero", "cruzaba", "el"][i % 12])).join(" ");

    for (const [label, opts] of Object.entries(views)) {
      const context = await browser.newContext(opts);
      const page = await context.newPage();
      await login(page, PILOT);
      await page.screenshot({ caret: "initial", path: path.join(outDir, `${label}-1-pagina.png`), fullPage: true });
      record(`${label}: sin desplazamiento horizontal`, await noHorizontalScroll(page));

      // Contador y estimación.
      await page.fill("#tts-script", text(1300));
      const stats = await page.locator("dl").first().innerText();
      record(`${label}: contador de palabras`, /Palabras\s*1\.300/.test(stats), stats.replace(/\s+/g, " "));
      record(`${label}: duración como estimación en rango`, /Duración aproximada \(estimación\)\s*≈ 9–11 min/.test(stats));
      const usage = await page.getByText(/^Consumo:/).innerText();
      record(`${label}: consumo frente a los límites del piloto`, /Máximo por pieza: 25\.000/.test(usage) && /Te quedan este mes: [\d.]+ de 25\.000/.test(usage), usage.replace(/\s+/g, " ").slice(0, 200));
      await page.getByText("Estimación a 120–140 palabras por minuto").scrollIntoViewIfNeeded();
      await page.screenshot({ caret: "initial", path: path.join(outDir, `${label}-2-contador.png`), fullPage: false });

      // Límite por pieza.
      await page.fill("#tts-script", text(4400));
      const alert = page.locator('p[role="alert"]');
      record(`${label}: aviso de máximo por pieza`, (await alert.innerText().catch(() => "")).includes("El máximo por pieza es 25.000 caracteres."));
      record(`${label}: envío deshabilitado si no cabe`, await page.getByRole("button", { name: "Generar audio" }).isDisabled());
      await alert.scrollIntoViewIfNeeded();
      await page.screenshot({ caret: "initial", path: path.join(outDir, `${label}-3-limite.png`) });

      // Estabilidad del formulario mientras la página se refresca sola (hay piezas en curso).
      const suspenseLabel = page.locator("label", { has: page.locator('input[name="music"][value="suspense"]') });
      await suspenseLabel.scrollIntoViewIfNeeded();
      const boxes: string[] = [];
      for (let i = 0; i < 20; i++) {
        const b = await suspenseLabel.boundingBox();
        boxes.push(b ? `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)}x${Math.round(b.height)}` : "null");
        await page.waitForTimeout(500);
      }
      const distinct = [...new Set(boxes)];
      record(`${label}: el formulario no se mueve durante los refrescos automáticos`, distinct.length === 1, distinct.join(" | "));
      // Música.
      const radios = page.locator('input[name="music"]');
      record(`${label}: tres opciones de acompañamiento`, (await radios.count()) === 3);
      await page.locator('input[name="music"][value="suspense"]').scrollIntoViewIfNeeded(); await page.locator('label', { has: page.locator('input[name="music"][value="suspense"]') }).click(); record("radio Suspenso marcado", await page.locator('input[name="music"][value="suspense"]').isChecked());
      record(`${label}: aviso de dos archivos con música`, await page.getByText("Recibirás dos archivos").isVisible());
      record(`${label}: saldo del proveedor no consultable queda explícito`, await page.getByText("No se pudo consultar el saldo del servicio de voz").isVisible());

      // Estados del historial.
      record(`${label}: estado en proceso con progreso`, await page.getByText("Fragmento 13 de 40").isVisible());
      const pausedCard = page.locator("li", { hasText: "Episodio pausado" });
      record(`${label}: pieza pausada ofrece «Reanudar»`, await pausedCard.getByRole("button", { name: "Reanudar" }).isVisible());
      const failedMix = page.locator("li", { hasText: "Episodio con mezcla fallida" });
      record(`${label}: mezcla fallida conserva la narración y ofrece «Preparar mezcla»`, (await failedMix.locator("audio").count()) === 1 && (await failedMix.getByRole("button", { name: "Preparar mezcla" }).isVisible()));
      const withMix = page.locator("li", { hasText: "Episodio con música" });
      record(`${label}: pieza con música muestra dos reproductores y dos descargas`, (await withMix.locator("audio").count()) === 2 && (await withMix.getByRole("link", { name: "Descargar narración" }).isVisible()) && (await withMix.getByRole("link", { name: "Descargar con música" }).isVisible()));
      record(`${label}: otra cuenta no aparece`, !(await page.getByText("Pieza de otra cuenta").isVisible()));
      await withMix.scrollIntoViewIfNeeded();
      await page.screenshot({ caret: "initial", path: path.join(outDir, `${label}-4-historial.png`), fullPage: true });

      // Reproducción: los dos audios cargan y tienen duración.
      for (const [i, name] of ["narración", "con música"].entries()) {
        const duration = await withMix.locator("audio").nth(i).evaluate(async (el: HTMLAudioElement) => {
          el.preload = "auto";
          el.load();
          await new Promise((r) => (el.readyState >= 1 ? r(null) : el.addEventListener("loadedmetadata", () => r(null), { once: true })));
          return el.duration;
        });
        record(`${label}: el reproductor de ${name} carga el audio`, Number.isFinite(duration) && duration > 5, `${duration.toFixed(1)} s`);
      }
      // Descarga de ambos archivos.
      for (const [linkName, suffix] of [["Descargar narración", "-narracion.mp3"], ["Descargar con música", "-podcast-con-musica.mp3"]] as const) {
        const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), withMix.getByRole("link", { name: linkName }).click()]);
        const saved = path.join(outDir, `${label}-${download.suggestedFilename()}`);
        await download.saveAs(saved);
        const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name", "-of", "default=nw=1", saved]).stdout.toString();
        record(`${label}: descarga «${linkName}»`, download.suggestedFilename().endsWith(suffix) && /codec_name=mp3/.test(probe), `${download.suggestedFilename()} (${probe.replace(/\s+/g, " ").trim()})`);
      }
      await context.close();
    }

    // Flujo completo en escritorio: crear con música, reanudar y cambiar música.
    const context = await browser.newContext(views.escritorio);
    const page = await context.newPage();
    await login(page, PILOT);
    await page.fill("#tts-title", "Pieza nueva con suspenso");
    await page.fill("#tts-script", `${text(90)}\n\n${text(80)}`);
    await page.locator('input[name="music"][value="suspense"]').scrollIntoViewIfNeeded(); await page.locator('label', { has: page.locator('input[name="music"][value="suspense"]') }).click(); record("radio Suspenso marcado", await page.locator('input[name="music"][value="suspense"]').isChecked());
    await Promise.all([page.waitForURL(/job=/, { timeout: 60_000 }), page.getByRole("button", { name: "Generar audio" }).click()]);
    const created = mock.rows("tts_jobs").find((r) => r.title === "Pieza nueva con suspenso");
    record("crear: la pieza se guarda con música y mezcla pendiente", Boolean(created && created.music_choice === "suspense"), created ? `estado ${created.status}, mezcla ${created.mix_status}` : "no creada");
    const finished = await waitFor(async () => created?.status === "completed" && created?.mix_status === "completed", 240_000, 2000);
    record("crear: el worker local termina narración y mezcla", finished, created ? `estado ${created.status}, mezcla ${created.mix_status}${created.error_message ? `, ${created.error_message}` : ""}${created.mix_error ? `, ${created.mix_error}` : ""}` : "");
    await page.reload();
    const newCard = page.locator("li", { hasText: "Pieza nueva con suspenso" });
    record("crear: la tarjeta nueva muestra ambos archivos", (await newCard.locator("audio").count()) === 2);
    await newCard.scrollIntoViewIfNeeded();
    await page.screenshot({ caret: "initial", path: path.join(outDir, "escritorio-5-pieza-nueva.png") });

    // El id del formulario no cambia con los refrescos automáticos (hay piezas en curso).
    await page.goto(`${APP}/dashboard/tts`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Texto a voz" }).waitFor();
    const idBefore = await page.locator('input[name="client_request_id"]').inputValue();
    await page.waitForTimeout(9_000);
    const idAfter = await page.locator('input[name="client_request_id"]').inputValue();
    record("el id del formulario se mantiene durante los refrescos automáticos", idBefore === idAfter, `${idBefore.slice(0, 8)} → ${idAfter.slice(0, 8)}`);

    // Doble envío: el mismo formulario enviado dos veces devuelve la misma pieza.
    const count = mock.rows("tts_jobs").length;
    await page.fill("#tts-title", "Doble envío");
    await page.fill("#tts-script", text(40));
    const clientId = await page.locator('input[name="client_request_id"]').inputValue();
    await page.evaluate(() => {
      const form = document.querySelector("form:has(#tts-script)") as HTMLFormElement;
      form.requestSubmit();
      form.requestSubmit();
    });
    await page.waitForURL((u: URL) => u.searchParams.has("job"), { timeout: 60_000 });
    await waitFor(async () => mock.rows("tts_jobs").some((r) => r.client_request_id === clientId), 10_000, 250);
    const sameId = mock.rows("tts_jobs").filter((r) => r.client_request_id === clientId);
    record("doble envío: una sola pieza", sameId.length === 1 && mock.rows("tts_jobs").length === count + 1, `${sameId.length} con el mismo id de formulario`);
    const idNext = await page.locator('input[name="client_request_id"]').inputValue();
    record("tras crear, el formulario trae un id nuevo", idNext !== clientId);

    // Reanudar la pieza pausada.
    await page.goto(`${APP}/dashboard/tts`, { waitUntil: "domcontentloaded" });
    await page.locator("li", { hasText: "Episodio pausado" }).getByRole("button", { name: "Reanudar" }).click();
    const paused = mock.rows("tts_jobs").find((r) => r.id === ids.paused)!;
    const resumed = await waitFor(async () => paused.status === "completed", 180_000, 2000);
    record("reanudar: la pieza pausada termina", resumed, `estado ${paused.status}, intentos ${paused.attempts}`);

    // Cambiar música: usa la narración guardada (no cambia) y produce otra mezcla.
    await page.goto(`${APP}/dashboard/tts`, { waitUntil: "domcontentloaded" });
    const narrationBefore = mock.files.get(`videos/tts/${ids.withMix}/narracion.mp3`)!.body;
    const mixBefore = mock.files.get(`videos/tts/${ids.withMix}/podcast-con-musica.mp3`)!.body;
    const card = page.locator("li", { hasText: "Episodio con música" });
    await card.locator("select").selectOption("suspense");
    await card.getByRole("button", { name: "Volver a mezclar" }).click();
    await page.getByText("Preparando la versión con música").first().waitFor({ timeout: 30_000 }).catch(() => {});
    await page.screenshot({ caret: "initial", path: path.join(outDir, "escritorio-6-cambiando-musica.png") });
    const withMixRow = mock.rows("tts_jobs").find((r) => r.id === ids.withMix)!;
    const remixed = await waitFor(async () => withMixRow.mix_status === "completed" && withMixRow.music_choice === "suspense", 180_000, 2000);
    const narrationAfter = mock.files.get(`videos/tts/${ids.withMix}/narracion.mp3`)!.body;
    const mixAfter = mock.files.get(`videos/tts/${ids.withMix}/podcast-con-musica.mp3`)!.body;
    record("cambiar música: nueva mezcla con Suspenso y la narración intacta", remixed && narrationBefore.equals(narrationAfter) && !mixBefore.equals(mixAfter), `fondo ${withMixRow.music_track_id}`);

    // Privacidad: la otra cuenta solo ve lo suyo y tiene los límites generales.
    const other = await browser.newContext(views.movil);
    const otherPage = await other.newPage();
    await login(otherPage, OTHER);
    record("privacidad: la otra cuenta no ve piezas del piloto", !(await otherPage.getByText("Episodio con música").isVisible()) && (await otherPage.getByText("Pieza de otra cuenta").isVisible()));
    await otherPage.fill("#tts-script", text(600));
    record("usuario general: máximo por pieza 3.000", (await otherPage.locator('p[role="alert"]').innerText().catch(() => "")).includes("3.000"));
    await otherPage.screenshot({ caret: "initial", path: path.join(outDir, "movil-7-usuario-general.png"), fullPage: true });

    await writeFile(path.join(outDir, "consola.txt"), consoleErrors.join("\n\n---\n\n"));
    record("sin errores en la consola del navegador", consoleErrors.length === 0, consoleErrors.slice(0, 5).map((e) => e.slice(0, 300)).join(" | "));
    pending("saldo del servicio de voz con valor real", "sin ELEVENLABS_API_KEY la consulta devuelve «no disponible»; se verificó solo ese estado");
    pending("reproducción con audio real de ElevenLabs y escucha", "la voz de prueba es un tono o habla sintética; nadie escuchó las muestras");
    await browser.close();
  } finally {
    stop();
  }

  await writeFile(path.join(outDir, "resultado.json"), JSON.stringify({ checks }, null, 2));
  const failed = checks.filter((c) => c.status === "falla");
  console.log(`[ui] ${checks.filter((c) => c.status === "ok").length} OK, ${failed.length} fallas, ${checks.filter((c) => c.status === "pendiente").length} pendientes`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
