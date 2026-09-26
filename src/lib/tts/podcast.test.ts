import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { VoiceProvider } from "@/lib/providers/types";
import { memoryDb } from "./test-db";
import { monoWav16, sliceSpeech, speechBank, speechLikeSamples } from "./test-audio";
import { isLongPiece, providerHasRoom, resolveTtsLimits, TTS_TECHNICAL_MAX_CHARS } from "./limits";
import { countWords, estimateDurationRange, fitsTtsLimits, formatDurationRange, segmentScript, billableCharacters, downloadFileName } from "./segment";
import { MUSIC_BEDS, MUSIC_CHOICES, findMusicBed, parseMusicChoice, pickMusicBed, renderMusicBedWav } from "./music-beds";
import {
  MIX,
  levelMatchGains,
  masterToMp3,
  mixNarrationWithBed,
  mixTotalSeconds,
  musicCurveAt,
  musicCurvePoints,
  parseEbur128Summary,
  podcastBitrateKbps,
} from "./podcast-audio";
import { concatToMp3, mixToMp3 } from "./concat";
import { createTtsRequest, LONG_PILOT_BUSY_MESSAGE, requestTtsMix, retryTtsRequest } from "./requests";
import { LONG_QUOTA_RECHECK_EVERY, MIX_FAILED_MESSAGE, MIX_NO_TIME_MESSAGE, runTtsJob, ttsAudioPath, ttsMixPath, type TtsDeps } from "./run-tts-job";

process.env.AUDIOVISUAL_STORAGE_RETRY_MS = "0";

const HANS = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const GENERAL = { maxCharsPerPiece: 3000, maxCharsPerUserMonth: 6000 };
const PILOT_ENV = {
  TTS_LONG_PILOT_EMAILS: "hans@example.com",
  TTS_LONG_PILOT_MAX_CHARS_PER_PIECE: "40000",
  TTS_LONG_PILOT_MAX_CHARS_PER_MONTH: "40000",
};
const hans = { id: HANS, email: "hans@example.com" };

// ---------- Límites: capacidad técnica, límite por usuario y saldo del proveedor ----------

test("límites: los usuarios generales conservan sus límites; el piloto exige lista Y límites explícitos", () => {
  assert.deepEqual(resolveTtsLimits({ id: OTHER, email: "otra@example.com" }, GENERAL, PILOT_ENV), { kind: "general", ...GENERAL, providerReserveChars: 0 });
  assert.equal(resolveTtsLimits(hans, GENERAL, {}).kind, "general", "sin lista no hay piloto");
  assert.equal(resolveTtsLimits(hans, GENERAL, { TTS_LONG_PILOT_EMAILS: "hans@example.com" }).kind, "general", "sin límites explícitos no hay piloto");
  assert.equal(resolveTtsLimits(hans, GENERAL, { ...PILOT_ENV, TTS_LONG_PILOT_MAX_CHARS_PER_MONTH: "mucho" }).kind, "general");
  const pilot = resolveTtsLimits(hans, GENERAL, PILOT_ENV);
  assert.deepEqual(pilot, { kind: "long_pilot", maxCharsPerPiece: 40000, maxCharsPerUserMonth: 40000, providerReserveChars: 3000 });
  // La capacidad técnica no es una cuota: nadie la recibe por estar en el piloto, y nunca se supera.
  const huge = resolveTtsLimits(hans, GENERAL, { ...PILOT_ENV, TTS_LONG_PILOT_MAX_CHARS_PER_PIECE: "900000" });
  assert.equal(huge.maxCharsPerPiece, TTS_TECHNICAL_MAX_CHARS);
  assert.equal(TTS_TECHNICAL_MAX_CHARS, 60000);
  assert.equal(resolveTtsLimits({ id: HANS, email: null }, GENERAL, { ...PILOT_ENV, TTS_LONG_PILOT_EMAILS: "", TTS_LONG_PILOT_USER_IDS: HANS }).kind, "long_pilot");
  assert.equal(isLongPiece(3001, 3000), true);
  assert.equal(isLongPiece(3000, 3000), false);
  assert.equal(providerHasRoom({ remaining: 10000, needed: 6000, othersReserved: 1000, reserve: 3000 }), true);
  assert.equal(providerHasRoom({ remaining: 10000, needed: 6001, othersReserved: 1000, reserve: 3000 }), false);
});

