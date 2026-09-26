/**
 * Validación con SESIÓN REAL (navegador + despliegue + Supabase + workers):
 * recorre la app como una usuaria, no llama funciones internas.
 *
 * AISLAMIENTO: no es un entorno aislado. Usa el despliegue indicado en
 * BASE_URL y el proyecto Supabase de NEXT_PUBLIC_SUPABASE_URL (en este
 * repositorio, el mismo secret que usan render.yml y las migraciones), la
 * misma cuenta de ElevenLabs y la misma cuota. Por eso solo actúa sobre lo
 * que ESTA ejecución crea, identificado de forma inequívoca:
 *  - cada pieza o voz se correlaciona por (usuaria, client_request_id): el
 *    id que el servidor genera al abrir el formulario y que el script lee
 *    del propio formulario antes de enviarlo; nunca «la más reciente»;
 *  - la voz clonada es temporal («Prueba temporal <RUN>») y solo se elimina
 *    por su id exacto, desde el formulario cuyo voice_id es ese id;
 *  - antes de gastar, exige que las cuentas de prueba A y B no tengan voces
 *    propias: si tienen alguna (p. ej. una voz personal que se quiera
 *    conservar), se detiene sin tocarla;
 *  - al final limpia SOLO los ids creados en esta ejecución.
 *
 * Etapas (SESSION_STAGES, separadas por comas):
 *  - free     (sin gasto): inicio de sesión, menú, secciones, cinco voces,
 *             Tatiana deshabilitada en inglés, móvil/escritorio.
 *  - tts      (PAGO, ~190 caracteres): doble clic → una sola pieza; estado,
 *             historial, reproducción, descarga MP3; voz efectiva en el
 *             proveedor; reintento tras un fallo simulado sin nuevo gasto.
 *  - myvoice  (PAGO: 1 clonación + ~85 + ~75 caracteres): muestra
 *             autorizada (VOICE_SAMPLE_PATH), estados hasta «Lista», prueba
 *             corta, pieza con texto distinto; B no puede ver, usar ni
 *             eliminar la voz de A (obligatorio: exige B en la lista del
 *             piloto); A elimina su voz temporal y los audios siguen
 *             descargables.
 * Un paso que no se puede comprobar queda PENDIENTE (nunca aprobado) y la
 * ejecución no termina en verde. Las etapas pagas exigen SESSION_ALLOW_PAID=true.
 * Nada se reintenta solo.
 *
 * Variables: BASE_URL, USER_A_EMAIL/USER_A_PASSWORD, USER_B_EMAIL/USER_B_PASSWORD,
 * USER_B_ALLOWLISTED, NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 * (lectura de comprobación y para simular un fallo), VOICE_SAMPLE_PATH y
 * B_SHORT_SAMPLE_PATH (etapa myvoice).
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Falta ${k}`);
  return v;
};
const BASE = env("BASE_URL").replace(/\/$/, "");
const STAGES = new Set((process.env.SESSION_STAGES ?? "free").split(",").map((s) => s.trim()).filter(Boolean));
const PAID = process.env.SESSION_ALLOW_PAID === "true";
if ((STAGES.has("tts") || STAGES.has("myvoice")) && !PAID) throw new Error("Las etapas tts/myvoice gastan: exigen SESSION_ALLOW_PAID=true.");
const service = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const RUN = new Date().toISOString().replace(/[:.]/g, "-");
const results = [];
/** Ids que ESTA ejecución creó (lo único que la limpieza puede tocar). */
const created = { voices: [], jobs: [] };

const step = async (name, fn) => {
  try {
    await fn();
    results.push({ name, status: "ok" });
    console.log(`✔ ${name}`);
  } catch (err) {
    results.push({ name, status: "failed", error: err instanceof Error ? err.message : String(err) });
    console.log(`✖ ${name}: ${err instanceof Error ? err.message : err}`);
    throw err;
  }
};
const pending = (name, reason) => {
  results.push({ name, status: "pending", reason });
  console.log(`… PENDIENTE ${name}: ${reason}`);
};

async function login(browser, email, password) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([page.waitForURL(/\/dashboard/, { timeout: 30000 }), page.click('button[type="submit"]')]);
  return { context, page };
}

