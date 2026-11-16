/**
 * Generación de Audio Podcast Studio con ffmpeg REAL y voz fixture (espeak-ng, gratis, sin red). Requiere ffmpeg y
 * espeak-ng instalados (los tiene el runner de CI del módulo).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyInput, newProject, type AudioProject } from "./model";
import { memoryStore } from "./store";
import { getProject, requestGeneration, requestRemix, resumeGeneration, saveProject, setArchived } from "./service";
import { fixtureVoice, voiceAvailability, segmentKey, type VoiceAvailability } from "./voice";
import { licensedTrack, renderProject } from "./render";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
let n = 100;
const ids = () => `bbbbbbbb-bbbb-4bbb-8bbb-${String(++n).padStart(12, "0")}`;
const MUSIC = path.join(tmpdir(), "audio-studio-test-music");
const DUO = "## Bienvenida\nVoz 1: Hola, bienvenidos a una charla sobre la calma y el silencio.\nVoz 2: Gracias por estar aquí. Hoy hablamos de respirar y aceptar.\n## Cierre\nVoz 1: El futuro empieza con lo que eliges hoy, con valor y fuerza.\nVoz 2: Hasta la próxima.";

function setup(script = DUO, voiceCount: 1 | 2 = 2, music?: Partial<AudioProject["music"]>) {
  const store = memoryStore();
  const id = ids();
  let p = newProject({ id, ownerId: A, now: new Date().toISOString(), title: "Prueba", voiceCount });
  // Duración objetivo mínima (5 min) y guion corto: en estas pruebas se omite la comprobación de duración.
  p = applyInput(p, { targetMinutes: 5, script, budgetUsd: 2, ...(music ? { music: { ...p.music, ...music } } : {}) }, new Date().toISOString());
  void store.create(p);
  return { store, id };
}
/** Pone en cola sin pasar por la verificación de duración (el guion de prueba dura segundos). */
async function queue(store: ReturnType<typeof memoryStore>, id: string, usd = 1) {
  const p = (await store.get(A, id))!;
  const now = new Date().toISOString();
  await store.put({ ...p, generation: { ...p.generation, status: "en_cola", kind: "generar", heartbeatAt: now, error: null, authorization: { usd, revision: p.revision, at: now, spentBefore: p.spentUsd } } });
}
function decode(buf: Buffer) {
  const dir = mkdtempSync(path.join(tmpdir(), "aps-dec-")), f = path.join(dir, "a.mp3");
  writeFileSync(f, buf);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,channels,sample_rate:format=duration", "-of", "json", f]).toString());
  // Decodificación completa (falla si el archivo está corrupto) y RMS por ventanas de 0,5 s.
  const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", f, "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { maxBuffer: 1 << 28 });
  const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  const rms = (a: number, b: number) => { let x = 0, k = 0; for (let i = Math.floor(a * 8000); i < Math.min(s.length, Math.floor(b * 8000)); i++) { x += (s[i] / 32768) ** 2; k++; } return k ? 20 * Math.log10(Math.sqrt(x / k) + 1e-9) : -120; };
  return { probe, rms, seconds: s.length / 8000 };
}

test("dúo: MP3 terminado y decodificable, −16 LUFS, pico ≤ −1 dBTP, dos voces, música bajo la narración y licencias CC0", async () => {
  const { store, id } = setup();
  await queue(store, id);
  assert.equal(await renderProject({ store, voice: fixtureVoice(), musicDir: MUSIC }, A, id), "terminada");
  const p = (await store.get(A, id))!;
  assert.ok(p.audio);
  assert.equal(p.generation.status, "terminada");
  assert.equal(p.generation.providerCalls, 4);
  assert.ok(Math.abs(p.audio.lufs + 16) <= 1.5, `LUFS ${p.audio.lufs}`);
  assert.ok(p.audio.truePeak <= -1, `TP ${p.audio.truePeak}`);
  assert.deepEqual(p.audio.musicTracks.map((t) => t.split(" — ")[0]), ["atomivid-relajante.wav", "atomivid-inspirador.wav"]);
  assert.ok(p.audio.musicTracks.every((t) => t.endsWith("CC0 1.0")));
  const { probe, rms, seconds } = decode(store.blobs.get(p.audio.path)!);
  assert.equal(probe.streams[0].codec_name, "mp3");
  assert.equal(Number(probe.streams[0].sample_rate), 48000);
  assert.ok(Math.abs(Number(probe.format.duration) - p.audio.durationSeconds) < 0.2);
  assert.ok(seconds > 10);
  // Entrada musical (los primeros 2,5 s son solo música): se oye, pero por debajo de la voz.
  const intro = rms(0.8, 2.5), speech = rms(4, 7);
  assert.ok(intro > -55, `música audible en la entrada (${intro.toFixed(1)} dB)`);
  assert.ok(speech > intro + 3, `la voz queda por encima de la música (${speech.toFixed(1)} vs ${intro.toFixed(1)} dB)`);
  // Dos voces distintas: las intervenciones en caché son 4 (una por línea, ninguna repetida).
  assert.equal([...store.blobs.keys()].filter((k) => k.includes("/tts/")).length, 4);
});

