/**
 * Lectura de caché de voz ante fallos de transporte (T-42/T-43): un solo reintento, solo para errores de conexión.
 * Usa el cliente REAL de supabase-js (mismo que el producto) con un fetch simulado: los errores llegan con la misma forma
 * que en producción (StorageUnknownError con el TypeError «fetch failed» de undici y su `cause.code`).
 * La generación usa ffmpeg y la voz fixture (espeak-ng): gratis y sin red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { applyInput, newProject, type AudioProject } from "./model";
import { AUDIO_STUDIO_BUCKET, StoreError, storageStore, transportCause } from "./store";
import { fixtureVoice, type StudioVoice } from "./voice";
import { renderProject } from "./render";

const A = "11111111-1111-4111-8111-111111111111";
const MUSIC = path.join(tmpdir(), "audio-studio-test-music");
let n = 500;
const ids = () => `cccccccc-cccc-4ccc-8ccc-${String(++n).padStart(12, "0")}`;

type Fault = "transporte" | "hpe" | "econnreset" | 403 | 429 | 500;
/** Error de red tal como lo lanza el fetch de Node (undici): TypeError «fetch failed» con la causa en `cause`. */
function netError(f: "transporte" | "hpe" | "econnreset"): TypeError {
  const cause = f === "transporte" ? Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" })
    : f === "hpe" ? Object.assign(new Error("Parse Error: Expected HTTP/"), { code: "HPE_INVALID_CONSTANT" })
    : Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  return new TypeError("fetch failed", { cause: f === "econnreset" ? Object.assign(new Error("wrapped"), { cause }) : cause });
}

/** Storage simulado detrás del cliente real. `faults[ruta]` = fallos a aplicar (en orden) a las próximas descargas. */
function harness() {
  const objects = new Map<string, Buffer>();
  const faults = new Map<string, Fault[]>();
  const gets: string[] = [];
  /** Fallos que se aplican a la PRIMERA voz en caché (tts/) que se lea, sea cual sea su clave. */
  let firstTts: Fault[] | null = null;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const m = url.pathname.match(/^\/storage\/v1\/object\/(?:authenticated\/)?[^/]+\/(.+)$/);
    if (!m || method !== "GET") return new Response(JSON.stringify({ message: "no soportado" }), { status: 400 });
    const key = decodeURIComponent(m[1]);
    gets.push(key);
    if (firstTts && key.includes("/tts/")) { faults.set(key, firstTts); firstTts = null; }
    const f = faults.get(key)?.shift();
    if (f === "transporte" || f === "hpe" || f === "econnreset") throw netError(f);
    if (typeof f === "number") return new Response(JSON.stringify({ statusCode: String(f), error: "e", message: `fallo ${f}` }), { status: f, headers: { "content-type": "application/json" } });
    const v = objects.get(key);
    if (!v) return new Response(JSON.stringify({ statusCode: "404", error: "not_found", message: "Object not found" }), { status: 404, headers: { "content-type": "application/json" } });
    return new Response(new Uint8Array(v), { status: 200, headers: { "content-type": key.endsWith(".json") ? "application/json" : "audio/mpeg" } });
  };
  const real = createClient("http://storage.test", "clave-de-prueba", { auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: fetchImpl } }).storage.from(AUDIO_STUDIO_BUCKET);
  // Descargas por el cliente real; subidas y listados directos al mapa (no son objeto de esta prueba).
  const bucket = {
    download: (p: string) => real.download(p),
    async upload(p: string, body: string | Buffer, o: { upsert: boolean }) {
      if (!o.upsert && objects.has(p)) return { error: { message: "The resource already exists", statusCode: "409" } };
      objects.set(p, Buffer.isBuffer(body) ? body : Buffer.from(body)); return { error: null };
    },
    async list(prefix: string) { return { data: [...objects.keys()].filter((k) => k.startsWith(prefix + "/")).map((k) => ({ name: k.slice(prefix.length + 1) })), error: null }; },
  };
  const store = storageStore(bucket, { retryDelayMs: 1 });
  return { objects, faults, gets, store, armFirstTts: (f: Fault[]) => { firstTts = f; } };
}

/** Captura los registros de error durante `fn` (para comprobar qué se registra y que no se filtren secretos). */
async function capture<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; logs: unknown[][] }> {
  const logs: unknown[][] = []; const orig = console.error;
  console.error = (...a: unknown[]) => { logs.push(a); };
  try { return { value: await fn(), logs }; } catch (error) { return { error, logs }; } finally { console.error = orig; }
}