async function userId(email) {
  const { data, error } = await service.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  const user = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (!user) throw new Error(`No existe la cuenta de prueba ${email}`);
  return user.id;
}

async function waitFor(fn, what, timeoutMs = 8 * 60 * 1000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Tiempo agotado esperando: ${what}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

/** client_request_id que el servidor puso en el formulario abierto (correlación exacta). */
async function formRequestId(page, formLocator) {
  const id = await formLocator.locator('input[name="client_request_id"]').inputValue();
  assert.match(id, /^[0-9a-f-]{36}$/i, "el formulario trae client_request_id");
  return id.toLowerCase();
}

async function rowsByRequest(table, owner, clientRequestId) {
  const { data, error } = await service.from(table).select("*").eq("user_id", owner).eq("client_request_id", clientRequestId);
  if (error) throw new Error(`No se pudo leer ${table}: ${error.message}`);
  return data ?? [];
}

async function voiceById(id) {
  const { data } = await service.from("user_voices").select("*").eq("id", id).maybeSingle();
  return data;
}

async function activeVoices(owner) {
  const { data, error } = await service.from("user_voices").select("id, name, status").eq("user_id", owner).neq("status", "deleted");
  if (error) throw new Error(`No se pudo leer user_voices: ${error.message}`);
  return data ?? [];
}

/** Formulario (y botón) de la tarjeta cuyo voice_id es EXACTAMENTE `id`. */
const voiceForm = (page, id, button) => page.locator(`form:has(input[name="voice_id"][value="${id}"])`).filter({ has: page.getByRole("button", { name: button }) });

/** Descarga por la URL firmada del enlace y comprueba que es un MP3 con nombre de archivo. */
async function checkDownload(page, title) {
  const card = page.locator("li", { hasText: title });
  assert.equal(await card.count(), 1, `una sola tarjeta «${title}»`);
  const href = await card.getByRole("link", { name: "Descargar MP3" }).getAttribute("href");
  assert.ok(href, "hay enlace de descarga");
  const res = await fetch(href);
  assert.equal(res.status, 200, "descarga 200");
  assert.match(res.headers.get("content-disposition") ?? "", /attachment;.*\.mp3/);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.ok(bytes.length > 5000, "MP3 con contenido");
  assert.ok((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) || bytes[0] === 0xff, "cabecera MP3");
  const src = await card.locator("audio").getAttribute("src");
  assert.equal((await fetch(src, { headers: { Range: "bytes=0-1" } })).ok, true, "el reproductor carga el audio");
}

async function voiceIdsUsed(jobId) {
  const { data } = await service.storage.from("videos").list(`tts/${jobId}/state/voice`, { limit: 100 });
  const ids = new Set();
  for (const f of data ?? []) {
    const file = await service.storage.from("videos").download(`tts/${jobId}/state/voice/${f.name}`);
    if (file.data) ids.add(JSON.parse(await file.data.text()).identity?.voice?.voiceId);
  }
  return [...ids];
}

async function ledgerEntries(prefix) {
  const file = await service.storage.from("videos").download(`${prefix}/state/paid-ledger.json`);
  return file.data ? JSON.parse(await file.data.text()).entries : [];
}

/** Crea una pieza desde el formulario y devuelve SU fila, correlacionada por client_request_id. */
async function createPiece(page, owner, { title, script, voiceValue, doubleClick = false }) {
  await page.goto(`${BASE}/dashboard/tts`);
  const form = page.locator("form", { has: page.locator("#tts-script") });
  const requestId = await formRequestId(page, form);
  await page.fill("#tts-title", title);
  await page.fill("#tts-script", script);
  await page.locator(`input[name="voice_choice"][value="${voiceValue}"]`).check();
  const submit = page.getByRole("button", { name: "Generar audio" });
  if (doubleClick) await submit.dblclick();
  else await submit.click();
  await page.waitForURL(/\/dashboard\/tts/, { timeout: 30000 });
  const rows = await waitFor(async () => {
    const r = await rowsByRequest("tts_jobs", owner, requestId);
    return r.length ? r : null;
  }, "fila de la pieza", 60000);
  for (const r of rows) created.jobs.push(r.id);
  return { requestId, rows };
}

async function jobStatus(id) {
  return (await service.from("tts_jobs").select("status, error_message").eq("id", id).single()).data;
}

/** Sube una muestra desde el formulario de Mi voz y devuelve la fila de ESA voz (por client_request_id). */
async function createVoice(page, owner, { name, samplePath, bypassDuration = false }) {
  await page.goto(`${BASE}/dashboard/voices`);
  const form = page.locator("form", { has: page.locator('input[name="sample"]') });
  const requestId = await formRequestId(page, form);
  await page.fill("#voice-name", name);
  await page.setInputFiles('input[name="sample"]', samplePath);
  await page.check('input[name="consent_own_voice"]');
  await page.check('input[name="consent_processing"]');
  if (bypassDuration) {
    // Muestra de 5 s: el navegador la marcaría como corta; se envía igual para que el worker la rechace por
    // duración ANTES de clonar (sin gasto) y la cuenta quede con una tarjeta propia con formulario «Eliminar».
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      document.querySelector('input[name="client_seconds"]').value = "";
      const button = [...document.querySelectorAll('button[type="submit"]')].find((b) => b.textContent.includes("Crear mi voz"));
      button.removeAttribute("disabled");
    });
  }
  await page.getByRole("button", { name: "Crear mi voz" }).click();
  const row = await waitFor(async () => (await rowsByRequest("user_voices", owner, requestId))[0], "fila de la voz", 60000);
  created.voices.push({ id: row.id, ownerPage: page });
  return row;
}

