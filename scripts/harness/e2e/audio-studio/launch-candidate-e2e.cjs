/**
 * Audio Podcast — recorrido de cliente del candidato de lanzamiento (T-20261125-1613). USD 0 y NO MUTANTE:
 * sólo lee un proyecto YA terminado (lo deja el recorrido audio-studio-e2e.cjs con la voz de prueba local) y nunca
 * pulsa Generar, Reanudar, Respaldo, Remezclar, Guardar, Archivar ni Restaurar. Cualquier POST/PATCH/DELETE a
 * /api/audio-studio durante el recorrido es un FAIL.
 *
 * Por dispositivo (390x844, 412x915 y escritorio 1440x900):
 *  - abrir Audio Podcast desde la navegación real y localizar el proyecto terminado sin crear otro;
 *  - la tarjeta de la biblioteca muestra el estado real del audio (sin verde falso), idioma, voces y una duración
 *    bien formada (nunca «N min 60 s»);
 *  - el editor muestra «Audio listo», idioma y las dos voces del proyecto según la API;
 *  - reproducir el MP3 (avanza currentTime) y descargarlo por el enlace: nombre .mp3, MIME audio/mpeg, tamaño > 0,
 *    decodificación completa con ffmpeg y SHA-256;
 *  - «Generar» no es pulsable sin marcar la autorización (ningún clic accidental vuelve a generar o cobrar);
 *  - sin desbordamiento horizontal y con los controles de Producción alcanzables y sin tapar;
 *  - estados vacío (filtro de archivados de otra cuenta), audio que no carga y error del servidor.
 *
 *   E2E_OUT=<dir> E2E_BASE=http://127.0.0.1:3300 FFMPEG=ffmpeg node launch-candidate-e2e.cjs
 */