test("estimaciones: palabras, caracteres y duración a 120-140 palabras por minuto, siempre como rango", () => {
  assert.equal(countWords("Hola, mundo — ¿qué tal? 12 casas."), 6, "la raya sola no es palabra");
  const r = estimateDurationRange(130);
  assert.equal(r.typicalSeconds, 60);
  assert.equal(r.minSeconds, Math.round((130 / 140) * 600) / 10);
  assert.equal(r.maxSeconds, 65);
  // Un episodio de 45 min a ritmo típico (5.850 palabras) se anuncia como «≈ 41-49 min», no como 45 exactos.
  assert.equal(formatDurationRange(estimateDurationRange(5850)), "≈ 41–49 min");
  assert.equal(formatDurationRange(estimateDurationRange(100)), "≈ 43–50 s");
  assert.deepEqual(fitsTtsLimits(3500, { ...GENERAL, usedThisMonth: 0 }), { ok: false, reason: "piece", max: 3000 });
  assert.deepEqual(fitsTtsLimits(2000, { ...GENERAL, usedThisMonth: 5000 }), { ok: false, reason: "month", max: 1000 });
  assert.deepEqual(fitsTtsLimits(2000, { ...GENERAL, usedThisMonth: 0 }), { ok: true });
});

// ---------- Crear: piloto, música, doble envío y un episodio largo a la vez ----------

const PARAGRAPH = "El caballero cruzó el puente de piedra mientras la niebla cubría el valle y los cuervos volaban bajo sobre las torres del castillo abandonado.";
/** Párrafos distintos entre sí (textos idénticos compartirían caché de voz y no medirían nada). */
const longScript = (paragraphs: number) =>
  Array.from({ length: paragraphs }, (_, p) => Array.from({ length: 5 }, (_, s) => `En la parte ${p + 1}, escena ${s + 1}: ${PARAGRAPH}`).join(" ")).join("\n\n");

function podcastForm(over: Record<string, unknown> = {}) {
  return { title: "Episodio largo", script: longScript(8), language: "es", voice: "miguel", clientRequestId: "44444444-4444-4444-8444-444444444444", music: "suspense", ...over };
}

test("crear: un episodio largo solo lo acepta el piloto, con sus límites guardados y la mezcla pendiente", async () => {
  const chars = billableCharacters(segmentScript(longScript(8)));
  assert.ok(chars > 3000, `caracteres ${chars}`);
  const db = memoryDb();
  const dispatched: string[] = [];
  const general = await createTtsRequest({ service: db.client, userId: OTHER, form: podcastForm(), limits: resolveTtsLimits({ id: OTHER }, GENERAL, PILOT_ENV), generalMaxCharsPerPiece: 3000, musicEnabled: true, dispatch: async (id) => void dispatched.push(id) });
  assert.match(general.ok ? "" : general.error, /máximo por pieza es 3\.000/);
  const pilot = await createTtsRequest({ service: db.client, userId: HANS, form: podcastForm(), limits: resolveTtsLimits(hans, GENERAL, PILOT_ENV), generalMaxCharsPerPiece: 3000, musicEnabled: true, dispatch: async (id) => void dispatched.push(id) });
  assert.ok(pilot.ok);
  const [row] = db.rows("tts_jobs");
  assert.equal(row.long_pilot, true);
  assert.equal(row.max_chars_per_piece, 40000);
  assert.equal(row.max_chars_per_month, 40000);
  assert.equal(row.music_choice, "suspense");
  assert.equal(row.mix_status, "pending");
  assert.deepEqual(dispatched, [row.id]);
});

test("crear: sin la opción de música habilitada, la pieza es «Sin música»; un valor inventado se rechaza", async () => {
  const db = memoryDb();
  const limits = resolveTtsLimits(hans, GENERAL, PILOT_ENV);
  const off = await createTtsRequest({ service: db.client, userId: HANS, form: podcastForm({ script: "Hola.", music: "documentary" }), limits, generalMaxCharsPerPiece: 3000, musicEnabled: false, dispatch: async () => {} });
  assert.ok(off.ok);
  assert.equal(db.rows("tts_jobs")[0].music_choice, "none");
  assert.equal(db.rows("tts_jobs")[0].mix_status, null);
  assert.equal(db.rows("tts_jobs")[0].long_pilot, false);
  const bad = await createTtsRequest({ service: db.client, userId: HANS, form: podcastForm({ script: "Hola.", music: "rock", clientRequestId: "55555555-5555-4555-8555-555555555555" }), limits, generalMaxCharsPerPiece: 3000, musicEnabled: true, dispatch: async () => {} });
  assert.deepEqual(bad, { ok: false, error: "Elige un acompañamiento válido." });
  assert.equal(parseMusicChoice("rock"), null);
  assert.deepEqual(MUSIC_CHOICES.map((m) => m.label), ["Sin música", "Suspenso", "Documental"]);
});