const KEY = `audio-studio/v1/${A}/cccccccc-cccc-4ccc-8ccc-000000000001/tts/${"a".repeat(64)}.mp3`;

test("transportCause: solo errores de conexión sin statusCode; nunca respuestas HTTP", () => {
  assert.equal(transportCause({ originalError: netError("transporte") }), "UND_ERR_SOCKET");
  assert.equal(transportCause({ originalError: netError("hpe") }), "HPE_INVALID_CONSTANT");
  assert.equal(transportCause({ originalError: netError("econnreset") }), "ECONNRESET", "causa anidada");
  assert.equal(transportCause({ statusCode: "500", originalError: netError("transporte") }), null, "con statusCode es respuesta del servidor");
  assert.equal(transportCause({ originalError: new TypeError("fetch failed") }), null, "sin código identificable no se reintenta");
  assert.equal(transportCause({ originalError: Object.assign(new Error("x"), { code: "ENOTFOUND" }) }), null, "DNS no es transporte transitorio");
  assert.equal(transportCause(null), null);
});

test("404: devuelve null con una sola petición (sin reintento)", async () => {
  const h = harness();
  const r = await capture(() => h.store.getBlob(KEY));
  assert.equal(r.value, null);
  assert.equal(h.gets.length, 1);
  assert.equal(r.logs.length, 0);
});

test("fallo transitorio → 404: exactamente dos lecturas y null", async () => {
  for (const f of ["transporte", "hpe", "econnreset"] as const) {
    const h = harness(); h.faults.set(KEY, [f]);
    const r = await capture(() => h.store.getBlob(KEY));
    assert.equal(r.value, null, f);
    assert.equal(h.gets.length, 2, f);
    assert.equal(r.logs.length, 1, f);
  }
});

test("fallo transitorio → 200: devuelve el blob en caché tras dos lecturas", async () => {
  const h = harness(); h.objects.set(KEY, Buffer.from("mp3-en-cache")); h.faults.set(KEY, ["transporte"]);
  const r = await capture(() => h.store.getBlob(KEY));
  assert.equal(r.value?.toString(), "mp3-en-cache");
  assert.equal(h.gets.length, 2);
});

test("dos fallos de transporte: StoreError tras exactamente dos lecturas", async () => {
  const h = harness(); h.objects.set(KEY, Buffer.from("x")); h.faults.set(KEY, ["transporte", "hpe"]);
  const r = await capture(() => h.store.getBlob(KEY));
  assert.ok(r.error instanceof StoreError);
  assert.equal((r.error as Error).message, "No se pudo leer el audio.");
  assert.equal(h.gets.length, 2);
  assert.deepEqual(r.logs.map((l) => (l[1] as { retry: boolean }).retry), [true, false]);
});

test("403/429/500: no se reintentan ni se convierten en éxito", async () => {
  for (const code of [403, 429, 500] as const) {
    const h = harness(); h.objects.set(KEY, Buffer.from("x")); h.faults.set(KEY, [code]);
    const r = await capture(() => h.store.getBlob(KEY));
    assert.ok(r.error instanceof StoreError, String(code));
    assert.equal(h.gets.length, 1, `${code}: una sola petición`);
    assert.equal((r.logs[0][1] as { status: unknown; cause: unknown }).cause, null);
    assert.equal(String((r.logs[0][1] as { status: unknown }).status), String(code));
  }
});

test("registro: nombre, estado y causa; sin ruta, clave ni mensaje del servidor", async () => {
  const h = harness(); h.faults.set(KEY, ["transporte", "transporte"]);
  const r = await capture(() => h.store.getBlob(KEY));
  const text = JSON.stringify(r.logs);
  assert.match(text, /StorageUnknownError/);
  assert.match(text, /UND_ERR_SOCKET/);
  assert.ok(!text.includes(A) && !text.includes("clave-de-prueba") && !text.includes("tts/"), text);
});

// ---- Generación completa (ffmpeg + espeak-ng) con el almacén sobre el cliente real ----