test("doble cobro: volver a generar el mismo guion no llama al proveedor (voz en caché)", async () => {
  const { store, id } = setup();
  await queue(store, id);
  await renderProject({ store, voice: fixtureVoice(), musicDir: MUSIC }, A, id);
  await queue(store, id);
  assert.equal(await renderProject({ store, voice: fixtureVoice(), musicDir: MUSIC }, A, id), "terminada");
  const p = (await store.get(A, id))!;
  assert.equal(p.generation.providerCalls, 4, "las mismas 4 llamadas: ninguna nueva");
  assert.equal(p.audio!.reusedSegments, 4);
});

test("interrupción y reanudación: lo ya generado no se vuelve a sintetizar", async () => {
  const { store, id } = setup();
  await queue(store, id);
  assert.equal(await renderProject({ store, voice: fixtureVoice(), musicDir: MUSIC, interruptAfter: 2 }, A, id), "fallida");
  let p = (await store.get(A, id))!;
  assert.equal(p.generation.status, "fallida");
  assert.match(p.generation.error!, /Reanudar.*no se vuelve a cobrar/);
  assert.equal(p.generation.providerCalls, 2);
  const voice: VoiceAvailability = { ok: true, voice: fixtureVoice() };
  const r = await resumeGeneration({ store, voice }, A, id);
  assert.equal(r.status, 202);
  assert.equal(await renderProject({ store, voice: voice.voice, musicDir: MUSIC }, A, id), "terminada");
  p = (await store.get(A, id))!;
  assert.equal(p.generation.providerCalls, 4, "2 antes + 2 después: ninguna intervención sintetizada dos veces");
  assert.equal(p.audio!.reusedSegments, 2);
});

test("error del proveedor: falla con mensaje claro, sin MP3, y reanudar completa sin repetir lo hecho", async () => {
  const { store, id } = setup();
  await queue(store, id);
  let fail = true;
  const flaky = fixtureVoice({ fail: (t) => { if (fail && t.startsWith("El futuro")) throw new Error("503 servicio no disponible"); } });
  assert.equal(await renderProject({ store, voice: flaky, musicDir: MUSIC }, A, id), "fallida");
  let p = (await store.get(A, id))!;
  assert.match(p.generation.error!, /El proveedor de voz falló en la intervención 3.*no se volverá a cobrar/);
  assert.equal(p.audio, null);
  assert.equal(p.generation.providerCalls, 2);
  fail = false;
  await resumeGeneration({ store, voice: { ok: true, voice: flaky } }, A, id);
  assert.equal(await renderProject({ store, voice: flaky, musicDir: MUSIC }, A, id), "terminada");
  p = (await store.get(A, id))!;
  assert.equal(p.generation.providerCalls, 4);
});

test("remezcla: cambia la música sin llamar al proveedor; falla con explicación si el guion cambió", async () => {
  const { store, id } = setup();
  await queue(store, id);
  await renderProject({ store, voice: fixtureVoice(), musicDir: MUSIC }, A, id);
  const first = (await store.get(A, id))!;
  const voice: VoiceAvailability = { ok: true, voice: fixtureVoice() };
  const s = await saveProject({ store }, A, id, { revision: first.revision, music: { ...first.music, mode: "fija", mood: "intensa", volume: 30 } });
  assert.equal(s.status, 200);
  const r = await requestRemix({ store, voice }, A, id, { revision: (s.body as AudioProject).revision });
  assert.equal(r.status, 202);
  assert.equal(await renderProject({ store, voice: voice.voice, musicDir: MUSIC }, A, id), "terminada");
  const second = (await store.get(A, id))!;
  assert.equal(second.generation.providerCalls, first.generation.providerCalls, "sin llamadas nuevas");
  assert.notEqual(second.audio!.sha256, first.audio!.sha256);
  assert.deepEqual(second.audio!.musicTracks.map((t) => t.split(" — ")[0]), ["atomivid-tension.wav"]);
  // Guion cambiado: la remezcla no sintetiza y explica qué hacer.
  const s2 = await saveProject({ store }, A, id, { revision: second.revision, script: DUO + "\nVoz 1: Una línea nueva." });
  await requestRemix({ store, voice }, A, id, { revision: (s2.body as AudioProject).revision });
  assert.equal(await renderProject({ store, voice: voice.voice, musicDir: MUSIC }, A, id), "fallida");
  const third = (await store.get(A, id))!;
  assert.match(third.generation.error!, /remezcla usa solo voz ya generada/);
  assert.equal(third.generation.providerCalls, first.generation.providerCalls);
  assert.equal(third.audio!.sha256, second.audio!.sha256, "el MP3 anterior se conserva");
});