test("crear: doble envío devuelve la misma pieza; un segundo episodio largo espera a que termine el primero", async () => {
  const db = memoryDb();
  const limits = resolveTtsLimits(hans, GENERAL, PILOT_ENV);
  const dispatched: string[] = [];
  const dispatch = async (id: string) => void dispatched.push(id);
  const base = { service: db.client, userId: HANS, limits, generalMaxCharsPerPiece: 3000, musicEnabled: true, dispatch };
  const first = await createTtsRequest({ ...base, form: podcastForm() });
  const again = await createTtsRequest({ ...base, form: podcastForm() });
  assert.ok(first.ok && again.ok && again.duplicate && again.jobId === first.jobId);
  const second = await createTtsRequest({ ...base, form: podcastForm({ clientRequestId: "66666666-6666-4666-8666-666666666666" }) });
  assert.deepEqual(second, { ok: false, error: LONG_PILOT_BUSY_MESSAGE });
  assert.equal(db.rows("tts_jobs").length, 1);
  assert.equal(dispatched.length, 1);
  // Una pieza corta sí puede crearse mientras tanto.
  assert.ok((await createTtsRequest({ ...base, form: podcastForm({ script: "Hola.", clientRequestId: "77777777-7777-4777-8777-777777777777" }) })).ok);
});

test("crear: un episodio largo que no cabe en el saldo del proveedor (menos la reserva) no se crea", async () => {
  const db = memoryDb();
  const chars = billableCharacters(segmentScript(longScript(8)));
  const result = await createTtsRequest({
    service: db.client,
    userId: HANS,
    form: podcastForm(),
    limits: resolveTtsLimits(hans, GENERAL, PILOT_ENV),
    generalMaxCharsPerPiece: 3000,
    musicEnabled: true,
    providerQuota: async () => ({ remaining: chars + 2999 }),
    dispatch: async () => assert.fail("no debe encolar"),
  });
  assert.match(result.ok ? "" : result.error, /no tiene caracteres suficientes/);
  assert.equal(db.rows("tts_jobs").length, 0);
});

// ---------- Worker: episodio largo, reanudación, cuotas y mezcla ----------

const BANK = speechBank(30, 3);

/** Proveedor «real» simulado con habla sintética; `hooks.before(i)` puede fallar o avanzar el reloj. */
function speechProvider(hooks: { before?: (index: number, text: string) => Error | null } = {}) {
  const calls: string[] = [];
  const provider: VoiceProvider = {
    name: "elevenlabs",
    async synthesize(text) {
      const index = calls.length;
      calls.push(text);
      const err = hooks.before?.(index, text);
      if (err) throw err;
      const seconds = Math.max(0.6, (countWords(text) / 150) * 60);
      return { audioBuffer: monoWav16(sliceSpeech(BANK, index * 3.7, seconds)), durationSeconds: seconds, words: [], mimeType: "audio/wav", extension: "wav" };
    },
  };
  return { provider, calls };
}

function job(over: Record<string, unknown> = {}) {
  const script = (over.script as string) ?? longScript(20);
  return {
    id: "88888888-8888-4888-8888-888888888888",
    user_id: HANS,
    title: "Episodio",
    language: "es",
    voice_choice: "miguel",
    script,
    characters: billableCharacters(segmentScript(script)),
    status: "queued",
    attempts: 0,
    segments_done: 0,
    long_pilot: true,
    music_choice: "none",
    music_track_id: null,
    mix_status: null,
    mix_attempts: 0,
    audio_path: null,
    ...over,
  };
}

const fakeConcat: TtsDeps["concat"] = async (parts) => ({ audio: Buffer.concat(parts.map((p) => p.audio)), durationSeconds: parts.length });
const fakeMix = (log: { bed: string; narration: number }[] = []): NonNullable<TtsDeps["mix"]> => async ({ narration, bed }) => {
  log.push({ bed: bed.id, narration: narration.length });
  return { audio: Buffer.from(`mix:${bed.id}`), durationSeconds: 99, loudness: { integratedLufs: -16, truePeakDbtp: -2, lra: 5, targetLufs: -16, bitrateKbps: 128, attempts: 1 } };
};
const workerDeps = (db: ReturnType<typeof memoryDb>, provider: VoiceProvider, over: Partial<TtsDeps> = {}): TtsDeps => ({
  service: db.client,
  voiceProvider: provider,
  concat: fakeConcat,
  mix: fakeMix(),
  quota: async () => ({ remaining: 100000 }),
  otherVoiceWork: async () => 0,
  providerReserveChars: 3000,
  ...over,
});

