/**
 * Voz de demostración (AUDIO_STUDIO_VOICE=demo): solo la cuenta dueña, USD 0, espeak-ng explícito que funciona en
 * contextos de producción sin abrir la voz fixture. Requiere ffmpeg y espeak-ng. Sin red, sin proveedores de pago.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyInput, newProject, type AudioProject } from "./model";
import { memoryStore } from "./store";
import { requestGeneration, view } from "./service";
import { DEMO_PROVIDER_NAME, demoVoice, PAID_BLOCKED, segmentKey, voiceAvailability } from "./voice";
import { workerOwnerIsInternal, workerPreflight } from "./worker";
import { renderProject } from "./render";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
let n = 500;
const ids = () => `cccccccc-cccc-4ccc-8ccc-${String(++n).padStart(12, "0")}`;
const MUSIC = path.join(tmpdir(), "audio-studio-test-music");
const MAP = "es-latam-m-profesional=AAAAAAAA1,es-latam-m-calida=AAAAAAAA2,es-latam-f-profesional=AAAAAAAA3,es-latam-f-energica=AAAAAAAA4";
const PROD = [{}, { NODE_ENV: "production" }, { VERCEL: "1" }, { VERCEL: "1", NODE_ENV: "production" }];

test("disponibilidad: demo solo para la cuenta dueña (también en producción); el resto, igual que hoy", () => {
  for (const p of PROD) {
    const env = { AUDIO_STUDIO_VOICE: "demo", ...p };
    const own = voiceAvailability(env, undefined, { owner: true });
    assert.ok(own.ok && own.voice.mode === "demo", `dueño ${JSON.stringify(p)}`);
    for (const opts of [{ owner: false }, {}, undefined]) {
      const other = voiceAvailability(env, undefined, opts);
      assert.deepEqual(other, { ok: false, reason: PAID_BLOCKED }, `cliente ${JSON.stringify(p)} ${JSON.stringify(opts)}`);
    }
    // Sin la variable, ni el dueño tiene demo.
    assert.deepEqual(voiceAvailability({ ...p }, undefined, { owner: true }), { ok: false, reason: PAID_BLOCKED });
    // Valores parecidos no activan nada.
    for (const v of ["Demo", "DEMO", "demo ", "1", "true", ""]) assert.equal(voiceAvailability({ AUDIO_STUDIO_VOICE: v, ...p }, undefined, { owner: true }).ok, false, v);
  }
});

test("disponibilidad: la voz de pago tiene precedencia; la demo nunca la reemplaza en silencio; fixture sigue fuera de producción", () => {
  const paid = voiceAvailability({ AUDIO_STUDIO_VOICE: "demo", AUDIO_STUDIO_PAID_TTS: "1", AUDIO_STUDIO_ELEVENLABS_VOICES: MAP }, undefined, { owner: true });
  assert.ok(paid.ok && paid.voice.mode === "elevenlabs");
  // Pago encendido pero mal configurado: error de configuración, no demo.
  const broken = voiceAvailability({ AUDIO_STUDIO_VOICE: "demo", AUDIO_STUDIO_PAID_TTS: "1" }, undefined, { owner: true });
  assert.ok(!broken.ok && /voces de ElevenLabs/.test(broken.reason));
  // La barrera de la voz fixture no se debilita (ni para el dueño).
  assert.equal(voiceAvailability({ AUDIO_STUDIO_VOICE: "fixture", VERCEL: "1" }, undefined, { owner: true }).ok, false);
  assert.equal(voiceAvailability({ AUDIO_STUDIO_VOICE: "fixture", NODE_ENV: "production" }, undefined, { owner: true }).ok, false);
  // Proveedor y caché separados de ElevenLabs y de fixture; costo 0.
  const p = demoVoice().provider("eleven_v4_turbo");
  assert.equal(p.name, DEMO_PROVIDER_NAME);
  assert.notEqual(p.name, "elevenlabs");
  assert.notEqual(p.name, "fixture-espeak");
  assert.equal(p.usdFor(60_000), 0);
  assert.notEqual(segmentKey(p.name, "eleven_v4_turbo", "v", "hola"), segmentKey("elevenlabs", "eleven_v4_turbo", "v", "hola"));
  assert.equal(demoVoice().voiceIdFor("no-existe"), "");
});

test("vista y autorización: demo estima USD 0.00 en todos los modelos y acepta confirmar 0; el resto no cambia", async () => {
  const store = memoryStore();
  const id = ids(), now = new Date().toISOString();
  const p = applyInput(newProject({ id, ownerId: A, now, title: "Demo" }), { targetMinutes: 5, script: "palabra ".repeat(760), budgetUsd: 2 }, now);
  await store.create(p);
  const demo = voiceAvailability({ AUDIO_STUDIO_VOICE: "demo", NODE_ENV: "production" }, undefined, { owner: true });
  const v = view(p, {}, demo);
  assert.equal(v.estimate.estimatedUsd, 0);
  assert.equal(v.rate.source, "demo");
  assert.ok(v.rates.every((r) => r.rate === 0 && r.source === "demo"));
  assert.match(v.rate.note, /Voz de demostración — no es la voz final; USD 0/);
  assert.deepEqual(v.readiness, []);
  // Para cualquier otra cuenta (PAID_BLOCKED) la estimación es la de siempre (> 0).
  const blocked = voiceAvailability({ AUDIO_STUDIO_VOICE: "demo" }, undefined, { owner: false });
  assert.ok(view(p, {}, blocked).estimate.estimatedUsd > 0);
  assert.equal((await requestGeneration({ store, env: {}, voice: blocked }, A, id, { revision: p.revision, confirmUsd: 0 })).status, 409);
  // Demo: un monto distinto de 0 no es la confirmación exacta.
  assert.equal((await requestGeneration({ store, env: {}, voice: demo }, A, id, { revision: p.revision, confirmUsd: 0.5 })).status, 400);
  assert.equal((await requestGeneration({ store, env: {}, voice: demo }, A, id, { revision: p.revision })).status, 400);
  const ok = await requestGeneration({ store, env: {}, voice: demo }, A, id, { revision: p.revision, confirmUsd: 0 });
  assert.equal(ok.status, 202);
  const q = (await store.get(A, id))!;
  assert.equal(q.generation.status, "en_cola");
  assert.equal(q.generation.authorization!.usd, 0);
  // Preflight del worker: el monto 0 solo pasa con la voz de demostración; con voz de pago se sigue rechazando.
  assert.equal(await workerPreflight(store, A, id, { demo: true }), null);
  assert.equal(await workerPreflight(store, A, id), "monto autorizado inválido o mayor que el tope del episodio");
  assert.equal(await workerPreflight(store, A, id, { demo: false }), "monto autorizado inválido o mayor que el tope del episodio");
  assert.equal(await workerPreflight(store, B, id, { demo: true }), "proyecto inexistente para ese dueño");
  const s2 = memoryStore();
  await s2.create({ ...q, generation: { ...q.generation, authorization: { ...q.generation.authorization!, usd: -1 } } });
  assert.equal(await workerPreflight(s2, A, id, { demo: true }), "monto autorizado inválido o mayor que el tope del episodio");
  const s3 = memoryStore();
  await s3.create({ ...q, generation: { ...q.generation, authorization: { ...q.generation.authorization!, usd: 999 } } });
  assert.equal(await workerPreflight(s3, A, id, { demo: true }), "monto autorizado inválido o mayor que el tope del episodio");
});

test("worker: la demo solo se concede si el dueño del proyecto es INTERNAL_PRODUCTION_OWNER_USER_ID", () => {
  assert.equal(workerOwnerIsInternal(A, { INTERNAL_PRODUCTION_OWNER_USER_ID: A }), true);
  assert.equal(workerOwnerIsInternal(A, { INTERNAL_PRODUCTION_OWNER_USER_ID: ` ${A.toUpperCase()} ` }), true);
  assert.equal(workerOwnerIsInternal(B, { INTERNAL_PRODUCTION_OWNER_USER_ID: A }), false);
  assert.equal(workerOwnerIsInternal(A, {}), false);
  assert.equal(workerOwnerIsInternal(A, { INTERNAL_PRODUCTION_OWNER_USER_ID: "" }), false);
  assert.equal(workerOwnerIsInternal(A, { INTERNAL_PRODUCTION_OWNER_USER_ID: "no-uuid" }), false);
});

test("worker CLI: demo con otro dueño → SIN_VOZ; con el dueño pasa la barrera de voz (sin Storage sale antes de tocar nada)", () => {
  const run = (env: Record<string, string>) => spawnSync(process.execPath, ["--import", "tsx", "scripts/audio-studio/worker.ts", A, ids()], { encoding: "utf8", env: { NODE_ENV: "production", PATH: process.env.PATH ?? "", TMPDIR: tmpdir(), ...env } });
  const other = run({ AUDIO_STUDIO_VOICE: "demo", INTERNAL_PRODUCTION_OWNER_USER_ID: B });
  assert.equal(other.status, 0); assert.match(other.stdout, /RESULTADO SIN_VOZ .*USD 0/);
  const noOwner = run({ AUDIO_STUDIO_VOICE: "demo" });
  assert.equal(noOwner.status, 0); assert.match(noOwner.stdout, /RESULTADO SIN_VOZ/);
  const own = run({ AUDIO_STUDIO_VOICE: "demo", INTERNAL_PRODUCTION_OWNER_USER_ID: A });
  assert.equal(own.status, 2); assert.match(own.stdout, /RESULTADO ERROR falta configuración de Storage/);
  const wf = readFileSync(".github/workflows/audio-studio-worker.yml", "utf8");
  assert.match(wf, /apt-get install -yq ffmpeg espeak-ng/);
  assert.match(wf, /AUDIO_STUDIO_VOICE: \$\{\{ vars\.AUDIO_STUDIO_VOICE \}\}/);
  assert.match(wf, /INTERNAL_PRODUCTION_OWNER_USER_ID: \$\{\{ vars\.INTERNAL_PRODUCTION_OWNER_USER_ID \}\}/);
});

test("render completo en modo demo con NODE_ENV=production: MP3 válido, proveedor «demo», USD 0 (espeakVoice no se usa)", async () => {
  const store = memoryStore();
  const id = ids(), now = new Date().toISOString();
  // Una línea empieza con «-»: el texto va por archivo y espeak-ng no lo interpreta como opción.
  const script = "## Inicio\nVoz 1: Hola, esta es la voz de demostración del estudio.\nVoz 2: -v en Y esta es la segunda voz, gratis.\n## Cierre\nVoz 1: Gracias por escuchar.";
  let p: AudioProject = applyInput(newProject({ id, ownerId: A, now, title: "Demo", voiceCount: 2 }), { targetMinutes: 5, script, budgetUsd: 2 }, now);
  p = { ...p, generation: { ...p.generation, status: "en_cola", kind: "generar", heartbeatAt: now, authorization: { usd: 0, revision: p.revision, at: now, spentBefore: 0, model: p.ttsModel } } };
  await store.create(p);
  const prev = process.env.NODE_ENV;
  (process.env as Record<string, string | undefined>).NODE_ENV = "production";
  try {
    const voice = voiceAvailability({ AUDIO_STUDIO_VOICE: "demo", NODE_ENV: "production" }, undefined, { owner: true });
    assert.ok(voice.ok);
    assert.equal(await renderProject({ store, voice: voice.voice, musicDir: MUSIC }, A, id), "terminada");
  } finally { (process.env as Record<string, string | undefined>).NODE_ENV = prev; }
  const out = (await store.get(A, id))!;
  assert.ok(out.audio, out.generation.error ?? "sin audio");
  assert.equal(out.audio.provider, "demo");
  assert.equal(out.spentUsd, 0);
  assert.equal(out.generation.providerCalls, 3);
  assert.ok(Math.abs(out.audio.lufs + 16) <= 1.5 && out.audio.truePeak <= -1);
  const dir = mkdtempSync(path.join(tmpdir(), "aps-demo-test-")), f = path.join(dir, "a.mp3");
  try {
    writeFileSync(f, store.blobs.get(out.audio.path)!);
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,sample_rate:format=duration", "-of", "json", f]).toString());
    assert.equal(probe.streams[0].codec_name, "mp3");
    assert.ok(Number(probe.format.duration) > 3);
    execFileSync("ffmpeg", ["-v", "error", "-xerror", "-i", f, "-f", "null", "-"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // Caché de voz bajo el proveedor demo (nunca reutilizable por ElevenLabs).
  assert.equal([...store.blobs.keys()].filter((x) => x.includes("/tts/")).length, 3);
});

test("demo: un fallo de espeak-ng deja la generación fallida con mensaje y sin gasto", async () => {
  const store = memoryStore();
  const id = ids(), now = new Date().toISOString();
  let p = applyInput(newProject({ id, ownerId: A, now, title: "Demo" }), { targetMinutes: 5, script: "Hola.", budgetUsd: 2 }, now);
  p = { ...p, generation: { ...p.generation, status: "en_cola", kind: "generar", heartbeatAt: now, authorization: { usd: 0, revision: p.revision, at: now, spentBefore: 0, model: p.ttsModel } } };
  await store.create(p);
  assert.equal(await renderProject({ store, voice: demoVoice({ bin: "/nonexistent/espeak-ng" }), musicDir: MUSIC }, A, id), "fallida");
  const out = (await store.get(A, id))!;
  assert.match(out.generation.error!, /El proveedor de voz falló/);
  assert.equal(out.spentUsd, 0);
  assert.equal(out.audio, null);
});