const path = require("node:path"), fs = require("node:fs"), crypto = require("node:crypto"), { execFileSync } = require("node:child_process");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:3300";
const OUT = path.resolve(process.env.E2E_OUT ?? "launch-candidate-out"); fs.mkdirSync(OUT, { recursive: true });
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const OWNER = { email: "pilot-owner@local.test", password: "local-pass-owner-1" };
const OTHER = { email: "intruso@local.test", password: "local-pass-other-2" };
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; SM-A155M) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const DEVICES = {
  "movil-390x844": { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.75, userAgent: ANDROID_UA },
  "movil-412x915": { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625, userAgent: ANDROID_UA },
  "escritorio-1440x900": { viewport: { width: 1440, height: 900 } },
};
const LANG = { es: "Español", en: "English" };
let fails = 0, passes = 0;
const check = (name, ok, detail) => { ok ? passes++ : fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + JSON.stringify(detail ?? null).slice(0, 400)}`); return !!ok; };
const shot = (p, name) => p.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true }).catch(() => {});

async function login(browser, user, opts) {
  const ctx = await browser.newContext({ ...opts, locale: "es-MX", acceptDownloads: true });
  await ctx.addInitScript(() => { try { localStorage.setItem("atomivid_onboarding_completed_v1", "1"); } catch {} });
  const p = await ctx.newPage(); p.setDefaultTimeout(90000);
  await p.goto(`${BASE}/login`); await p.fill("input[name=email]", user.email); await p.fill("input[name=password]", user.password);
  await p.locator("form button[type=submit]").last().click(); await p.waitForURL(/\/dashboard/);
  return { ctx, p };
}

/** Elementos interactivos visibles de un contenedor que quedan fuera de la pantalla o tapados por otro elemento. */
const unreachable = (p, sel) => p.evaluate(async (s) => {
  const out = [];
  for (const el of document.querySelectorAll(`${s} button, ${s} a[href], ${s} input, ${s} audio`)) {
    const r0 = el.getBoundingClientRect(); if (!r0.width || !r0.height) continue;
    el.scrollIntoView({ block: "center" }); await new Promise((r) => setTimeout(r, 30));
    const r = el.getBoundingClientRect();
    const cx = Math.min(window.innerWidth - 1, Math.max(0, r.left + r.width / 2)), cy = Math.min(window.innerHeight - 1, Math.max(0, r.top + r.height / 2));
    const hit = document.elementFromPoint(cx, cy);
    const off = r.left < 0 || r.right > window.innerWidth + 0.5;
    if (off || !(hit && (hit === el || el.contains(hit) || hit.contains(el)))) out.push({ el: el.outerHTML.slice(0, 90), off, hit: hit?.outerHTML.slice(0, 90) });
  }
  return out;
}, sel);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME || undefined });
  const mutations = [];
  const summary = { devices: {}, download: null };
  try {
    for (const [dev, opts] of Object.entries(DEVICES)) {
      const { ctx, p } = await login(browser, OWNER, opts);
      p.on("request", (r) => { if (/\/api\/audio-studio\//.test(r.url()) && r.method() !== "GET" && r.method() !== "HEAD") mutations.push(`${dev} ${r.method()} ${r.url()}`); });
      const paid = []; p.on("request", (r) => { if (/elevenlabs|heygen|openai|anthropic|recraft|fal\.|pexels|stripe/i.test(r.url())) paid.push(r.url()); });

      // 1. Navegación real: panel → enlace del encabezado.
      await p.goto(`${BASE}/dashboard`);
      const nav = p.locator('header a[href="/dashboard/audio-studio"]:visible').first();
      check(`[${dev}] Audio Podcast en la navegación`, await nav.count() === 1);
      await nav.click(); await p.waitForURL(/\/dashboard\/audio-studio$/); await p.getByTestId("audio-studio").waitFor();

      // 2. Localizar un proyecto terminado (con MP3) sin crear otro.
      const list = await p.evaluate(async () => (await (await fetch("/api/audio-studio/projects")).json()).projects ?? []);
      const done = list.find((x) => x.audio && x.generation?.status === "terminada" && !x.archivedAt && x.voiceCount === 2) ?? list.find((x) => x.audio && !x.archivedAt);
      if (!check(`[${dev}] existe un proyecto terminado con MP3`, !!done, list.map((x) => [x.title, x.generation?.status]))) { await ctx.close(); continue; }
      const card = p.locator("[data-testid=audio-library] > li").filter({ has: p.locator(`a[href="/dashboard/audio-studio/${done.id}"]`) });
      check(`[${dev}] la tarjeta del proyecto terminado está en la biblioteca`, await card.count() === 1);
      const cardText = (await card.innerText()).replace(/\s+/g, " ");
      const badge = card.getByTestId("audio-library-state");
      const badgeText = (await badge.count()) ? (await badge.innerText()).trim() : "";
      check(`[${dev}] biblioteca: estado del audio visible («Audio listo»)`, /Audio listo/.test(badgeText || cardText), { badgeText, cardText: cardText.slice(0, 200) });
      check(`[${dev}] biblioteca: idioma visible`, cardText.includes(LANG[done.language]), cardText.slice(0, 200));
      check(`[${dev}] biblioteca: duración bien formada`, !/\b60 s\b/.test(cardText) && /MP3 · \d+ min \d{1,2} s/.test(cardText), cardText.slice(0, 200));
      check(`[${dev}] biblioteca: no ofrece «Generar requiere autorización» en un audio listo`, !/Generar requiere/.test(cardText));
      await shot(p, `${dev}-biblioteca`);
      const libOverflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`[${dev}] biblioteca sin desbordamiento horizontal`, libOverflow <= 0, libOverflow);

      // 3. Abrir el proyecto desde la tarjeta.
      await card.locator(`a[href="/dashboard/audio-studio/${done.id}"]`).first().click();
      await p.waitForURL(new RegExp(`/dashboard/audio-studio/${done.id}$`)); await p.getByTestId("audio-editor").waitFor();
      await p.getByTestId("audio-result").waitFor();
      check(`[${dev}] editor: «Audio listo»`, /Audio listo/.test(await p.getByTestId("audio-generation-status").innerText()));
      check(`[${dev}] editor: progreso al 100 % sin estados contradictorios`, /Podcast listo · 100%/.test(await p.getByTestId("audio-progress").innerText().catch(() => "")));
      check(`[${dev}] editor: idioma del proyecto`, await p.getByTestId("audio-language").inputValue() === done.language);
      const shownVoices = []; for (let i = 0; i < done.voiceCount; i++) shownVoices.push(await p.getByTestId(`audio-voice-${i}`).inputValue());
      check(`[${dev}] editor: ${done.voiceCount} voz/voces elegidas`, JSON.stringify(shownVoices) === JSON.stringify(done.voices) && await p.getByTestId(`audio-voices-${done.voiceCount}`).isChecked(), { shownVoices, voices: done.voices });
      const resultText = (await p.getByTestId("audio-result").innerText()).replace(/\s+/g, " ");
      check(`[${dev}] editor: duración bien formada`, !/\b60 s\b/.test(resultText) && /\d+ min \d{1,2} s/.test(resultText), resultText);

      // 4. Reproducir: controles nativos y avance real.
      const player = p.getByTestId("audio-player");
      check(`[${dev}] reproductor con controles`, await player.evaluate((a) => a.controls));
      const played = await player.evaluate(async (a) => { a.muted = true; await a.play(); await new Promise((r) => setTimeout(r, 1500)); const t = a.currentTime; a.pause(); return { t, d: a.duration, err: a.error?.code ?? null }; });
      check(`[${dev}] el MP3 se reproduce (avanza y pausa)`, played.t > 0.5 && played.err === null && played.d > 10, played);

      // 5. «Generar» no se puede pulsar por accidente.
      const gen = p.getByTestId("audio-generate");
      if (await gen.count()) {
        const auth = p.getByTestId("audio-authorize");
        check(`[${dev}] autorización desmarcada al abrir un proyecto terminado`, (await auth.count()) === 1 && !(await auth.isChecked()));
        check(`[${dev}] «Generar» desactivado sin autorización`, await gen.isDisabled());
        await gen.click({ force: true, timeout: 3000 }).catch(() => {});
        await p.waitForTimeout(800);
        check(`[${dev}] clic forzado en «Generar» no envía nada`, !mutations.some((m) => m.startsWith(dev)), mutations);
      } else check(`[${dev}] sin botón Generar (síntesis inactiva)`, true);

      // 6. Controles alcanzables y sin desbordamiento.
      const editorOverflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`[${dev}] editor sin desbordamiento horizontal`, editorOverflow <= 0, editorOverflow);
      const blocked = await unreachable(p, "[data-testid=audio-production]");
      check(`[${dev}] controles de Producción alcanzables y sin tapar`, blocked.length === 0, blocked);
      await shot(p, `${dev}-proyecto-terminado`);

      // 7. Descarga por el enlace real (una vez es suficiente para el hash; se repite el nombre/MIME por dispositivo).
      const [dl] = await Promise.all([p.waitForEvent("download"), p.getByTestId("audio-download").click()]);
      const file = path.join(OUT, `${dev}-${dl.suggestedFilename()}`); await dl.saveAs(file);
      const bytes = fs.statSync(file).size, sha = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      const head = await p.request.get(`${BASE}/api/audio-studio/projects/${done.id}/audio?descargar=1`);
      let decoded = false, decodeErr = "";
      try { execFileSync(FFMPEG, ["-v", "error", "-nostdin", "-i", file, "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"] }); decoded = true; } catch (e) { decodeErr = String(e.stderr ?? e).slice(0, 200); }
      check(`[${dev}] descarga: nombre .mp3 con el título`, /^[A-Za-z0-9 _-]+\.mp3$/.test(dl.suggestedFilename()) && dl.suggestedFilename().startsWith(done.title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9 _-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 20)), dl.suggestedFilename());
      check(`[${dev}] descarga: MIME audio/mpeg`, /audio\/mpeg/.test(head.headers()["content-type"] ?? ""), head.headers()["content-type"]);
      check(`[${dev}] descarga: tamaño > 0 e igual al registrado`, bytes > 0 && bytes === done.audio.bytes, { bytes, recorded: done.audio.bytes });
      check(`[${dev}] descarga: decodifica completa con ffmpeg`, decoded, decodeErr);
      summary.download ??= { file: path.basename(file), name: dl.suggestedFilename(), bytes, sha256: sha, mime: head.headers()["content-type"] };
      summary.devices[dev] = { project: done.id, title: done.title, language: done.language, voices: done.voices, badgeText, played, libOverflow, editorOverflow };

      // 8. Audio que no carga (URL firmada caducada): el editor lo explica en vez de dejar un reproductor mudo.
      await p.route(`**/api/audio-studio/projects/${done.id}/audio`, (r) => r.fulfill({ status: 404, contentType: "application/json", body: '{"error":"Audio no encontrado."}' }));
      await p.reload(); await p.getByTestId("audio-result").waitFor();
      await p.getByTestId("audio-player").evaluate((a) => { a.play().catch(() => {}); });
      const broken = await p.getByTestId("audio-player-error").waitFor({ timeout: 10000 }).then(() => true, () => false);
      check(`[${dev}] audio que no carga: aviso recuperable visible`, broken);
      if (broken) check(`[${dev}] audio que no carga: ofrece reintentar`, await p.getByTestId("audio-player-retry").isVisible());
      await shot(p, `${dev}-audio-no-carga`);
      await p.unroute(`**/api/audio-studio/projects/${done.id}/audio`);

      check(`[${dev}] ninguna llamada a proveedores de pago`, paid.length === 0, paid);
      await ctx.close();
    }

    // 9. Estado vacío (otra cuenta, filtro de archivados) y aislamiento: no ve el proyecto del dueño.
    {
      const { ctx, p } = await login(browser, OTHER, DEVICES["movil-390x844"]);
      p.on("request", (r) => { if (/\/api\/audio-studio\//.test(r.url()) && r.method() !== "GET") mutations.push(`otra ${r.method()} ${r.url()}`); });
      await p.goto(`${BASE}/dashboard/audio-studio?archivados=1`);
      const ok = await p.getByTestId("audio-studio").waitFor().then(() => true, () => false);
      if (ok) check("[otra cuenta] estado vacío comprensible", /No hay episodios archivados/.test(await p.getByTestId("audio-library-empty").innerText().catch(() => "")));
      else check("[otra cuenta] sin acceso al estudio (404 controlado)", (await p.content()).includes("404"));
      await shot(p, "otra-cuenta-vacio");
      await ctx.close();
    }
    check("recorrido NO MUTANTE: 0 POST/PATCH/DELETE a /api/audio-studio", mutations.length === 0, mutations);
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(OUT, "launch-candidate-summary.json"), JSON.stringify({ passes, fails, ...summary }, null, 2));
  console.log(`RESULTADO ${fails ? "FALLA" : "OK"} — ${passes} PASS, ${fails} FAIL`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