test("episodio largo: con videos generándose (misma cuenta) o sin poder comprobarlo, no se gasta nada", async () => {
  for (const busy of [1, null]) {
    const db = memoryDb({ tts_jobs: [job()] });
    const { provider, calls } = speechProvider();
    assert.equal(await runTtsJob(job().id, workerDeps(db, provider, { otherVoiceWork: async () => busy })), "failed");
    assert.equal(calls.length, 0);
    assert.match(String(db.rows("tts_jobs")[0].error_message), busy ? /videos generándose/ : /No se pudo comprobar/);
  }
});

test("episodio largo: exige saldo para lo que falta + la reserva para el resto del producto + otras piezas en curso", async () => {
  const chars = job().characters;
  const other = { ...job({ id: "99999999-9999-4999-8999-999999999999", user_id: OTHER, long_pilot: false, status: "processing", characters: 2000 }) };
  const db = memoryDb({ tts_jobs: [job(), other] });
  const { provider, calls } = speechProvider();
  assert.equal(await runTtsJob(job().id, workerDeps(db, provider, { quota: async () => ({ remaining: chars + 3000 + 1999 }) })), "failed");
  assert.equal(calls.length, 0);
  assert.match(String(db.rows("tts_jobs")[0].error_message), /no tiene caracteres suficientes/);
});

test("episodio largo: si el saldo baja a mitad (otros productos gastan), se detiene antes de agotarlo y al reanudar no repite nada", async () => {
  const db = memoryDb({ tts_jobs: [job()] });
  const segments = segmentScript(job().script);
  assert.ok(segments.length > LONG_QUOTA_RECHECK_EVERY + 2, `fragmentos ${segments.length}`);
  let remaining = 100000;
  let quotaCalls = 0;
  const quota = async () => {
    quotaCalls += 1;
    return { remaining: quotaCalls >= 2 ? 1000 : remaining };
  };
  const { provider, calls } = speechProvider();
  assert.equal(await runTtsJob(job().id, workerDeps(db, provider, { quota })), "failed");
  const [row] = db.rows("tts_jobs");
  assert.equal(row.segments_done, LONG_QUOTA_RECHECK_EVERY);
  assert.match(String(row.error_message), /saldo del servicio de voz bajó/);
  assert.equal(calls.length, LONG_QUOTA_RECHECK_EVERY);

  remaining = 100000;
  quotaCalls = -1000;
  assert.ok((await retryTtsRequest({ service: db.client, userId: HANS, jobId: row.id, dispatch: async () => {} })).ok);
  assert.equal(await runTtsJob(row.id as string, workerDeps(db, provider, { quota })), "completed");
  assert.equal(calls.length, segments.length, "cada fragmento se sintetizó una sola vez");
  assert.equal(new Set(calls).size <= segments.length, true);
});

test("presupuesto de tiempo: se pausa entre fragmentos (nunca a mitad) y «Reanudar» sigue sin volver a sintetizar", async () => {
  const db = memoryDb({ tts_jobs: [job()] });
  const segments = segmentScript(job().script);
  let clock = 0;
  const { provider, calls } = speechProvider({ before: () => ((clock += 30_000), null) });
  const now = () => new Date(clock);
  // Presupuesto para ~4 fragmentos de 30 s simulados.
  assert.equal(await runTtsJob(job().id, workerDeps(db, provider, { now, deadlineMs: 150_000 })), "paused");
  const [row] = db.rows("tts_jobs");
  assert.equal(row.status, "failed");
  assert.match(String(row.error_message), /Pulsa «Reanudar»/);
  const firstRun = calls.length;
  assert.equal(row.segments_done, firstRun);
  assert.ok(firstRun >= 3 && firstRun < segments.length, `primera ejecución: ${firstRun}`);

  // Varias ejecuciones con el mismo presupuesto hasta terminar: nunca se repite un fragmento.
  const statusOf = () => String(db.rows("tts_jobs")[0].status);
  for (let run = 0; run < 20 && statusOf() !== "completed"; run++) {
    clock = 0;
    assert.ok((await retryTtsRequest({ service: db.client, userId: HANS, jobId: row.id, dispatch: async () => {} })).ok);
    await runTtsJob(row.id as string, workerDeps(db, provider, { now, deadlineMs: 150_000 }));
  }
  assert.equal(row.status, "completed");
  assert.equal(calls.length, segments.length, "sin síntesis repetidas");
});

