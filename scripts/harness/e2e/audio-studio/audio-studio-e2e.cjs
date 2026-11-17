/**
 * Audio Podcast Studio 1.0 — recorrido E2E local. USD 0: todo en 127.0.0.1 con el arnés de podcast/start.sh
 * (gateway con Storage local, proveedores simulados). Samsung 390x844 y escritorio 1440x900.
 *
 * Comprueba: enlace en el panel, episodio inicial cargado, crear y guardar episodios (1 y 2 voces), el editor conserva
 * los cambios tras recargar, música, presupuesto visible, «Generar» bloqueado sin llamadas de pago, biblioteca
 * (archivar/restaurar sin borrar), aislamiento entre cuentas por UI y por API, y que Podcast Premium, la portada y
 * Long Form siguen respondiendo igual.
 *
 *   E2E_OUT=<dir> E2E_BASE=http://127.0.0.1:3300 node audio-studio-e2e.cjs
 */
const path = require("node:path"), fs = require("node:fs");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:3300";
const OUT = path.resolve(process.env.E2E_OUT ?? "audio-studio-out"); fs.mkdirSync(OUT, { recursive: true });
const STORAGE = process.env.E2E_STORAGE_DIR; // carpeta del Storage local del gateway (para comprobar que nada se borra)
const EGRESS = process.env.E2E_EGRESS_LOG;
const OWNER = { id: "11111111-1111-4111-8111-111111111111", email: "pilot-owner@local.test", password: "local-pass-owner-1" };
const OTHER = { id: "22222222-2222-4222-8222-222222222222", email: "intruso@local.test", password: "local-pass-other-2" };
const SEED_TITLE = "El día que entiendes que no puedes controlarlo todo";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; SM-A155M) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const DEVICES = {
  "android-360": { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: ANDROID_UA },
  "samsung-390": { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.75, userAgent: ANDROID_UA },
  "desktop-1440": { viewport: { width: 1440, height: 900 } },
};
let fails = 0, passes = 0;
const check = (name, ok, detail) => { ok ? passes++ : fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + JSON.stringify(detail ?? null).slice(0, 400)}`); return !!ok; };
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const listFiles = (d) => { if (!d || !fs.existsSync(d)) return []; const out = []; const walk = (x) => { for (const f of fs.readdirSync(x)) { const q = path.join(x, f); fs.statSync(q).isDirectory() ? walk(q) : out.push(path.relative(d, q)); } }; walk(d); return out.sort(); };
const FAIL_MARK = process.env.E2E_FAIL_MARK ?? "[[falla-proveedor]]";
const words = (n, seed) => { const base = (seed + " ").repeat(Math.ceil(n / seed.split(" ").length)).split(" ").filter(Boolean).slice(0, n); return base.join(" "); };
/** Guion de ~5 min (750 palabras): con dos voces alterna «Voz 1:» / «Voz 2:» por párrafo. */
const fiveMinutes = (duo) => ["## Apertura", ...Array.from({ length: 10 }, (_, i) => `${duo ? `Voz ${(i % 2) + 1}: ` : ""}${words(75, i % 3 ? "Respira y vuelve a lo que depende de ti, con calma y valor cada día" : "El silencio también enseña cuando aceptas lo que no controlas")}.`), "## Cierre", `${duo ? "Voz 1: " : ""}Gracias por escuchar.`].join("\n\n");
async function waitGeneration(p, label, timeout = 900000) {
  await p.waitForFunction(() => /Audio listo|Falló|Interrumpida/.test(document.querySelector('[data-testid="audio-generation-status"]')?.textContent ?? ""), null, { timeout, polling: 2000 });
  return (await p.getByTestId("audio-generation-status").innerText()).trim();
}
async function generate(p) {
  // Si el proyecto ya tenía un MP3 (Storage local reutilizado), «Audio listo» previo no cuenta: se espera la cola.
  const before = (await p.getByTestId("audio-generation-status").innerText().catch(() => "")).trim();
  await p.getByTestId("audio-authorize").check();
  await p.getByTestId("audio-generate").click();
  await p.waitForFunction((prev) => { const t = document.querySelector('[data-testid="audio-generation-status"]')?.textContent ?? ""; return /En cola|Generando/.test(t) || (/Audio listo/.test(t) && !/Audio listo/.test(prev)); }, before, { timeout: 30000 });
}
const apiProject = (p, id) => p.evaluate(async (x) => (await fetch(`/api/audio-studio/projects/${x}`)).json(), id);
async function downloadMp3(p, id, file) {
  const r = await p.request.get(`${BASE}/api/audio-studio/projects/${id}/audio?descargar=1`);
  const body = await r.body();
  if (file) fs.writeFileSync(file, body);
  return { status: r.status(), type: r.headers()["content-type"] ?? "", bytes: body.length, mp3: body.length > 1000 && ((body[0] === 0x49 && body[1] === 0x44 && body[2] === 0x33) || (body[0] === 0xff && (body[1] & 0xe0) === 0xe0)) };
}
const egressLines = () => (EGRESS && fs.existsSync(EGRESS) ? fs.readFileSync(EGRESS, "utf8").split("\n").filter(Boolean) : []);

async function login(browser, user, opts) {
  const ctx = await browser.newContext({ ...opts, locale: "es-MX" });
  await ctx.addInitScript(() => { try { localStorage.setItem("atomivid_onboarding_completed_v1", "1"); } catch {} });
  const p = await ctx.newPage(); p.setDefaultTimeout(90000);
  await p.goto(`${BASE}/login`); await p.fill("input[name=email]", user.email); await p.fill("input[name=password]", user.password);
  await p.locator("form button[type=submit]").last().click(); await p.waitForURL(/\/dashboard/);
  return { ctx, p };
}
const shot = (p, name) => p.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true }).catch(() => {});

(async () => {
  const filesBefore = listFiles(STORAGE).filter((f) => !f.startsWith("videos/audio-studio/"));
  const egressBefore = egressLines().length;
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME || undefined });
  let ownerProjectId = null, ownerAudioId = null;
  try {
    const only = (process.env.E2E_DEVICES ?? "").split(",").filter(Boolean);
    for (const [dev, opts] of Object.entries(DEVICES).filter(([d]) => !only.length || only.includes(d))) {
      const { ctx, p } = await login(browser, OWNER, opts);
      const paid = []; p.on("request", (r) => { if (/elevenlabs|heygen|openai|anthropic|recraft|fal\.|pexels/i.test(r.url())) paid.push(r.url()); });

      // 1. Enlace en el panel (franja móvil o barra de escritorio).
      await p.goto(`${BASE}/dashboard`);
      const nav = p.locator('header a[href="/dashboard/audio-studio"]:visible');
      check(`[${dev}] el panel muestra «Audio Podcast»`, (await nav.count()) === 1 && /Audio Podcast/.test(await nav.first().innerText()));
      await nav.first().click(); await p.waitForURL(/\/dashboard\/audio-studio$/); await p.getByTestId("audio-studio").waitFor();
      await shot(p, `${dev}-01-biblioteca`);
      const ov1 = await overflow(p); check(`[${dev}] biblioteca sin desplazamiento horizontal`, ov1 <= 1, `${ov1}px`);

      // 2. Episodio inicial cargado como proyecto editable (una sola vez, aunque se visite en dos dispositivos).
      const items = p.getByTestId("audio-library-item");
      const titles = await items.allInnerTexts();
      if (!check(`[${dev}] episodio inicial en la biblioteca, sin duplicados`, titles.filter((t) => t === SEED_TITLE).length === 1, titles))
        console.log("DIAGNÓSTICO página:", (await p.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 600));
      await items.filter({ hasText: SEED_TITLE }).click(); await p.getByTestId("audio-editor").waitFor();
      const seedUrl = p.url();
      check(`[${dev}] guion inicial cargado (~18 min)`, /≈ 1[78](\.\d)? min/.test(await p.getByTestId("audio-script-stats").innerText()), await p.getByTestId("audio-script-stats").innerText());
      check(`[${dev}] voz masculina profesional latinoamericana elegida`, (await p.getByTestId("audio-voice-0").inputValue()) === "es-latam-m-profesional");
      check(`[${dev}] duración objetivo 18 min`, (await p.getByTestId("audio-target").inputValue()) === "18");
      check(`[${dev}] música inteligente con plan por sección`, await p.getByTestId("audio-music-inteligente").isChecked() && /Plan musical por sección \(1\d\)/.test(await p.getByTestId("audio-music-plan").innerText()));
      check(`[${dev}] presupuesto visible: estimado, tope y gastado USD 0.00`, /USD \d+\.\d\d/.test(await p.getByTestId("audio-estimated-usd").innerText()) && (await p.getByTestId("audio-spent-usd").innerText()) === "USD 0.00");
      await shot(p, `${dev}-02-episodio-inicial`);
      const ov2 = await overflow(p); check(`[${dev}] editor sin desplazamiento horizontal`, ov2 <= 1, `${ov2}px`);
      // Estado de la síntesis (T-2013): el servidor informa «local» sin exponer configuración; la UI lo indica y ofrece el gasto.
      await p.getByTestId("audio-authorize").waitFor({ timeout: 30000 });
      const vs = await p.evaluate(async () => { const r = await fetch("/api/audio-studio/voices", { cache: "no-store" }); return { status: r.status, body: await r.json() }; });
      check(`[${dev}] ruta de voces: síntesis «local» y solo campos públicos`, vs.status === 200 && vs.body.synthesis === "local" && Object.keys(vs.body).sort().join() === "synthesis,voices", vs);
      check(`[${dev}] nota de voz de prueba local visible y sin aviso de síntesis inactiva`, (await p.getByTestId("audio-voice-local").count()) === 1 && (await p.getByTestId("audio-voice-disabled").count()) === 0);
      // Botones táctiles: 44 px o más.
      for (const id of ["audio-save", "audio-generate", "audio-archive"]) {
        const b = await p.getByTestId(id).boundingBox(); check(`[${dev}] botón ${id} ≥ 44 px de alto`, b && b.height >= 44, b);
      }

      // 3. Autorización expresa: el botón «Generar MP3» exige marcar el monto exacto estimado.
      check(`[${dev}] «Generar MP3» deshabilitado hasta autorizar el monto`, await p.getByTestId("audio-generate").isDisabled());
      check(`[${dev}] el monto a autorizar es el estimado`, (await p.getByTestId("audio-authorize-usd").innerText()) === (await p.getByTestId("audio-estimated-usd").innerText()));
      if (dev === "desktop-1440") {
        // Primer episodio: MP3 completo (~16–18 min) con voz de prueba local y música inteligente.
        const seedId = seedUrl.split("/").pop();
        await generate(p);
        check(`[${dev}] episodio inicial en generación (editor bloqueado)`, await p.getByTestId("audio-title").isDisabled());
        await p.getByTestId("audio-progress").waitFor({ timeout: 60000 }).catch(() => {});
        await shot(p, `${dev}-02b-generando`);
        const st = await waitGeneration(p, "inicial", 1500000);
        check(`[${dev}] episodio inicial: MP3 listo`, st === "Audio listo", [st, await p.getByTestId("audio-generation-error").innerText().catch(() => "")]);
        const proj = await apiProject(p, seedId);
        check(`[${dev}] episodio inicial: ${Math.round(proj.audio?.durationSeconds / 60)} min, ${proj.audio?.lufs} LUFS, pico ${proj.audio?.truePeak} dBTP`, proj.audio && proj.audio.durationSeconds > 13 * 60 && Math.abs(proj.audio.lufs + 16) <= 1.5 && proj.audio.truePeak <= -1, proj.audio);
        check(`[${dev}] episodio inicial: música de varias pistas CC0 por sección`, proj.audio && proj.audio.musicTracks.length >= 2 && proj.audio.musicTracks.every((t) => t.endsWith("CC0 1.0")), proj.audio?.musicTracks);
        const dl = await downloadMp3(p, seedId, path.join(OUT, "episodio-inicial.mp3"));
        check(`[${dev}] episodio inicial: descarga MP3 válida (${dl.bytes} bytes)`, dl.status === 200 && dl.mp3 && dl.bytes === proj.audio.bytes, dl);
        check(`[${dev}] gasto real USD 0.00 (voz de prueba local)`, (await p.getByTestId("audio-spent-usd").innerText()) === "USD 0.00");
        await shot(p, `${dev}-02c-episodio-inicial-mp3`);
      }

      // 4. Crear un episodio nuevo de dos voces, editarlo y comprobar que se conserva tras recargar.
      await p.goto(`${BASE}/dashboard/audio-studio`);
      const title = `Conversación ${dev} ${Date.now()}`;
      await p.fill("#audio-new-title", title);
      await p.locator('[data-testid="audio-new"] input[name=voiceCount][value="2"]').check();
      await p.locator('[data-testid="audio-new"] button[type=submit]').click();
      await p.waitForURL(/\/dashboard\/audio-studio\/[0-9a-f-]{36}$/); await p.getByTestId("audio-editor").waitFor();
      const newUrl = p.url(); if (dev === "samsung-390") ownerProjectId = newUrl.split("/").pop();
      check(`[${dev}] dos voces: dos selectores distintos`, (await p.getByTestId("audio-voice-1").count()) === 1 && (await p.getByTestId("audio-voice-0").inputValue()) !== (await p.getByTestId("audio-voice-1").inputValue()));
      let script = "## Bienvenida\nVoz 1: Hola, bienvenidos a una charla sobre la calma.\nVoz 2: Gracias por estar aquí; hoy hablamos de respirar y aceptar.\n## Cierre\nVoz 1: El futuro empieza con lo que eliges hoy.";
      await p.getByTestId("audio-script").fill(script);
      await p.getByTestId("audio-voice-1").selectOption("es-latam-f-energica");
      await p.getByTestId("audio-target").fill("5");
      await p.getByTestId("audio-music-fija").check();
      await p.getByTestId("audio-mood").selectOption("calma");
      await p.getByTestId("audio-music-intro").uncheck();
      await p.getByTestId("audio-budget").fill("2.5");
      check(`[${dev}] indicador «Cambios sin guardar»`, /Cambios sin guardar|Guardando/.test(await p.getByTestId("audio-save-state").innerText()));
      await p.getByTestId("audio-save").click();
      await p.waitForFunction(() => document.querySelector('[data-testid="audio-save-state"]')?.textContent === "Guardado");
      await p.reload(); await p.getByTestId("audio-editor").waitFor();
      check(`[${dev}] tras recargar: guion conservado`, (await p.getByTestId("audio-script").inputValue()) === script);
      check(`[${dev}] tras recargar: voces conservadas`, (await p.getByTestId("audio-voice-1").inputValue()) === "es-latam-f-energica");
      check(`[${dev}] tras recargar: duración, música y tope conservados`, (await p.getByTestId("audio-target").inputValue()) === "5" && await p.getByTestId("audio-music-fija").isChecked()
        && (await p.getByTestId("audio-mood").inputValue()) === "calma" && !(await p.getByTestId("audio-music-intro").isChecked()) && (await p.getByTestId("audio-budget").inputValue()) === "2.5");
      // Guardado automático: escribir y esperar sin pulsar Guardar.
      await p.getByTestId("audio-notes").fill("Nota guardada sola");
      await p.waitForFunction(() => document.querySelector('[data-testid="audio-save-state"]')?.textContent === "Guardado", null, { timeout: 30000 });
      await p.reload(); await p.getByTestId("audio-editor").waitFor();
      check(`[${dev}] guardado automático conserva las notas`, (await p.getByTestId("audio-notes").inputValue()) === "Nota guardada sola");
      await shot(p, `${dev}-03-dos-voces`);
      if (dev !== "desktop-1440") {
        // MP3 de 5 min: dúo en 390 px, monólogo en 360 px (el editor de 360 cambia a una voz).
        const duo = dev === "samsung-390";
        if (!duo) { await p.getByTestId("audio-voices-1").check(); }
        script = fiveMinutes(duo);
        await p.getByTestId("audio-script").fill(script);
        await p.getByTestId("audio-music-inteligente").check();
        await p.getByTestId("audio-budget").fill("5");
        // El dúo se genera con v4 Turbo; el monólogo con Multilingual v2 (modelo por defecto).
        check(`[${dev}] modelo por defecto: V4 Turbo`, (await p.getByTestId("audio-model").inputValue()) === "eleven_v4_turbo");
        if (duo) {
          await p.getByTestId("audio-model").selectOption("eleven_v4_turbo");
          check(`[${dev}] v4 Turbo: tarifa conservadora sin descuentos no comprobados`, /conservadora|sin verificar|no comprobad/i.test(await p.getByTestId("audio-rate-note").innerText()), await p.getByTestId("audio-rate-note").innerText());
        }
        await p.getByTestId("audio-save").click();
        await p.waitForFunction(() => document.querySelector('[data-testid="audio-save-state"]')?.textContent === "Guardado");
        await generate(p);
        const st = await waitGeneration(p, dev);
        check(`[${dev}] ${duo ? "dúo" : "monólogo"} de 5 min: MP3 listo`, st === "Audio listo", [st, await p.getByTestId("audio-generation-error").innerText().catch(() => "")]);
        const id = newUrl.split("/").pop();
        const proj = await apiProject(p, id);
        check(`[${dev}] ${duo ? "dúo" : "monólogo"}: duración ${proj.audio?.durationSeconds} s, ${proj.audio?.lufs} LUFS, pico ${proj.audio?.truePeak}`, proj.audio && proj.audio.durationSeconds > 180 && Math.abs(proj.audio.lufs + 16) <= 1.5 && proj.audio.truePeak <= -1, proj.audio);
        const dl = await downloadMp3(p, id, path.join(OUT, `${dev}-${duo ? "duo" : "monologo"}.mp3`));
        check(`[${dev}] el MP3 registra el modelo V4 Turbo`, proj.audio.model === "eleven_v4_turbo" && proj.generation.authorization?.model === proj.audio.model, [proj.audio.model, proj.generation.authorization]);
        check(`[${dev}] descarga MP3 válida`, dl.status === 200 && dl.mp3 && dl.bytes === proj.audio.bytes, dl);
        check(`[${dev}] reproductor presente`, (await p.getByTestId("audio-player").count()) === 1);
        await shot(p, `${dev}-03b-mp3`);
        if (duo) {
          // Remezcla: otra música sin volver a sintetizar la voz.
          const calls = proj.generation.providerCalls;
          await p.getByTestId("audio-music-fija").check(); await p.getByTestId("audio-mood").selectOption("intensa");
          await p.getByTestId("audio-save").click();
          await p.waitForFunction(() => document.querySelector('[data-testid="audio-save-state"]')?.textContent === "Guardado");
          await p.getByTestId("audio-remix").click();
          // Primero la cola (el estado anterior era «Audio listo»), luego el final.
          await p.waitForFunction(() => /En cola|Generando/.test(document.querySelector('[data-testid="audio-generation-status"]')?.textContent ?? ""), null, { timeout: 30000 });
          const st2 = await waitGeneration(p, "remezcla");
          const after = await apiProject(p, id);
          check(`[${dev}] remezcla lista sin llamadas nuevas al proveedor (${calls} → ${after.generation.providerCalls})`, st2 === "Audio listo" && after.generation.providerCalls === calls && after.audio.sha256 !== proj.audio.sha256 && after.audio.reusedSegments === after.audio.segments, after.generation);
          check(`[${dev}] remezcla con la pista elegida`, after.audio.musicTracks.length === 1 && after.audio.musicTracks[0].startsWith("atomivid-tension.wav"), after.audio.musicTracks);
          ownerAudioId = id;
        }
      }

      // 5. Conflicto entre pestañas: la segunda pestaña no pisa la primera.
      const p2 = await ctx.newPage(); await p2.goto(newUrl); await p2.getByTestId("audio-editor").waitFor();
      await p.getByTestId("audio-title").fill(`${title} (pestaña 1)`);
      // Guardar a mano o por el guardado automático (2,5 s): en una máquina lenta el automático puede ganar y dejar «Guardar»
      // deshabilitado; ambos caminos guardan la pestaña 1 antes que la 2.
      if (await p.getByTestId("audio-save").isEnabled().catch(() => false)) await p.getByTestId("audio-save").click().catch(() => {});
      await p.waitForFunction(() => document.querySelector('[data-testid="audio-save-state"]')?.textContent === "Guardado");
      await p2.getByTestId("audio-title").fill(`${title} (pestaña 2)`); await p2.getByTestId("audio-save").click();
      await p2.getByTestId("audio-message").waitFor();
      check(`[${dev}] pestaña desactualizada recibe conflicto y no pisa`, /cambió en otra pestaña/.test(await p2.getByTestId("audio-message").innerText()));
      await p.reload(); check(`[${dev}] el título guardado es el de la pestaña 1`, (await p.getByTestId("audio-title").inputValue()) === `${title} (pestaña 1)`);
      await p2.close();

      // 6. Biblioteca: archivar y restaurar sin borrar.
      await p.getByTestId("audio-archive").click(); await p.getByTestId("audio-restore").waitFor();
      await p.goto(`${BASE}/dashboard/audio-studio`);
      check(`[${dev}] archivado sale de Activos`, !(await p.getByTestId("audio-library-item").allInnerTexts()).some((t) => t.startsWith(title)));
      await p.goto(`${BASE}/dashboard/audio-studio?archivados=1`);
      check(`[${dev}] archivado aparece en Archivados`, (await p.getByTestId("audio-library-item").allInnerTexts()).some((t) => t.startsWith(title)));
      await p.goto(newUrl); await p.getByTestId("audio-restore").click(); await p.getByTestId("audio-archive").waitFor();
      check(`[${dev}] restaurado conserva el guion`, (await p.getByTestId("audio-script").inputValue()) === script);
      await p.goto(`${BASE}/dashboard/audio-studio`);
      check(`[${dev}] restaurado vuelve a Activos`, (await p.getByTestId("audio-library-item").allInnerTexts()).some((t) => t.startsWith(title)));
      await shot(p, `${dev}-04-biblioteca-final`);

      // 7. El episodio inicial no cambió por visitar.
      await p.goto(seedUrl); check(`[${dev}] episodio inicial sigue en borrador y editable`, !(await p.getByTestId("audio-title").isDisabled()) && (await p.getByTestId("audio-title").inputValue()) === SEED_TITLE);

      if (dev === "desktop-1440") {
        // Error del proveedor (simulado solo en el arnés): falla con mensaje claro, sin MP3 y sin gasto.
        await p.goto(`${BASE}/dashboard/audio-studio`);
        await p.fill("#audio-new-title", `Falla proveedor ${Date.now()}`);
        await p.locator('[data-testid="audio-new"] button[type=submit]').click();
        await p.waitForURL(/\/dashboard\/audio-studio\/[0-9a-f-]{36}$/); await p.getByTestId("audio-editor").waitFor();
        await p.getByTestId("audio-target").fill("5");
        await p.getByTestId("audio-script").fill(fiveMinutes(false).replace("Gracias por escuchar.", `Gracias por escuchar ${FAIL_MARK}.`));
        await p.getByTestId("audio-model").selectOption("eleven_v4_turbo");
        await p.getByTestId("audio-save").click();
        await p.waitForFunction(() => document.querySelector('[data-testid="audio-save-state"]')?.textContent === "Guardado");
        await generate(p);
        const st = await waitGeneration(p, "falla");
        const err = await p.getByTestId("audio-generation-error").innerText().catch(() => "");
        check(`[${dev}] error del proveedor: estado «Falló» con explicación y «Reanudar»`, st === "Falló" && /proveedor de voz falló.*no se volverá a cobrar/.test(err) && (await p.getByTestId("audio-resume").count()) === 1, [st, err]);
        check(`[${dev}] error del proveedor: sin MP3 publicado`, (await p.getByTestId("audio-result").count()) === 0);
        // Sin cambio automático de modelo (podría cobrar dos veces): sigue en v4 Turbo y el respaldo es una acción explícita.
        const failedId = p.url().split("/").pop();
        const failed = await apiProject(p, failedId);
        check(`[${dev}] tras el fallo sigue en v4 Turbo (sin cambio automático)`, failed.ttsModel === "eleven_v4_turbo" && (await p.getByTestId("audio-model").inputValue()) === "eleven_v4_turbo", failed.ttsModel);
        check(`[${dev}] botón explícito de respaldo a Multilingual v2`, (await p.getByTestId("audio-fallback").count()) === 1);
        await p.getByTestId("audio-fallback").click();
        await p.waitForFunction(() => document.querySelector('[data-testid="audio-model"]')?.value === "eleven_multilingual_v2", null, { timeout: 30000 }).catch(() => {});
        const fb = await apiProject(p, failedId);
        check(`[${dev}] respaldo explícito: Multilingual v2, sin autorización vigente ni cargo nuevo`, fb.ttsModel === "eleven_multilingual_v2" && fb.generation.authorization === null && fb.generation.status !== "fallida" && fb.spentUsd === failed.spentUsd, [fb.ttsModel, fb.generation.status, fb.spentUsd]);
        await shot(p, `${dev}-06b-respaldo`);
        await shot(p, `${dev}-06-error-proveedor`);
      }

      // 8. Módulos anteriores siguen respondiendo.
      for (const [label, url, sel] of [["portada", "/dashboard", '[data-testid="crear-inicio"]'], ["Podcast Premium", "/dashboard/podcast", "main"], ["Long Form", "/dashboard/long-form/new", "main"], ["Facturación", "/dashboard/billing", "main"]]) {
        const r = await p.goto(`${BASE}${url}`); check(`[${dev}] ${label} responde ${r?.status()}`, r && r.status() < 400);
        await p.locator(sel).first().waitFor({ timeout: 90000 }).catch(() => {});
        check(`[${dev}] ${label} sin error de aplicación`, !/Application error|Algo salió mal|Unhandled Runtime Error/.test(await p.locator("body").innerText()));
      }
      await shot(p, `${dev}-05-podcast-premium`);
      check(`[${dev}] ninguna petición del navegador a proveedores de pago`, paid.length === 0, paid);
      await ctx.close();
    }

    // 9. Aislamiento: otra cuenta con acceso no ve ni abre ni edita los proyectos del dueño (UI y API).
    const { ctx, p } = await login(browser, OTHER, DEVICES["desktop-1440"]);
    await p.goto(`${BASE}/dashboard/audio-studio`); await p.getByTestId("audio-studio").waitFor();
    const theirs = await p.getByTestId("audio-library-item").allInnerTexts().catch(() => []);
    check("[aislamiento] la otra cuenta no ve el episodio inicial del dueño ni sus episodios", !theirs.some((t) => t === SEED_TITLE || t.startsWith("Conversación")), theirs);
    const r = await p.goto(`${BASE}/dashboard/audio-studio/${ownerProjectId}`);
    check("[aislamiento] abrir el proyecto ajeno por URL da 404", r?.status() === 404, r?.status());
    const api = await p.evaluate(async (id) => {
      const get = await fetch(`/api/audio-studio/projects/${id}`); const put = await fetch(`/api/audio-studio/projects/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: 1, title: "robado" }) });
      const act = await fetch(`/api/audio-studio/projects/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "archivar" }) });
      const trav = await fetch(`/api/audio-studio/projects/..%2F..%2F11111111-1111-4111-8111-111111111111%2F${id}`);
      return [get.status, put.status, act.status, trav.status];
    }, ownerProjectId);
    check("[aislamiento] API: leer, editar y archivar ajeno → 404; ruta con ../ → 404", api.every((s) => s === 404), api);
    if (ownerAudioId) {
      const a = await p.request.get(`${BASE}/api/audio-studio/projects/${ownerAudioId}/audio?descargar=1`, { maxRedirects: 0 });
      check("[aislamiento] el MP3 del dueño no se puede descargar desde otra cuenta (404)", a.status() === 404, a.status());
      const g = await p.evaluate(async (id) => (await fetch(`/api/audio-studio/projects/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "remezclar", revision: 1 }) })).status, ownerAudioId);
      check("[aislamiento] remezclar/generar proyecto ajeno → 404", g === 404, g);
    }
    const csrf = await p.evaluate(async () => (await fetch("/api/audio-studio/projects", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ title: "csrf" }) })).status);
    check("[seguridad] POST que no es JSON (formulario de otro sitio) → 415", csrf === 415, csrf);
    await ctx.close();
    // Sin sesión: la API responde 401.
    const anon = await browser.newContext(); const ap = await anon.newPage();
    const s = await ap.request.get(`${BASE}/api/audio-studio/projects`); check("[seguridad] API sin sesión → 401", s.status() === 401, s.status());
    const sp = await ap.goto(`${BASE}/dashboard/audio-studio`); check("[seguridad] página sin sesión redirige a /login", /\/login/.test(ap.url()), [sp?.status(), ap.url()]);
    await anon.close();
  } finally { await browser.close(); }

  // 10. Nada se borró ni cambió fuera del prefijo del módulo; ninguna salida a proveedores reales.
  const filesAfter = listFiles(STORAGE).filter((f) => !f.startsWith("videos/audio-studio/"));
  if (STORAGE) check("[datos] ningún archivo previo del Storage local borrado (fuera de audio-studio)", filesBefore.every((f) => filesAfter.includes(f)), filesBefore.filter((f) => !filesAfter.includes(f)).slice(0, 5));
  const studioFiles = listFiles(STORAGE).filter((f) => f.startsWith("videos/audio-studio/v1/"));
  const okPath = (f) => /^videos\/audio-studio\/v1\/[0-9a-f-]{36}\/[0-9a-f-]{36}(\.json|\/tts\/[0-9a-f]{64}\.mp3|\/audio\/[\w.-]+\.mp3)$/.test(f);
  if (STORAGE) check("[datos] proyectos, voz en caché y MP3 solo bajo videos/audio-studio/v1/<cuenta>/<proyecto>", studioFiles.length >= 3 && studioFiles.every(okPath), studioFiles.filter((f) => !okPath(f)).slice(0, 5));
  const newEgress = egressLines().slice(egressBefore);
  check("[costo] ninguna salida a proveedores reales durante el recorrido", !newEgress.some((l) => /elevenlabs|heygen|openai|anthropic|recraft|fal\.|pexels|supabase\.co|stripe/i.test(l)), newEgress.slice(0, 5));
  console.log(`RESULTADO ${fails === 0 ? "OK" : "FALLA"}  ${passes} PASS · ${fails} FAIL`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.log("FAIL  excepción", e?.stack ?? e); console.log(`RESULTADO FALLA  ${passes} PASS · ${fails + 1} FAIL`); process.exit(1); });