/** Elimina desde la UI SOLO la voz con ese id exacto. */
async function deleteVoiceById(page, id) {
  await page.goto(`${BASE}/dashboard/voices`);
  const form = voiceForm(page, id, "Eliminar voz y grabaciones");
  assert.equal(await form.count(), 1, `formulario de eliminación de ${id}`);
  await form.getByRole("button", { name: "Eliminar voz y grabaciones" }).click();
  await waitFor(async () => (await voiceById(id))?.status === "deleted", `voz ${id} eliminada`, 120000);
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const A = { email: env("USER_A_EMAIL"), password: env("USER_A_PASSWORD") };
const B = { email: env("USER_B_EMAIL"), password: env("USER_B_PASSWORD") };
const bAllowlisted = process.env.USER_B_ALLOWLISTED === "true";
let exitCode = 0;
let a;
try {
  const aId = await userId(A.email);
  const bId = await userId(B.email);
  a = await login(browser, A.email, A.password);
  const b = await login(browser, B.email, B.password);

  if (STAGES.has("myvoice")) {
    // Antes de gastar nada: la etapa solo corre con cuentas de prueba SIN voces propias y con B en la lista.
    await step("preparación Mi voz: A y B sin voces propias; B en la lista del piloto", async () => {
      const aVoices = await activeVoices(aId);
      const bVoices = await activeVoices(bId);
      assert.equal(aVoices.length, 0, `A tiene voces propias (${aVoices.map((v) => v.id).join(", ")}): esta prueba no las toca; usa una cuenta de prueba sin voces`);
      assert.equal(bVoices.length, 0, `B tiene voces propias (${bVoices.map((v) => v.id).join(", ")}): usa una cuenta de prueba sin voces`);
      assert.ok(bAllowlisted, "B debe estar en MY_VOICE_ALLOWLIST para la prueba de eliminación ajena");
      assert.equal((await b.page.goto(`${BASE}/dashboard/voices`)).status(), 200, "B abre Mi voz");
    });
  }

  if (STAGES.has("free")) {
    await step("A: menú con Texto a voz y Mi voz (móvil)", async () => {
      await a.page.goto(`${BASE}/dashboard`);
      assert.ok(await a.page.getByRole("link", { name: "Texto a voz" }).first().isVisible());
      assert.ok(await a.page.getByRole("link", { name: "Mi voz" }).first().isVisible());
    });
    await step("A: cinco voces y Tatiana deshabilitada en inglés", async () => {
      await a.page.goto(`${BASE}/dashboard/tts`);
      for (const v of ["mateo", "miguel", "mauricio", "norah", "tatiana"]) assert.equal(await a.page.locator(`input[value="${v}"]`).count(), 1, v);
      await a.page.selectOption("#tts-language", "en");
      assert.equal(await a.page.locator('input[value="tatiana"]').isDisabled(), true);
    });
    if (bAllowlisted) pending("cuenta fuera de la lista no accede a Mi voz", "B está en la lista del piloto; hace falta una cuenta fuera de la lista para comprobarlo");
    else
      await step("B (fuera de la lista): Mi voz no disponible", async () => {
        assert.equal((await b.page.goto(`${BASE}/dashboard/voices`)).status(), 404);
      });
    await step("móvil y escritorio: sin desbordes en Texto a voz", async () => {
      for (const width of [1280, 390]) {
        await a.page.setViewportSize({ width, height: 900 });
        await a.page.goto(`${BASE}/dashboard/tts`);
        assert.equal(await a.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0, `ancho ${width}`);
      }
    });
  }

  let firstPiece;
  if (STAGES.has("tts")) {
    const title = `Validación ${RUN}`;
    const script =
      "Esta es una prueba breve de Texto a voz en Atomivid.\n\nEl segundo párrafo comprueba la pausa entre párrafos y que la voz elegida sea la misma de principio a fin.";
    await step("A: doble clic en «Generar» crea una sola pieza (misma client_request_id)", async () => {
      const { rows } = await createPiece(a.page, aId, { title, script, voiceValue: "miguel", doubleClick: true });
      await new Promise((r) => setTimeout(r, 3000));
      assert.equal(rows.length, 1);
      firstPiece = { id: rows[0].id, title };
    });
    await step("A: la pieza llega a «Listo» y aparece en el historial", async () => {
      await waitFor(async () => (await jobStatus(firstPiece.id))?.status === "completed", "pieza lista");
      await a.page.goto(`${BASE}/dashboard/tts`);
      assert.equal(await a.page.locator("li", { hasText: title }).getByText("Listo").count(), 1);
    });
    await step("A: reproducción y descarga MP3", () => checkDownload(a.page, title));
    await step("la voz elegida (Miguel) llegó al proveedor", async () => {
      assert.deepEqual(await voiceIdsUsed(firstPiece.id), ["k8cFOyAg7B9qwBlDDNTC"]);
    });
    await step("recuperación: reintento tras un fallo simulado sin volver a pagar", async () => {
      const before = await ledgerEntries(`tts/${firstPiece.id}`);
      await service.from("tts_jobs").update({ status: "failed", error_message: "Fallo simulado por la validación." }).eq("id", firstPiece.id);
      await a.page.goto(`${BASE}/dashboard/tts`);
      await a.page.locator(`form:has(input[name="job_id"][value="${firstPiece.id}"])`).getByRole("button", { name: "Reintentar" }).click();
      await waitFor(async () => (await jobStatus(firstPiece.id))?.status === "completed", "reintento completado");
      assert.equal((await ledgerEntries(`tts/${firstPiece.id}`)).length, before.length, "sin nuevas operaciones pagadas: fragmentos reutilizados");
    });
  }

  if (STAGES.has("myvoice")) {
    let voice;
    await step("A: sube la muestra autorizada con consentimiento; la voz temporal llega a «Lista»", async () => {
      const row = await createVoice(a.page, aId, { name: `Prueba temporal ${RUN}`.slice(0, 40), samplePath: env("VOICE_SAMPLE_PATH") });
      voice = await waitFor(async () => {
        const current = await voiceById(row.id);
        if (current?.status === "failed") throw new Error(`La clonación falló: ${current.error_message}`);
        return current?.status === "ready" ? current : null;
      }, "voz lista", 10 * 60 * 1000);
      await a.page.goto(`${BASE}/dashboard/voices`);
      const card = a.page.locator("li", { has: a.page.locator(`input[name="voice_id"][value="${voice.id}"]`) });
      const src = await card.locator("audio").getAttribute("src");
      assert.ok(src && (await fetch(src)).ok, "prueba corta reproducible");
    });
    const customTitle = `Mi voz ${RUN}`;
    await step("A: pieza con su voz temporal y un texto distinto al de la prueba", async () => {
      const { rows } = await createPiece(a.page, aId, { title: customTitle, script: "Hoy pruebo mi propia voz con un texto nuevo, distinto de la frase de prueba.", voiceValue: `custom:${voice.id}` });
      await waitFor(async () => (await jobStatus(rows[0].id))?.status === "completed", "pieza con Mi voz");
      assert.deepEqual(await voiceIdsUsed(rows[0].id), [voice.provider_voice_id]);
    });
    await step("B: no ve la voz de A y no puede usarla enviando su id", async () => {
      await b.page.goto(`${BASE}/dashboard/tts`);
      assert.equal(await b.page.locator(`input[value="custom:${voice.id}"]`).count(), 0);
      const form = b.page.locator("form", { has: b.page.locator("#tts-script") });
      const requestId = await formRequestId(b.page, form);
      await b.page.fill("#tts-title", `Intrusión ${RUN}`);
      await b.page.fill("#tts-script", "Intento de usar una voz ajena.");
      await b.page.evaluate((id) => {
        document.querySelector('input[name="voice_choice"][value="mateo"]').value = `custom:${id}`;
      }, voice.id);
      await b.page.getByRole("button", { name: "Generar audio" }).click();
      await b.page.waitForURL(/error=/, { timeout: 30000 });
      assert.match(decodeURIComponent(b.page.url()), /no existe o no es tuya/);
      assert.equal((await rowsByRequest("tts_jobs", bId, requestId)).length, 0, "no se creó ninguna pieza");
    });
    await step("B: no puede eliminar la voz de A cambiando el id en su propio formulario", async () => {
      const bVoice = await createVoice(b.page, bId, { name: `B corta ${RUN}`.slice(0, 40), samplePath: env("B_SHORT_SAMPLE_PATH"), bypassDuration: true });
      const rejected = await waitFor(async () => {
        const current = await voiceById(bVoice.id);
        return current?.status === "failed" ? current : null;
      }, "voz corta de B rechazada antes de clonar", 5 * 60 * 1000);
      assert.equal(rejected.provider_voice_id, null, "la muestra corta no llegó a clonarse");
      await b.page.goto(`${BASE}/dashboard/voices`);
      const form = voiceForm(b.page, bVoice.id, "Eliminar voz y grabaciones");
      assert.equal(await form.count(), 1);
      await form.evaluate((el, id) => {
        el.querySelector('input[name="voice_id"]').value = id;
      }, voice.id);
      await form.getByRole("button", { name: "Eliminar voz y grabaciones" }).click();
      await b.page.waitForURL(/error=/, { timeout: 30000 });
      assert.match(decodeURIComponent(b.page.url()), /no existe o no es tuya/);
      assert.equal((await voiceById(voice.id))?.status, "ready", "la voz de A sigue intacta");
      await deleteVoiceById(b.page, bVoice.id);
    });
    await step("A: elimina SOLO su voz temporal por id; los audios generados siguen descargables", async () => {
      await deleteVoiceById(a.page, voice.id);
      await a.page.goto(`${BASE}/dashboard/tts`);
      await checkDownload(a.page, customTitle);
      if (firstPiece) await checkDownload(a.page, firstPiece.title);
      assert.equal((await activeVoices(aId)).length, 0, "A queda sin voces: no se tocó ninguna otra");
    });
  }
} catch {
  exitCode = 1;
} finally {
  // Limpieza: SOLO voces creadas por esta ejecución que sigan activas, por id exacto.
  for (const { id, ownerPage } of created.voices) {
    const current = await voiceById(id).catch(() => null);
    if (!current || current.status === "deleted") continue;
    try {
      await deleteVoiceById(ownerPage, id);
      console.log(`limpieza: voz temporal ${id} eliminada`);
    } catch (err) {
      pending(`limpieza de la voz temporal ${id}`, `eliminarla a mano desde Mi voz (estado ${current.status}): ${err instanceof Error ? err.message : err}`);
    }
  }
  await browser.close();
  await fs.mkdir("evidence/session", { recursive: true });
  await fs.writeFile("evidence/session/results.json", JSON.stringify({ run: RUN, base: BASE, stages: [...STAGES], created, results }, null, 2));
  const count = (s) => results.filter((r) => r.status === s).length;
  console.log(`\n${count("ok")} correctos · ${count("failed")} fallidos · ${count("pending")} pendientes`);
  // Un pendiente no es un aprobado: la ejecución no termina en verde.
  if (!exitCode && count("pending") > 0) exitCode = 2;
  process.exit(exitCode);
}