test("mezcla: una pieza con música entrega narración y podcast con música; el fondo es del estado de ánimo elegido", async () => {
  const db = memoryDb({ tts_jobs: [job({ music_choice: "documentary", mix_status: "pending", long_pilot: false, script: "Uno.\n\nDos." })] });
  const { provider, calls } = speechProvider();
  const log: { bed: string; narration: number }[] = [];
  assert.equal(await runTtsJob(job().id, workerDeps(db, provider, { mix: fakeMix(log) })), "completed");
  const [row] = db.rows("tts_jobs");
  assert.equal(row.status, "completed");
  assert.equal(row.mix_status, "completed");
  assert.equal(row.audio_path, ttsAudioPath(row.id as string));
  assert.equal(row.mix_path, ttsMixPath(row.id as string));
  assert.ok(db.storage.files.has(ttsAudioPath(row.id as string)) && db.storage.files.has(ttsMixPath(row.id as string)));
  assert.equal(findMusicBed(row.music_track_id as string)?.mood, "documentary");
  assert.equal(log.length, 1);
  assert.equal(log[0].narration, db.storage.files.get(ttsAudioPath(row.id as string))!.length, "mezcla la narración guardada");
  assert.equal(calls.length, 2);
});

test("mezcla: si falla, la narración se conserva; reintentar o cambiar el acompañamiento no vuelve a sintetizar la voz", async () => {
  const db = memoryDb({ tts_jobs: [job({ music_choice: "suspense", mix_status: "pending", long_pilot: false, script: "Uno.\n\nDos." })] });
  const { provider, calls } = speechProvider();
  assert.equal(await runTtsJob(job().id, workerDeps(db, provider, { mix: async () => { throw new Error("ffmpeg cayó"); } })), "failed");
  const [row] = db.rows("tts_jobs");
  assert.equal(row.status, "completed", "la narración sigue lista");
  assert.equal(row.mix_status, "failed");
  assert.equal(row.mix_error, MIX_FAILED_MESSAGE);
  const narration = db.storage.files.get(ttsAudioPath(row.id as string))!;
  assert.ok(narration.length > 0);

  // Otra usuaria no puede pedir la mezcla; la dueña sí, y un doble clic no encola dos.
  const dispatched: string[] = [];
  const dispatch = async (id: string) => void dispatched.push(id);
  assert.equal((await requestTtsMix({ service: db.client, userId: OTHER, jobId: row.id, music: "documentary", dispatch })).ok, false);
  assert.deepEqual(await requestTtsMix({ service: db.client, userId: HANS, jobId: row.id, music: "documentary", dispatch }), { ok: true });
  assert.deepEqual(await requestTtsMix({ service: db.client, userId: HANS, jobId: row.id, music: "documentary", dispatch }), { ok: false, error: "La versión con música ya se está preparando." });
  assert.equal(dispatched.length, 1);
  assert.equal(row.music_choice, "documentary");

  const log: { bed: string; narration: number }[] = [];
  assert.equal(await runTtsJob(row.id as string, workerDeps(db, provider, { mix: fakeMix(log) })), "completed");
  assert.equal(row.mix_status, "completed");
  assert.equal(findMusicBed(row.music_track_id as string)?.mood, "documentary");
  assert.equal(calls.length, 2, "cero síntesis nuevas");
  assert.equal(db.storage.files.get(ttsAudioPath(row.id as string)), narration, "la narración no se tocó");
  // Un segundo disparo con la mezcla ya lista no hace nada.
  assert.equal(await runTtsJob(row.id as string, workerDeps(db, provider, { mix: fakeMix(log) })), "skipped");
  assert.equal(log.length, 1);
  // Sin música o con una pieza sin narrar no se acepta.
  assert.equal((await requestTtsMix({ service: db.client, userId: HANS, jobId: row.id, music: "none", dispatch })).ok, false);
});

test("mezcla: si no queda tiempo en la ejecución, queda para «Preparar mezcla» (la narración ya está lista)", async () => {
  const db = memoryDb({ tts_jobs: [job({ music_choice: "suspense", mix_status: "pending", long_pilot: false, script: "Uno.\n\nDos." })] });
  const { provider } = speechProvider();
  const concat: TtsDeps["concat"] = async (parts) => ({ audio: Buffer.concat(parts.map((p) => p.audio)), durationSeconds: 3000 });
  assert.equal(await runTtsJob(job().id, workerDeps(db, provider, { concat, now: () => new Date(0), deadlineMs: 60_000 })), "failed");
  const [row] = db.rows("tts_jobs");
  assert.equal(row.status, "completed");
  assert.equal(row.mix_status, "failed");
  assert.equal(row.mix_error, MIX_NO_TIME_MESSAGE);
});