test("sin música: MP3 solo con voz, igualmente masterizado", async () => {
  const { store, id } = setup(DUO, 2, { mode: "sin_musica" });
  await queue(store, id);
  assert.equal(await renderProject({ store, voice: fixtureVoice(), musicDir: MUSIC }, A, id), "terminada");
  const p = (await store.get(A, id))!;
  assert.deepEqual(p.audio!.musicTracks, []);
  assert.ok(Math.abs(p.audio!.lufs + 16) <= 1.5);
});

test("tope de gasto: con tarifa real simulada, se detiene antes del cargo que excede lo autorizado", async () => {
  const { store, id } = setup();
  await queue(store, id, 0.025);
  const base = fixtureVoice();
  const price = (chars: number) => Math.ceil((chars / 1000) * 0.2 * 1e4) / 1e4;
  const priced = { ...base, provider: { ...base.provider, usdFor: price, synth: async (t: string, v: string, d: string) => ({ ...(await base.provider.synth(t, v, d)), actualUsd: price(t.length) }) } };
  assert.equal(await renderProject({ store, voice: priced, musicDir: MUSIC }, A, id), "fallida");
  const p = (await store.get(A, id))!;
  assert.match(p.generation.error!, /Se alcanzó el gasto autorizado \(USD 0\.03\)|Se alcanzó el gasto autorizado \(USD 0\.02\)/);
  assert.ok(p.spentUsd <= 0.025 + 1e-9 && p.spentUsd > 0, `gastado ${p.spentUsd}`);
  assert.ok(p.generation.providerCalls >= 1 && p.generation.providerCalls < 4);
});

test("autorización expresa: monto exacto, dentro del tope; sin proveedor habilitado no se encola nada", async () => {
  const store = memoryStore();
  const id = ids(), now = new Date().toISOString();
  const script = "palabra ".repeat(760);
  const p = applyInput(newProject({ id, ownerId: A, now, title: "Largo" }), { targetMinutes: 5, script, budgetUsd: 2 }, now);
  await store.create(p);
  const off = await requestGeneration({ store, env: {}, voice: voiceAvailability({}) }, A, id, { revision: p.revision, confirmUsd: 1 });
  assert.equal(off.status, 409);
  assert.match((off.body as { error: string }).error, /no está habilitada.*no se hizo ninguna llamada ni cargo/);
  assert.equal((await store.get(A, id))!.generation.status, "inactiva");
  const voice: VoiceAvailability = { ok: true, voice: fixtureVoice() };
  const est = (await getProject({ store, env: {} }, A, id)).body as { estimate: { estimatedUsd: number } };
  assert.equal((await requestGeneration({ store, env: {}, voice }, A, id, { revision: p.revision })).status, 400);
  assert.equal((await requestGeneration({ store, env: {}, voice }, A, id, { revision: p.revision, confirmUsd: est.estimate.estimatedUsd + 0.5 })).status, 400);
  assert.equal((await requestGeneration({ store, env: {}, voice }, A, id, { revision: p.revision - 1, confirmUsd: est.estimate.estimatedUsd })).status, 409);
  assert.equal((await requestGeneration({ store, env: {}, voice }, B, id, { revision: p.revision, confirmUsd: est.estimate.estimatedUsd })).status, 404, "otra cuenta");
  const ok = await requestGeneration({ store, env: {}, voice }, A, id, { revision: p.revision, confirmUsd: est.estimate.estimatedUsd });
  assert.equal(ok.status, 202);
  const q = (await store.get(A, id))!;
  assert.equal(q.generation.status, "en_cola");
  assert.equal(q.generation.authorization!.usd, est.estimate.estimatedUsd);
  // Mientras está en cola: no se edita, no se archiva, no se duplica.
  assert.equal((await saveProject({ store }, A, id, { revision: q.revision, title: "otro" })).status, 409);
  assert.equal((await setArchived({ store }, A, id, true)).status, 409);
  assert.equal((await requestGeneration({ store, env: {}, voice }, A, id, { revision: q.revision, confirmUsd: est.estimate.estimatedUsd })).status, 409);
});

test("disponibilidad de voz: fixture nunca en producción; pago solo con interruptor y voces completas", () => {
  assert.equal(voiceAvailability({}).ok, false);
  assert.equal(voiceAvailability({ AUDIO_STUDIO_VOICE: "fixture", VERCEL: "1" }).ok, false);
  assert.equal(voiceAvailability({ AUDIO_STUDIO_VOICE: "fixture", NODE_ENV: "production" }).ok, false);
  assert.equal(voiceAvailability({ AUDIO_STUDIO_VOICE: "fixture" }).ok, true);
  assert.equal(voiceAvailability({ AUDIO_STUDIO_PAID_TTS: "1" }).ok, false, "sin mapa de voces no hay pago");
  assert.notEqual(segmentKey("a", "m", "v", "hola"), segmentKey("a", "m", "v", "hola."));
  assert.throws(() => licensedTrack("x" as never));
});
