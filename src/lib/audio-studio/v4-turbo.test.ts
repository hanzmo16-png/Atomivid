/**
 * eleven_v4_turbo como modelo seleccionable: tarifa sin descuentos no comprobados, presupuesto de 18 min, caché por
 * modelo/voz/texto/ajustes, solicitud real (simulada) solo con parámetros comprobados, respaldo explícito y ningún
 * cambio automático de modelo tras un fallo. Las pruebas de render usan ffmpeg y espeak-ng locales (gratis).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { applyInput, estimate, modelRate, newProject, parseStored, readinessIssues, TTS_MODELS, ttsModel, type AudioProject, type TtsModelId } from "./model";
import { memoryStore } from "./store";
import { requestGeneration, resumeGeneration, saveProject, switchToFallbackModel, view } from "./service";
import { elevenLabsProvider, fixtureVoice, segmentKey, settingsFor, voiceAvailability, type VoiceAvailability } from "./voice";
import { renderProject } from "./render";
import { SEED_EPISODE } from "./seed";

const A = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-11-16T12:00:00.000Z";
let n = 500;
const ids = () => `cccccccc-cccc-4ccc-8ccc-${String(++n).padStart(12, "0")}`;
const MUSIC = path.join(tmpdir(), "audio-studio-test-music");

test("catálogo: v4 Turbo preferido (por defecto en proyectos nuevos); Multilingual v2 respaldo explícito; proyectos guardados sin modelo siguen en v2", () => {
  assert.deepEqual(TTS_MODELS.map((m) => m.id), ["eleven_multilingual_v2", "eleven_v4_turbo"]);
  const p = newProject({ id: ids(), ownerId: A, now: NOW });
  assert.equal(p.ttsModel, "eleven_v4_turbo");
  assert.match(ttsModel("eleven_v4_turbo")!.label, /recomendado/);
  assert.equal(ttsModel("eleven_multilingual_v2")!.fallback, true);
  assert.equal(ttsModel("eleven_v4_turbo")!.verified, false);
  assert.deepEqual(Object.keys(settingsFor("eleven_v4_turbo")).sort(), ["similarity_boost", "stability"]);
  assert.deepEqual(Object.keys(settingsFor("eleven_multilingual_v2")).sort(), ["similarity_boost", "stability", "style", "use_speaker_boost"]);
  assert.equal(applyInput(p, { ttsModel: "eleven_multilingual_v2" }, NOW).ttsModel, "eleven_multilingual_v2");
  assert.throws(() => applyInput(p, { ttsModel: "eleven_v9" as TtsModelId }, NOW));
});

test("tarifa: v4 Turbo sin verificar se estima igual que v2 (no se asume el descuento de lista); verificada nunca bajo la lista", () => {
  assert.equal(modelRate("eleven_multilingual_v2", {}).rate, 0.2);
  assert.equal(modelRate("eleven_multilingual_v2", { PRICING_ELEVENLABS_USD_PER_1K_CHARS: "0.2" }).source, "produccion");
  const turbo = modelRate("eleven_v4_turbo", { PRICING_ELEVENLABS_USD_PER_1K_CHARS: "0.2" });
  assert.equal(turbo.source, "conservadora");
  assert.equal(turbo.rate, 0.2);
  assert.equal(turbo.listUsdPer1k, 0.04);
  assert.match(turbo.note, /sin verificar/);
  assert.equal(modelRate("eleven_v4_turbo", { AUDIO_STUDIO_RATE_ELEVEN_V4_TURBO: "0.1" }).rate, 0.1);
  assert.equal(modelRate("eleven_v4_turbo", { AUDIO_STUDIO_RATE_ELEVEN_V4_TURBO: "0.01" }).rate, 0.04, "nunca por debajo de la lista");
  assert.equal(modelRate("eleven_v4_turbo", { AUDIO_STUDIO_RATE_ELEVEN_V4_TURBO: "x" }).source, "conservadora");
});

test("presupuesto del episodio de 18 min por modelo (cifras del informe)", () => {
  const p = applyInput(newProject({ id: ids(), ownerId: A, now: NOW, title: SEED_EPISODE.title }), { voices: [SEED_EPISODE.voice], targetMinutes: 18, script: SEED_EPISODE.script, budgetUsd: 6 }, NOW);
  const chars = estimate(p, 1).characters;
  const v2 = estimate(p, modelRate("eleven_multilingual_v2", {}).rate).estimatedUsd;
  const turboConservador = estimate(p, modelRate("eleven_v4_turbo", {}).rate).estimatedUsd;
  const turboLista = estimate(p, 0.04).estimatedUsd;
  const v2Lista = estimate(p, 0.08).estimatedUsd;
  console.log(`PRESUPUESTO_18MIN caracteres=${chars} v2_produccion=${v2} turbo_conservador=${turboConservador} v2_lista=${v2Lista} turbo_lista=${turboLista}`);
  assert.equal(v2, 3.04);
  assert.equal(turboConservador, v2, "sin tarifa verificada, Turbo no aparenta ser más barato");
  assert.ok(turboLista < v2Lista && turboLista <= 0.61);
  assert.deepEqual(readinessIssues(p, estimate(p, 0.2)), []);
});

test("caché separada por modelo, voz, texto y ajustes de síntesis", () => {
  const k = (m: string, v = "voz", t = "hola", s: Record<string, unknown> = settingsFor("eleven_multilingual_v2")) => segmentKey("elevenlabs", m, v, t, s);
  const base = k("eleven_multilingual_v2");
  assert.notEqual(base, k("eleven_v4_turbo"));
  assert.notEqual(base, k("eleven_multilingual_v2", "otra"));
  assert.notEqual(base, k("eleven_multilingual_v2", "voz", "hola."));
  assert.notEqual(base, k("eleven_multilingual_v2", "voz", "hola", { ...settingsFor("eleven_multilingual_v2"), stability: 0.6 }));
  assert.equal(base, segmentKey("elevenlabs", "eleven_multilingual_v2", "voz", "hola", { use_speaker_boost: true, style: 0.2, similarity_boost: 0.75, stability: 0.5 }), "el orden de los ajustes no cambia la clave");
});

test("adaptador real (fetch simulado): model_id elegido, solo ajustes comprobados, costo con la tarifa autorizada, rechazo tipado", async () => {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const ok = (async (url: string, init: { body: string }) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ audio_base64: Buffer.from("ID3audio").toString("base64") }), { status: 200 }); }) as unknown as typeof fetch;
  const dest = path.join(mkdtempSync(path.join(tmpdir(), "aps-v4-")), "a.mp3");
  const r = await elevenLabsProvider("eleven_v4_turbo", 0.2, { apiKey: "test-no-es-clave", fetchImpl: ok }).synth("Hola mundo", "VozReal12345", dest);
  assert.equal(sent[0].body.model_id, "eleven_v4_turbo");
  assert.deepEqual(Object.keys(sent[0].body.voice_settings as object).sort(), ["similarity_boost", "stability"]);
  assert.equal("previous_text" in sent[0].body, false);
  assert.match(sent[0].url, /\/v1\/text-to-speech\/VozReal12345\//);
  assert.equal(readFileSync(dest, "utf8"), "ID3audio");
  assert.equal(r.actualUsd, 0.002);
  const rejected = (async () => new Response("quota_exceeded", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(elevenLabsProvider("eleven_v4_turbo", 0.2, { apiKey: "x", fetchImpl: rejected }).synth("Hola", "VozReal12345", dest), (e: Error) => e.name === "ProviderRejectedError" && /eleven_v4_turbo.*401/.test(e.message));
  await assert.rejects(elevenLabsProvider("eleven_v4_turbo", 0.2, { apiKey: "" , fetchImpl: ok }).synth("Hola", "VozReal12345", dest), /No se hizo ningún cargo/);
});

test("disponibilidad: el pago sigue apagado sin AUDIO_STUDIO_PAID_TTS; con él, cada modelo usa su propio adaptador", () => {
  assert.equal(voiceAvailability({}).ok, false);
  const map = "es-latam-m-profesional=AAAAAAAA1,es-latam-m-calida=BBBBBBBB2,es-latam-f-profesional=CCCCCCCC3,es-latam-f-energica=DDDDDDDD4";
  const on = voiceAvailability({ AUDIO_STUDIO_PAID_TTS: "1", AUDIO_STUDIO_ELEVENLABS_VOICES: map }, (m) => modelRate(m, {}).rate);
  assert.ok(on.ok);
  if (on.ok) {
    assert.equal(on.voice.provider("eleven_v4_turbo").model, "eleven_v4_turbo");
    assert.equal(on.voice.provider("eleven_multilingual_v2").model, "eleven_multilingual_v2");
  }
});

async function seeded(model: TtsModelId) {
  const store = memoryStore();
  const id = ids();
  const p = applyInput(newProject({ id, ownerId: A, now: new Date().toISOString(), title: "Modelo", voiceCount: 1 }), { targetMinutes: 5, script: "## Uno\nPrimera línea de prueba.\nSegunda línea de prueba.", ttsModel: model }, new Date().toISOString());
  await store.create(p);
  return { store, id };
}
async function queue(store: ReturnType<typeof memoryStore>, id: string, model?: TtsModelId) {
  const p = (await store.get(A, id))!;
  const now = new Date().toISOString();
  await store.put({ ...p, generation: { ...p.generation, status: "en_cola", kind: "generar", heartbeatAt: now, error: null, authorization: { usd: 1, revision: p.revision, at: now, spentBefore: p.spentUsd, model: model ?? p.ttsModel } } });
}

test("render con v4 Turbo: caché propia (no reutiliza la de v2) y el MP3 registra el modelo", async () => {
  const { store, id } = await seeded("eleven_multilingual_v2");
  const calls: { model: TtsModelId; voiceId: string; text: string }[] = [];
  const voice = fixtureVoice({ calls });
  await queue(store, id);
  assert.equal(await renderProject({ store, voice, musicDir: MUSIC }, A, id), "terminada");
  assert.equal(calls.length, 2);
  const p = (await store.get(A, id))!;
  assert.equal(p.audio!.model, "eleven_multilingual_v2");
  const s = await saveProject({ store }, A, id, { revision: p.revision, ttsModel: "eleven_v4_turbo" });
  assert.equal(s.status, 200);
  await queue(store, id);
  assert.equal(await renderProject({ store, voice, musicDir: MUSIC }, A, id), "terminada");
  assert.equal(calls.length, 4, "otro modelo ⇒ otra síntesis");
  assert.deepEqual(calls.slice(2).map((c) => c.model), ["eleven_v4_turbo", "eleven_v4_turbo"]);
  const q = (await store.get(A, id))!;
  assert.equal(q.audio!.model, "eleven_v4_turbo");
  assert.equal(q.audio!.reusedSegments, 0);
  assert.equal([...store.blobs.keys()].filter((k) => k.includes("/tts/")).length, 4);
  // Volver a generar con v4 Turbo: todo desde su propia caché.
  await queue(store, id);
  await renderProject({ store, voice, musicDir: MUSIC }, A, id);
  assert.equal(calls.length, 4);
});

test("fallo con v4 Turbo: no cambia de modelo solo; el respaldo es explícito y exige autorizar de nuevo", async () => {
  const { store, id } = await seeded("eleven_v4_turbo");
  const calls: { model: TtsModelId; voiceId: string; text: string }[] = [];
  const failing = fixtureVoice({ calls, fail: (_t, m) => { if (m === "eleven_v4_turbo") throw new Error("503"); } });
  await queue(store, id);
  assert.equal(await renderProject({ store, voice: failing, musicDir: MUSIC }, A, id), "fallida");
  let p = (await store.get(A, id))!;
  assert.equal(p.ttsModel, "eleven_v4_turbo", "el modelo no cambió solo");
  assert.ok(calls.every((c) => c.model === "eleven_v4_turbo"), "ninguna llamada con otro modelo");
  const voice: VoiceAvailability = { ok: true, voice: failing };
  const fb = await switchToFallbackModel({ store, env: {} }, A, id, p.revision);
  assert.equal(fb.status, 200);
  p = (await store.get(A, id))!;
  assert.equal(p.ttsModel, "eleven_multilingual_v2");
  assert.equal(p.generation.authorization, null, "la autorización anterior no sirve para el respaldo");
  assert.equal(p.generation.status, "inactiva");
  assert.equal((await resumeGeneration({ store, voice }, A, id)).status, 409, "no se puede reanudar con la autorización del otro modelo");
  assert.equal((await switchToFallbackModel({ store, env: {} }, A, id, p.revision)).status, 409, "ya está en el respaldo");
});

test("autorización ligada al modelo: autorizar con un modelo y cambiar al otro exige autorizar de nuevo; el render rechaza un modelo distinto sin llamar", async () => {
  const store = memoryStore();
  const id = ids(), now = new Date().toISOString();
  const p = applyInput(newProject({ id, ownerId: A, now, title: "Aut" }), { targetMinutes: 5, script: "palabra ".repeat(760), budgetUsd: 5 }, now);
  await store.create(p);
  const voice: VoiceAvailability = { ok: true, voice: fixtureVoice() };
  const v = view(p, {});
  const ok = await requestGeneration({ store, env: {}, voice }, A, id, { revision: p.revision, confirmUsd: v.estimate.estimatedUsd });
  assert.equal(ok.status, 202);
  assert.equal((ok.body as AudioProject).generation.authorization!.model, "eleven_v4_turbo", "la autorización guarda el modelo preferido elegido");
  const { store: s2, id: id2 } = await seeded("eleven_v4_turbo");
  const calls: { model: TtsModelId; voiceId: string; text: string }[] = [];
  await queue(s2, id2, "eleven_multilingual_v2");
  assert.equal(await renderProject({ store: s2, voice: fixtureVoice({ calls }), musicDir: MUSIC }, A, id2), "fallida");
  assert.match((await s2.get(A, id2))!.generation.error!, /otro modelo de voz/);
  assert.equal(calls.length, 0);
});

test("proyectos guardados antes de v4 Turbo se leen con Multilingual v2", () => {
  const p = newProject({ id: ids(), ownerId: A, now: NOW, title: "Viejo" });
  const raw = JSON.parse(JSON.stringify(p));
  delete raw.ttsModel;
  delete raw.generation;
  assert.equal(parseStored(raw, A)!.ttsModel, "eleven_multilingual_v2");
  assert.equal(parseStored({ ...raw, ttsModel: "eleven_v9" }, A)!.ttsModel, "eleven_multilingual_v2");
});

test("worker de producción: inline nunca en producción; github despacha su propio evento con solo identificadores", async () => {
  const { workerMode, startWorker, dispatchPayload, AUDIO_STUDIO_DISPATCH_EVENT } = await import("./worker");
  assert.equal(workerMode({ AUDIO_STUDIO_WORKER: "inline" }), "inline");
  assert.equal(workerMode({ AUDIO_STUDIO_WORKER: "inline", VERCEL: "1" }), "apagado");
  assert.equal(workerMode({ AUDIO_STUDIO_WORKER: "inline", NODE_ENV: "production" }), "apagado");
  assert.equal(workerMode({ AUDIO_STUDIO_WORKER: "github", VERCEL: "1" }), "github");
  assert.equal(workerMode({}), "apagado");
  assert.equal(AUDIO_STUDIO_DISPATCH_EVENT, "audio-studio-render");
  assert.throws(() => dispatchPayload("x; rm -rf /", A));
  const store = memoryStore();
  const voice: VoiceAvailability = { ok: true, voice: fixtureVoice() };
  const id = ids();
  const sent: { url: string; body: unknown; auth: string }[] = [];
  const okFetch = (async (url: string, init: RequestInit) => { sent.push({ url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).Authorization) }); return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
  const env = { AUDIO_STUDIO_WORKER: "github", GH_WORKER_TOKEN: "tok-prueba", GH_WORKER_REPO: "o/r", VERCEL: "1" };
  assert.equal(await startWorker(store, voice, A, id, env, okFetch), "github");
  assert.equal(sent[0].url, "https://api.github.com/repos/o/r/dispatches");
  assert.deepEqual(sent[0].body, { event_type: "audio-studio-render", client_payload: { ownerId: A, projectId: id } });
  // Sin configuración, con error HTTP o sin voz: no hay despacho ni gasto, y no lanza.
  assert.equal(await startWorker(store, voice, A, id, { AUDIO_STUDIO_WORKER: "github" }, okFetch), "apagado");
  assert.equal(await startWorker(store, voice, A, id, env, (async () => new Response("no", { status: 403 })) as unknown as typeof fetch), "apagado");
  assert.equal(await startWorker(store, voice, A, id, env, (async () => { throw new Error("red"); }) as unknown as typeof fetch), "apagado");
  assert.equal(await startWorker(store, { ok: false, reason: "x" }, A, id, env, okFetch), "apagado");
  assert.equal(sent.length, 1);
  // El workflow de producción existe, usa su propio evento, no interpola identificadores y deja la voz de pago apagada.
  const wf = readFileSync(path.join(process.cwd(), ".github/workflows/audio-studio-worker.yml"), "utf8");
  assert.match(wf, /types: \[audio-studio-render\]/);
  assert.match(wf, /AUDIO_STUDIO_PAID_TTS: \$\{\{ vars\.AUDIO_STUDIO_PAID_TTS \}\}/);
  assert.doesNotMatch(wf, /run:.*\$\{\{ github\.event/);
  assert.doesNotMatch(wf, /render-video|podcast-premium|long-form/i);
});

test("A/B de 90 s: extracto del episodio inicial en párrafos completos, ~1.300 caracteres, apto para una solicitud", async () => {
  const { abExcerpt, AB_TARGET_CHARS } = await import("../../../scripts/audio-studio/ab-v4-turbo");
  const t = abExcerpt();
  assert.ok(t.length <= AB_TARGET_CHARS && t.length > 1000, `caracteres=${t.length}`);
  assert.ok(SEED_EPISODE.script.includes(t.split("\n\n")[0]));
  assert.ok(!t.includes("##"));
  for (const m of TTS_MODELS) assert.ok(t.length <= m.maxCharsPerRequest);
});

test("worker de producción, payload adversarial (USD 0): ajeno, manipulado, duplicado, sin autorización, otro modelo y monto inválido se rechazan sin escribir", async () => {
  const { workerPreflight } = await import("./worker");
  const B = "22222222-2222-4222-8222-222222222222";
  const store = memoryStore();
  const id = ids(), now = new Date().toISOString();
  const p = applyInput(newProject({ id, ownerId: A, now, title: "Worker" }), { targetMinutes: 5, script: "palabra ".repeat(760), budgetUsd: 5 }, now);
  await store.create(p);
  const voice: VoiceAvailability = { ok: true, voice: fixtureVoice() };
  const snapshot = () => JSON.stringify(store.paths().map((k) => [k, k]).concat([...store.blobs.keys()].map((k) => [k, String(store.blobs.get(k)!.length)])));
  // Sin cola: nada que hacer.
  assert.match((await workerPreflight(store, A, id))!, /estado «inactiva»/);
  // Manipulado: identificadores no UUID / inyección.
  assert.equal(await workerPreflight(store, "../../otro", id), "identificadores inválidos");
  assert.equal(await workerPreflight(store, A, "x; rm -rf /"), "identificadores inválidos");
  // En cola con autorización válida → pasa.
  const ok = await requestGeneration({ store, env: {}, voice }, A, id, { revision: p.revision, confirmUsd: view(p, {}).estimate.estimatedUsd });
  assert.equal(ok.status, 202);
  assert.equal(await workerPreflight(store, A, id), null);
  // Ajeno: el proyecto de A pedido con el dueño B no existe para B (la ruta y el dueño del JSON deben coincidir).
  assert.equal(await workerPreflight(store, B, id), "proyecto inexistente para ese dueño");
  // Archivo plantado en la ruta de B con ownerId de A: parseStored lo descarta.
  await store.put({ ...(await store.get(A, id))!, ownerId: B });
  const planted = await store.get(B, id);
  assert.ok(!planted || planted.ownerId === B);
  // Manipulaciones de la autorización guardada (cada una se prueba sobre una copia; ninguna escribe).
  const base = (await store.get(A, id))!;
  const variant = async (mut: (x: AudioProject) => AudioProject) => { const s = memoryStore(); await s.create(mut(structuredClone(base))); return workerPreflight(s, A, id); };
  assert.equal(await variant((x) => ({ ...x, generation: { ...x.generation, authorization: null } })), "sin autorización de gasto guardada");
  assert.equal(await variant((x) => ({ ...x, revision: x.revision + 1 })), "la autorización es de otra revisión del guion");
  assert.equal(await variant((x) => ({ ...x, ttsModel: x.ttsModel === "eleven_v4_turbo" ? "eleven_multilingual_v2" : "eleven_v4_turbo" })), "la autorización es para otro modelo de voz");
  assert.equal(await variant((x) => ({ ...x, generation: { ...x.generation, authorization: { ...x.generation.authorization!, usd: 999 } } })), "monto autorizado inválido o mayor que el tope del episodio");
  assert.equal(await variant((x) => ({ ...x, generation: { ...x.generation, authorization: { ...x.generation.authorization!, usd: 0 } } })), "monto autorizado inválido o mayor que el tope del episodio");
  // La verificación previa no escribe nada.
  const before = snapshot();
  await workerPreflight(store, B, id); await workerPreflight(store, A, "x"); await workerPreflight(store, A, id);
  assert.equal(snapshot(), before);
  // Render completo y despacho duplicado: el segundo se rechaza antes de tocar nada y no hay llamadas nuevas.
  const calls: { model: TtsModelId; voiceId: string; text: string }[] = [];
  assert.equal(await renderProject({ store, voice: fixtureVoice({ calls }), musicDir: MUSIC }, A, id), "terminada");
  const n = calls.length, spent = (await store.get(A, id))!.spentUsd;
  assert.match((await workerPreflight(store, A, id))!, /estado «terminada»/);
  assert.equal(await renderProject({ store, voice: fixtureVoice({ calls }), musicDir: MUSIC }, A, id), "omitida");
  assert.equal(calls.length, n);
  assert.equal((await store.get(A, id))!.spentUsd, spent);
});

test("worker CLI: identificadores manipulados salen con error sin tocar Storage; sin voz de pago no genera (USD 0)", async () => {
  const { spawnSync } = await import("node:child_process");
  const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, ["--import", "tsx", "scripts/audio-studio/worker.ts", ...args], { encoding: "utf8", env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...env } });
  const bad = run(["no-uuid", "x"]);
  assert.equal(bad.status, 2); assert.match(bad.stdout, /RESULTADO ERROR identificadores inválidos/);
  const noVoice = run([A, ids()]);
  assert.equal(noVoice.status, 0); assert.match(noVoice.stdout, /RESULTADO SIN_VOZ .*USD 0/);
  // El workflow A/B de pago no corre sin el monto exacto (lo verifica el script antes de llamar a la API).
  const ab = spawnSync(process.execPath, ["--import", "tsx", "scripts/audio-studio/ab-v4-turbo.ts", "real", path.join(tmpdir(), "ab-sin-confirmar")], { encoding: "utf8", env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", AB_VOZ_ID: "TbvhqFC7AApJv7hnNvmY", AB_CONFIRMAR_USD: "0.50" } });
  assert.equal(ab.status, 2); assert.match(ab.stdout, /RESULTADO BLOQUEADO AB_CONFIRMAR_USD debe ser exactamente/);
  const wf = readFileSync(path.join(process.cwd(), ".github/workflows/audio-studio-ab-v4-turbo.yml"), "utf8");
  assert.match(wf, /^on:\n  workflow_dispatch:/m); assert.doesNotMatch(wf, /^\s+(push|pull_request|schedule|repository_dispatch):/m);
});

test("estado de voz en la vista: sin proveedor → no disponible con el motivo; fixture → local; la API lo expone en cada respuesta", async () => {
  const { voiceStatus } = await import("./service");
  assert.deepEqual(voiceStatus(undefined).available, false);
  assert.match(voiceStatus({ ok: false, reason: "motivo" }).message!, /motivo/);
  assert.deepEqual({ ...voiceStatus({ ok: true, voice: fixtureVoice() }), message: undefined }, { available: true, local: true, message: undefined, realPresets: null });
  const store = memoryStore(); const id = ids(), now = new Date().toISOString();
  await store.create(newProject({ id, ownerId: A, now, title: "Estado" }));
  const { getProject } = await import("./service");
  const off = await getProject({ store }, A, id);
  assert.equal((off.body as ReturnType<typeof view>).voiceStatus.available, false);
  const on = await getProject({ store, voice: { ok: true, voice: fixtureVoice() } }, A, id);
  assert.equal((on.body as ReturnType<typeof view>).voiceStatus.local, true);
});