test("reintento de un episodio largo pausado mientras otro largo está activo: espera su turno", async () => {
  const db = memoryDb({ tts_jobs: [job({ status: "failed", segments_done: 3 }), job({ id: "99999999-9999-4999-8999-999999999999", status: "processing" })] });
  assert.deepEqual(await retryTtsRequest({ service: db.client, userId: HANS, jobId: job().id, dispatch: async () => assert.fail() }), { ok: false, error: LONG_PILOT_BUSY_MESSAGE });
  assert.equal(db.rows("tts_jobs")[0].status, "failed");
});

// ---------- Audio real (ffmpeg): masterización, mezcla y fondos ----------

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

test("parseEbur128Summary lee sonoridad, rango y pico real", () => {
  const sample = "[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -19.0 LUFS\n    Threshold: -29.2 LUFS\n\n  Loudness range:\n    LRA:         6.2 LU\n\n  True peak:\n    Peak:       -3.4 dBFS\n";
  assert.deepEqual(parseEbur128Summary(sample), { integratedLufs: -19, lra: 6.2, truePeakDbtp: -3.4 });
  assert.throws(() => parseEbur128Summary("nada"));
});

test("nivelado entre fragmentos: corrige solo lo que se aparta de la mediana, con tope", () => {
  assert.deepEqual(levelMatchGains([-20, -20.5, -26, -14, null, -80]), [0, 0, 3, -3, 0, 0]);
  assert.deepEqual(levelMatchGains([-20, -22]), [0, 0]);
  assert.deepEqual(levelMatchGains([-20]), [0]);
});

test("tamaño: la tasa se ajusta para que un episodio largo quepa en un archivo de Storage", () => {
  assert.equal(podcastBitrateKbps(45 * 60), 128);
  assert.equal(podcastBitrateKbps(60 * 60), 96);
  assert.equal(podcastBitrateKbps(80 * 60), 80);
  assert.equal(podcastBitrateKbps(3 * 3600), null);
});

test("curva de la música: abierta en la entrada, baja 14 dB antes de la voz, se mantiene y sube al final, sin saltos", () => {
  const narr = 600;
  const points = musicCurvePoints(narr);
  const duck = MIX.underRelativeLu - MIX.openRelativeLu;
  assert.equal(musicCurveAt(points, 1), 0);
  assert.equal(musicCurveAt(points, MIX.introSeconds), duck);
  assert.equal(musicCurveAt(points, MIX.introSeconds + narr / 2), duck);
  assert.equal(musicCurveAt(points, MIX.introSeconds + narr), duck, "sigue baja mientras termina la voz");
  assert.equal(musicCurveAt(points, mixTotalSeconds(narr) - 1), 0);
  let maxStep = 0;
  for (let t = 0; t < mixTotalSeconds(narr); t += 0.02) maxStep = Math.max(maxStep, Math.abs(musicCurveAt(points, t + 0.02) - musicCurveAt(points, t)));
  assert.ok(maxStep <= (Math.abs(duck) / MIX.duckSeconds) * 0.02 + 1e-9, `paso máximo ${maxStep} dB cada 20 ms`);
});

test("biblioteca musical: dos fondos por estado de ánimo, con procedencia y licencia, deterministas y en bucle sin costura", () => {
  assert.deepEqual(new Set(MUSIC_BEDS.map((b) => b.mood)), new Set(["suspense", "documentary"]));
  for (const bed of MUSIC_BEDS) {
    assert.ok(bed.source && bed.license, `${bed.id} sin procedencia`);
    assert.match(bed.license, /Obra propia de Atomivid/);
  }
  assert.equal(pickMusicBed("suspense", "abc").mood, "suspense");
  assert.equal(pickMusicBed("documentary", "abc").id, pickMusicBed("documentary", "abc").id);
  const bed = MUSIC_BEDS[0];
  const a = renderMusicBedWav(bed);
  assert.ok(a.equals(renderMusicBedWav(bed)), "mismo fondo → mismos bytes");
  const frames = (a.length - 44) / 4;
  assert.equal(frames, bed.loopSeconds * 44100);
  const sample = (i: number) => a.readInt16LE(44 + (((i % frames) + frames) % frames) * 4) / 32767;
  const steps: number[] = [];
  for (let i = 1; i < frames; i++) steps.push(Math.abs(sample(i) - sample(i - 1)));
  steps.sort((x, y) => x - y);
  const p999 = steps[Math.floor(steps.length * 0.999)];
  const seam = Math.abs(sample(0) - sample(frames - 1));
  assert.ok(seam <= p999, `costura ${seam} > p99.9 ${p999}`);
});