/** Voz fixture con un costo simulado por intervención (para comprobar que el gasto no se duplica). */
function pricedVoice(calls: string[]): StudioVoice {
  const base = fixtureVoice();
  return { ...base, provider: (model) => { const p = base.provider(model); return { ...p, usdFor: () => 0.01, async synth(text, voiceId, dest) { calls.push(text); await p.synth(text, voiceId, dest); return { actualUsd: 0.01 }; } }; } };
}
const SCRIPT = "## Bienvenida\nVoz 1: Hola, bienvenidos a una charla breve sobre la calma.\nVoz 2: Gracias por estar aquí hoy con nosotros.\n## Cierre\nVoz 1: Hasta la próxima.";
async function setup(h: ReturnType<typeof harness>) {
  const id = ids();
  let p = newProject({ id, ownerId: A, now: new Date().toISOString(), title: "Transporte", voiceCount: 2 });
  p = applyInput(p, { targetMinutes: 5, script: SCRIPT, budgetUsd: 2, music: { ...p.music, mode: "sin_musica" } }, new Date().toISOString());
  await h.store.create(p);
  return id;
}
async function queue(h: ReturnType<typeof harness>, id: string, kind: "generar" | "remezclar") {
  const p = (await h.store.get(A, id))!;
  const now = new Date().toISOString();
  await h.store.put({ ...p, generation: { ...p.generation, status: "en_cola", kind, heartbeatAt: now, error: null, authorization: kind === "generar" ? { usd: 1, revision: p.revision, at: now, spentBefore: p.spentUsd, model: p.ttsModel } : p.generation.authorization } });
}
const ttsGets = (h: ReturnType<typeof harness>) => h.gets.filter((g) => g.includes("/tts/"));
const firstTts = (h: ReturnType<typeof harness>) => ttsGets(h)[0];

test("generación: fallo transitorio → 404 en la caché: dos lecturas de esa voz, una sola síntesis por intervención, sin doble gasto", async () => {
  const h = harness(); const calls: string[] = []; const id = await setup(h); await queue(h, id, "generar");
  // El primer segmento falla una vez por transporte; no está en caché (404 al reintentar).
  h.armFirstTts(["transporte"]);
  const r = await capture(() => renderProject({ store: h.store, voice: pricedVoice(calls), musicDir: MUSIC }, A, id));
  assert.equal(r.value, "terminada", JSON.stringify(r.logs));
  const p = (await h.store.get(A, id)) as AudioProject;
  const lines = 3;
  assert.equal(calls.length, lines, "una síntesis por intervención");
  assert.equal(p.generation.providerCalls, lines);
  assert.equal(p.spentUsd, 0.03, "gasto = 3 × 0,01, sin duplicar");
  const first = firstTts(h);
  assert.equal(ttsGets(h).filter((g) => g === first).length, 2, "dos lecturas de la voz que falló");
  assert.equal(ttsGets(h).length, lines + 1);
});

test("remezcla: fallo transitorio → 200 en la caché: reutiliza la voz guardada, 0 síntesis", async () => {
  const h = harness(); const calls: string[] = []; const id = await setup(h); await queue(h, id, "generar");
  assert.equal(await renderProject({ store: h.store, voice: pricedVoice(calls), musicDir: MUSIC }, A, id), "terminada");
  const spent = ((await h.store.get(A, id)) as AudioProject).spentUsd;
  calls.length = 0; h.gets.length = 0;
  await queue(h, id, "remezclar");
  h.armFirstTts(["hpe"]);
  const r = await capture(() => renderProject({ store: h.store, voice: pricedVoice(calls), musicDir: MUSIC }, A, id));
  assert.equal(r.value, "terminada", JSON.stringify(r.logs));
  assert.equal(calls.length, 0, "0 síntesis");
  assert.equal(((await h.store.get(A, id)) as AudioProject).spentUsd, spent, "gasto sin cambios");
  const first = firstTts(h);
  assert.equal(ttsGets(h).filter((g) => g === first).length, 2);
});

test("generación: dos fallos de transporte en la caché: falla sin sintetizar y con gasto 0", async () => {
  const h = harness(); const calls: string[] = []; const id = await setup(h); await queue(h, id, "generar");
  h.armFirstTts(["transporte", "transporte"]);
  const r = await capture(() => renderProject({ store: h.store, voice: pricedVoice(calls), musicDir: MUSIC }, A, id));
  assert.equal(r.value, "fallida");
  const p = (await h.store.get(A, id)) as AudioProject;
  assert.equal(p.generation.status, "fallida");
  assert.equal(calls.length, 0, "0 síntesis");
  assert.equal(p.spentUsd, 0);
  assert.equal(p.generation.providerCalls, 0);
  assert.equal(ttsGets(h).length, 2, "dos lecturas y nada más");
});
