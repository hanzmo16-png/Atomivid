/**
 * Validación con SESIÓN REAL (navegador + despliegue + Supabase + workers):
 * recorre la app como una usuaria, no llama funciones internas. Pensada
 * para un despliegue de prueba (Preview) con la migración 0021 aplicada,
 * los flags encendidos solo en ese entorno y dos cuentas de prueba.
 *
 * Etapas (SESSION_STAGES, separadas por comas):
 *  - free     (sin gasto): inicio de sesión, menú, secciones, cinco voces,
 *             Tatiana deshabilitada en inglés, privacidad de B frente a A
 *             (no ve ni puede usar la voz privada de A enviando su id).
 *  - tts      (PAGO, ~400 caracteres): pieza corta con doble clic en
 *             «Generar» → una sola fila; estado, historial, reproducción y
 *             descarga MP3; la voz elegida llegó al proveedor (registro de
 *             caché); reintento tras un fallo simulado sin nuevo gasto.
 *  - myvoice  (PAGO: 1 clonación + ~85 caracteres de prueba + ~300 de
 *             pieza): muestra de VOICE_SAMPLE_PATH (entregada y autorizada
 *             por su dueño), estados hasta «Lista», prueba corta, pieza con
 *             texto distinto; B no puede usarla ni eliminarla; A la elimina
 *             y los audios generados siguen descargables.
 * Las etapas pagas exigen SESSION_ALLOW_PAID=true. Ninguna reintenta sola.
 *
 * Variables: BASE_URL, USER_A_EMAIL/USER_A_PASSWORD, USER_B_EMAIL/USER_B_PASSWORD,
 * NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (solo lectura de
 * comprobación y para simular un fallo), VOICE_SAMPLE_PATH (etapa myvoice).
 *
 * Uso: node scripts/session-validation.mjs  (requiere playwright instalado)
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
const step = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✔ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) });
    console.log(`✖ ${name}: ${err instanceof Error ? err.message : err}`);
    throw err;
  }
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

async function jobByTitle(owner, title) {
  const { data } = await service.from("tts_jobs").select("*").eq("user_id", owner).eq("title", title);
  return data ?? [];
}

/** Descarga por la URL firmada del enlace y comprueba que es un MP3 con nombre de archivo. */
async function checkDownload(page, title) {
  const card = page.locator("li", { hasText: title });
  const href = await card.getByRole("link", { name: "Descargar MP3" }).getAttribute("href");
  assert.ok(href, "hay enlace de descarga");
  const res = await fetch(href);
  assert.equal(res.status, 200, "descarga 200");
  assert.match(res.headers.get("content-disposition") ?? "", /attachment;.*\.mp3/);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.ok(bytes.length > 5000, "MP3 con contenido");
  assert.ok((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) || bytes[0] === 0xff, "cabecera MP3");
  const src = await card.locator("audio").getAttribute("src");
  assert.equal((await fetch(src, { method: "GET", headers: { Range: "bytes=0-1" } })).ok, true, "el reproductor carga el audio");
  return href;
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

async function createPiece(page, { title, script, voiceValue, doubleClick = false }) {
  await page.goto(`${BASE}/dashboard/tts`);
  await page.fill("#tts-title", title);
  await page.fill("#tts-script", script);
  await page.locator(`input[name="voice_choice"][value="${voiceValue}"]`).check();
  const submit = page.getByRole("button", { name: "Generar audio" });
  if (doubleClick) await submit.dblclick();
  else await submit.click();
  await page.waitForURL(/\/dashboard\/tts/, { timeout: 30000 });
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const A = { email: env("USER_A_EMAIL"), password: env("USER_A_PASSWORD") };
const B = { email: env("USER_B_EMAIL"), password: env("USER_B_PASSWORD") };
let exitCode = 0;
try {
  const aId = await userId(A.email);
  const a = await login(browser, A.email, A.password);
  const b = await login(browser, B.email, B.password);

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
    await step("B: sin acceso a Mi voz si no está en la lista del piloto", async () => {
      const res = await b.page.goto(`${BASE}/dashboard/voices`);
      assert.ok(process.env.USER_B_ALLOWLISTED === "true" || res.status() === 404, `estado ${res.status()}`);
    });
    await step("escritorio: sin desbordes en Texto a voz", async () => {
      await a.page.setViewportSize({ width: 1280, height: 900 });
      await a.page.goto(`${BASE}/dashboard/tts`);
      assert.equal(await a.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0);
      await a.page.setViewportSize({ width: 390, height: 844 });
      await a.page.goto(`${BASE}/dashboard/tts`);
      assert.equal(await a.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0);
    });
  }

  let firstPieceTitle;
  if (STAGES.has("tts")) {
    firstPieceTitle = `Validación ${RUN}`;
    const script =
      "Esta es una prueba breve de Texto a voz en Atomivid.\n\nEl segundo párrafo comprueba la pausa entre párrafos y que la voz elegida sea la misma de principio a fin.";
    await step("A: doble clic en «Generar» crea una sola pieza", async () => {
      await createPiece(a.page, { title: firstPieceTitle, script, voiceValue: "miguel", doubleClick: true });
      await new Promise((r) => setTimeout(r, 3000));
      assert.equal((await jobByTitle(aId, firstPieceTitle)).length, 1);
    });
    const [job] = await jobByTitle(aId, firstPieceTitle);
    await step("A: la pieza llega a «Listo» y aparece en el historial", async () => {
      await waitFor(async () => {
        await a.page.reload();
        return (await a.page.locator("li", { hasText: firstPieceTitle }).getByText("Listo").count()) > 0;
      }, "pieza lista");
    });
    await step("A: reproducción y descarga MP3", () => checkDownload(a.page, firstPieceTitle));
    await step("la voz elegida (Miguel) llegó al proveedor", async () => {
      assert.deepEqual(await voiceIdsUsed(job.id), ["k8cFOyAg7B9qwBlDDNTC"]);
    });
    await step("recuperación: reintento tras un fallo simulado sin volver a pagar", async () => {
      const before = await ledgerEntries(`tts/${job.id}`);
      await service.from("tts_jobs").update({ status: "failed", error_message: "Fallo simulado por la validación." }).eq("id", job.id);
      await a.page.reload();
      await a.page.locator("li", { hasText: firstPieceTitle }).getByRole("button", { name: "Reintentar" }).click();
      await waitFor(async () => (await jobByTitle(aId, firstPieceTitle))[0]?.status === "completed", "reintento completado");
      const after = await ledgerEntries(`tts/${job.id}`);
      assert.equal(after.length, before.length, "sin nuevas operaciones pagadas: fragmentos reutilizados");
    });
  }

  if (STAGES.has("myvoice")) {
    const samplePath = env("VOICE_SAMPLE_PATH");
    let voice;
    await step("A: sube la muestra autorizada con consentimiento y la voz llega a «Lista»", async () => {
      await a.page.goto(`${BASE}/dashboard/voices`);
      await a.page.fill("#voice-name", `Validación ${RUN}`.slice(0, 40));
      await a.page.setInputFiles('input[name="sample"]', samplePath);
      await a.page.check('input[name="consent_own_voice"]');
      await a.page.check('input[name="consent_processing"]');
      await a.page.getByRole("button", { name: "Crear mi voz" }).click();
      voice = await waitFor(async () => {
        const { data } = await service.from("user_voices").select("*").eq("user_id", aId).neq("status", "deleted").order("created_at", { ascending: false }).limit(1);
        const row = data?.[0];
        if (row?.status === "failed") throw new Error(`La clonación falló: ${row.error_message}`);
        return row?.status === "ready" ? row : null;
      }, "voz lista", 10 * 60 * 1000);
      await a.page.reload();
      const src = await a.page.locator("audio").first().getAttribute("src");
      assert.ok(src && (await fetch(src)).ok, "prueba corta reproducible");
    });
    const customTitle = `Mi voz ${RUN}`;
    await step("A: pieza con su voz y un texto distinto al de la prueba", async () => {
      await createPiece(a.page, { title: customTitle, script: "Hoy pruebo mi propia voz con un texto nuevo, distinto de la frase de prueba.", voiceValue: `custom:${voice.id}` });
      await waitFor(async () => (await jobByTitle(aId, customTitle))[0]?.status === "completed", "pieza con Mi voz");
      const [job] = await jobByTitle(aId, customTitle);
      assert.deepEqual(await voiceIdsUsed(job.id), [voice.provider_voice_id]);
    });
    await step("B: no ve la voz de A y no puede usarla enviando su id", async () => {
      await b.page.goto(`${BASE}/dashboard/tts`);
      assert.equal(await b.page.locator(`input[value="custom:${voice.id}"]`).count(), 0);
      const title = `Intrusión ${RUN}`;
      await b.page.fill("#tts-title", title);
      await b.page.fill("#tts-script", "Intento de usar una voz ajena.");
      await b.page.evaluate((id) => {
        const radio = document.querySelector('input[name="voice_choice"][value="mateo"]');
        radio.value = `custom:${id}`;
      }, voice.id);
      await b.page.getByRole("button", { name: "Generar audio" }).click();
      await b.page.waitForURL(/error=/, { timeout: 30000 });
      assert.match(decodeURIComponent(b.page.url()), /no existe o no es tuya/);
      const { data } = await service.from("tts_jobs").select("id").eq("title", title);
      assert.equal((data ?? []).length, 0, "no se creó ninguna pieza");
    });
    if (process.env.USER_B_ALLOWLISTED === "true" && process.env.B_SHORT_SAMPLE_PATH) {
      await step("B: no puede eliminar la voz de A cambiando el id en su propio formulario", async () => {
        // Muestra de 5 s: el worker la rechaza por duración ANTES de clonar (sin gasto) y B queda con un formulario «Eliminar».
        await b.page.goto(`${BASE}/dashboard/voices`);
        await b.page.fill("#voice-name", "B corta");
        await b.page.setInputFiles('input[name="sample"]', env("B_SHORT_SAMPLE_PATH"));
        await b.page.evaluate(() => {
          document.querySelector('input[name="client_seconds"]').value = "";
        });
        await b.page.check('input[name="consent_own_voice"]');
        await b.page.check('input[name="consent_processing"]');
        await b.page.evaluate(() => document.querySelector('button[type="submit"]').removeAttribute("disabled"));
        await b.page.locator('button[type="submit"]').last().click();
        const bId = await userId(B.email);
        await waitFor(async () => (await service.from("user_voices").select("status").eq("user_id", bId).eq("status", "failed")).data?.length, "voz corta de B rechazada");
        await b.page.reload();
        await b.page.evaluate((id) => {
          for (const input of document.querySelectorAll('input[name="voice_id"]')) input.value = id;
        }, voice.id);
        await b.page.getByRole("button", { name: "Eliminar voz y grabaciones" }).click();
        await b.page.waitForURL(/error=/, { timeout: 30000 });
        assert.match(decodeURIComponent(b.page.url()), /no existe o no es tuya/);
        assert.equal((await service.from("user_voices").select("status").eq("id", voice.id).single()).data?.status, "ready");
      });
    }
    await step("A: elimina su voz; los audios generados siguen descargables", async () => {
      await a.page.goto(`${BASE}/dashboard/voices`);
      await a.page.getByRole("button", { name: "Eliminar voz y grabaciones" }).click();
      await waitFor(async () => (await service.from("user_voices").select("status").eq("id", voice.id).single()).data?.status === "deleted", "voz eliminada");
      await a.page.goto(`${BASE}/dashboard/tts`);
      await checkDownload(a.page, customTitle);
      if (firstPieceTitle) await checkDownload(a.page, firstPieceTitle);
    });
  }
} catch {
  exitCode = 1;
} finally {
  await browser.close();
  await fs.mkdir("evidence/session", { recursive: true });
  await fs.writeFile("evidence/session/results.json", JSON.stringify({ run: RUN, base: BASE, stages: [...STAGES], results }, null, 2));
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} pasos correctos`);
  process.exit(exitCode);
}