/** Decodifica en estéreo SIN mezclar canales (el downmix de ffmpeg suma +3 dB en voz duplicada y falsearía los picos). */
function decodeStereo(file: string): Float32Array {
  const out = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "2", "-ar", "44100", "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  assert.equal(out.status, 0, String(out.stderr));
  const buf = Buffer.from(out.stdout as Buffer);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

/** Promedio de ambos canales (para medir niveles por tramo). */
function decodeMono(file: string): Float32Array {
  const st = decodeStereo(file);
  const mono = new Float32Array(st.length / 2);
  for (let i = 0; i < mono.length; i++) mono[i] = (st[2 * i] + st[2 * i + 1]) / 2;
  return mono;
}

const rmsDb = (x: Float32Array, from: number, to: number) => {
  let sum = 0;
  const a = Math.round(from * 44100);
  const b = Math.min(x.length, Math.round(to * 44100));
  for (let i = a; i < b; i++) sum += x[i] * x[i];
  return 10 * Math.log10(sum / Math.max(1, b - a) + 1e-20);
};

test(
  "masterización acotada (ffmpeg real): pico real ≤ −1,5 dBTP y sonoridad en objetivo con señales con transitorios, en todas las semillas",
  { skip: !hasFfmpeg && "ffmpeg no está disponible" },
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "atomivid-podcast-master-"));
    try {
      // Mismo tipo de señal que expone el defecto de audio-master.ts (ruido rosa con transitorios), con semillas fijas.
      for (const seed of [1, 2, 3, 10, 12]) {
        const input = path.join(dir, `in-${seed}.wav`);
        const gen = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `anoisesrc=color=pink:amplitude=0.12:d=12:seed=${seed},volume='if(lt(mod(t,0.37),0.02),4.5,1)':eval=frame`, "-c:a", "pcm_f32le", input]);
        assert.equal(gen.status, 0, String(gen.stderr));
        const report = await masterToMp3(input, path.join(dir, `out-${seed}.mp3`), { lufs: -16, ceilingDbtp: -1.5, channels: 2 }, { durationSeconds: 12 });
        assert.ok(report.after.truePeakDbtp <= -1.5, `semilla ${seed}: ${report.after.truePeakDbtp} dBTP`);
        assert.ok(Math.abs(report.after.integratedLufs - -16) <= 1, `semilla ${seed}: ${report.after.integratedLufs} LUFS`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "narración y mezcla (ffmpeg real, habla sintética): voz al frente, música baja durante la narración, entradas y salidas graduales, sin recorte",
  { skip: !hasFfmpeg && "ffmpeg no está disponible" },
  async () => {
    const parts = [0, 1, 2, 3].map((i) => ({ audio: monoWav16(speechLikeSamples(4, 20 + i)), extension: "wav", pauseAfterMs: i < 3 ? 650 : 0 }));
    const narration = await concatToMp3(parts);
    assert.ok(narration.loudness.truePeakDbtp <= -1.5);
    assert.ok(Math.abs(narration.loudness.integratedLufs - -19) <= 0.5, `narración ${narration.loudness.integratedLufs}`);
    const dir = mkdtempSync(path.join(tmpdir(), "atomivid-podcast-mix-"));
    try {
      const narrFile = path.join(dir, "narracion.mp3");
      const bedFile = path.join(dir, "fondo.wav");
      writeFileSync(narrFile, narration.audio);
      writeFileSync(bedFile, renderMusicBedWav(pickMusicBed("suspense", "x")));
      const voice = await mixNarrationWithBed({ narration: narrFile, bed: bedFile, output: path.join(dir, "voz.wav"), stem: "voice" });
      const music = await mixNarrationWithBed({ narration: narrFile, bed: bedFile, output: path.join(dir, "musica.wav"), stem: "music" });
      const v = decodeMono(voice.wavPath);
      const m = decodeMono(music.wavPath);
      const narrStart = MIX.introSeconds;
      const narrEnd = MIX.introSeconds + voice.narrationSeconds;
      const voiceDuring = rmsDb(v, narrStart + 0.5, narrEnd - 0.5);
      const musicDuring = rmsDb(m, narrStart + 0.5, narrEnd - 0.5);
      assert.ok(voiceDuring - musicDuring >= 15, `voz ${voiceDuring.toFixed(1)} dB vs música ${musicDuring.toFixed(1)} dB durante la narración`);
      const musicIntro = rmsDb(m, 3, MIX.introSeconds - MIX.duckSeconds);
      assert.ok(musicIntro - musicDuring >= 10, `la música baja al empezar la voz (${musicIntro.toFixed(1)} → ${musicDuring.toFixed(1)})`);
      assert.ok(rmsDb(m, 0, 0.05) < -45, "entra gradualmente");
      assert.ok(rmsDb(v, 0, MIX.introSeconds - 0.05) < -80, "la voz empieza después de la entrada");
      // Continuidad: la música nunca desaparece antes del final (sin cortes).
      for (let t = 0.5; t < music.durationSeconds - 1.5; t += 0.5) assert.ok(rmsDb(m, t, t + 0.5) > -70, `hueco en la música en ${t}s`);

      const full = await mixToMp3({ narration: narration.audio, bed: pickMusicBed("suspense", "x") });
      assert.ok(Math.abs(full.durationSeconds - mixTotalSeconds(voice.narrationSeconds)) < 0.2, `duración ${full.durationSeconds}`);
      assert.ok(full.loudness.truePeakDbtp <= -1.5, `pico ${full.loudness.truePeakDbtp}`);
      assert.ok(Math.abs(full.loudness.integratedLufs - -16) <= 0.5, `sonoridad ${full.loudness.integratedLufs}`);
      const mixFile = path.join(dir, "mezcla.mp3");
      writeFileSync(mixFile, full.audio);
      const st = decodeStereo(mixFile);
      let clipped = 0;
      for (const s of st) if (Math.abs(s) >= 0.999) clipped++;
      assert.equal(clipped, 0, "sin muestras recortadas en ningún canal");
      const x = decodeMono(mixFile);
      assert.ok(rmsDb(x, full.durationSeconds - 0.3, full.durationSeconds) < -45, "sale gradualmente");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ---------- Fuente: sección, migración y worker ----------

test("fuente: dos descargas por pieza, mezcla detrás de su flag, límites resueltos en el servidor y migración 0022 aditiva", () => {
  const root = path.join(__dirname, "..", "..", "..");
  const read = (...p: string[]) => readFileSync(path.join(root, ...p), "utf8");
  const page = read("src", "app", "dashboard", "tts", "page.tsx");
  assert.match(page, /downloadFileName\(j\.title, "narracion"\)/);
  assert.match(page, /downloadFileName\(j\.title, "podcast-con-musica"\)/);
  assert.match(page, /flags\.ttsMusicEnabled && !mixBusy/);
  assert.match(page, /j\.mix_status === "completed" && j\.mix_path/);
  const actions = read("src", "app", "dashboard", "tts", "actions.ts");
  assert.match(actions, /resolveTtsLimits\(user, general\)/);
  assert.match(actions, /if \(!getFeatureFlags\(\)\.ttsMusicEnabled\) redirect/);
  assert.match(actions, /requestTtsMix\(\{ service: createServiceClient\(\), userId: user\.id/);
  assert.equal(downloadFileName("Episodio 1", "narracion"), "episodio-1-narracion.mp3");
  assert.equal(downloadFileName("Episodio 1", "podcast-con-musica"), "episodio-1-podcast-con-musica.mp3");

  const migration = read("supabase", "migrations", "0022_tts_podcast.sql");
  const sql = migration.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.match(sql, /check \(char_length\(script\) between 1 and 60000\)/);
  assert.match(sql, /create unique index if not exists tts_jobs_one_active_long_pilot/);
  assert.match(sql, /music_choice in \('none', 'suspense', 'documentary'\)/);
  assert.doesNotMatch(sql, /drop\s+table|drop\s+column|truncate|delete\s+from|update\s+public\.|alter\s+column\s+\w+\s+type|rename/i);
  assert.match(read("scripts", "lib", "migration-schema-map.ts"), /name: "mix_status", migration: "0022"/);

  const workflow = read(".github", "workflows", "tts.yml");
  assert.match(workflow, /TTS_WORKER_BUDGET_SECONDS: "2700"/);
  assert.match(workflow, /timeout-minutes: 52/);
  assert.doesNotMatch(workflow, /LONG_FORM_REAL_RUN_CONFIRM|VEO_API_KEY|OPENAI_API_KEY/);
  const cleanup = read("scripts", "mark-tts-failed.ts");
  assert.match(cleanup, /eq\("mix_status", "processing"\)/);
});
