import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { VoiceProvider, VoiceSynthesisOptions } from "@/lib/providers/types";
import { fixtureVoiceProvider } from "@/lib/providers/voice/fixture";
import { generateToneWav } from "@/lib/providers/wav";
import {
  PARAGRAPH_PAUSE_MS,
  SENTENCE_PAUSE_MS,
  billableCharacters,
  downloadFileName,
  estimateSeconds,
  monthlyCharactersUsed,
  normalizeScript,
  segmentScript,
  validateTtsInput,
} from "./segment";
import { concatArgs, concatToMp3 } from "./concat";
import { createTtsRequest, retryTtsRequest, TTS_DISPATCH_FAILED_MESSAGE } from "./requests";
import { runTtsJob, ttsAudioPath, ttsStoragePrefix, type TtsDeps } from "./run-tts-job";
import { memoryDb } from "./test-db";

process.env.AUDIOVISUAL_STORAGE_RETRY_MS = "0";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const VOICE_ROW = "33333333-3333-4333-8333-333333333333";
const LIMITS = { maxCharsPerPiece: 3000, maxCharsPerUserMonth: 6000 };

// ---------- Fragmentación y validación (lógica pura) ----------

test("normalizeScript: unifica saltos, espacios y párrafos vacíos", () => {
  assert.equal(normalizeScript("  Hola\r\n\r\n\r\n\tmundo    bonito  "), "Hola\n\nmundo bonito");
});

test("segmentScript: un fragmento por párrafo corto, pausa larga entre párrafos y ninguna al final", () => {
  const segments = segmentScript("Primer párrafo. Sigue aquí.\n\nSegundo párrafo.\n\nTercero.");
  assert.deepEqual(segments.map((s) => s.text), ["Primer párrafo. Sigue aquí.", "Segundo párrafo.", "Tercero."]);
  assert.deepEqual(segments.map((s) => s.pauseAfterMs), [PARAGRAPH_PAUSE_MS, PARAGRAPH_PAUSE_MS, 0]);
  assert.equal(segments[0].previousText, undefined);
  assert.equal(segments[1].previousText, "Primer párrafo. Sigue aquí.");
  assert.equal(segments[1].nextText, "Tercero.");
});

test("segmentScript: un párrafo largo se corta entre oraciones, sin superar el máximo ni perder texto", () => {
  const sentence = "El caballero cruzó el puente de piedra mientras la niebla cubría el valle. ";
  const paragraph = sentence.repeat(40).trim();
  const segments = segmentScript(paragraph, 500);
  assert.ok(segments.length > 1);
  for (const s of segments) {
    assert.ok(s.text.length <= 500, `fragmento de ${s.text.length}`);
    assert.match(s.text, /\.$/, "termina en fin de oración");
  }
  assert.deepEqual(segments.slice(0, -1).map((s) => s.pauseAfterMs), Array(segments.length - 1).fill(SENTENCE_PAUSE_MS));
  assert.equal(segments.map((s) => s.text).join(" "), paragraph);
});

test("segmentScript: una oración más larga que el máximo se corta en una coma o entre palabras, nunca a mitad de palabra", () => {
  const long = Array.from({ length: 120 }, (_, i) => `palabra${i}`).join(" ") + ", y al final una coma, " + "otra ".repeat(50).trim() + ".";
  const segments = segmentScript(long, 300);
  const words = long.split(/\s+/);
  const rebuilt = segments.map((s) => s.text).join(" ").split(/\s+/);
  assert.deepEqual(rebuilt, words, "mismas palabras, mismo orden");
  for (const s of segments) assert.ok(s.text.length <= 300);
});

test("estimaciones: caracteres cobrables = texto narrado; duración incluye las pausas", () => {
  const segments = segmentScript("Hola mundo.\n\nAdiós.");
  assert.equal(billableCharacters(segments), "Hola mundo.".length + "Adiós.".length);
  assert.equal(estimateSeconds(segments), Math.round(((17 / 15) + PARAGRAPH_PAUSE_MS / 1000) * 10) / 10);
});

test("validateTtsInput: título, idioma, texto, máximo por pieza y saldo del mes", () => {
  const base = { title: "Episodio", script: "Hola.", language: "es" };
  assert.ok(validateTtsInput(base, { ...LIMITS, usedThisMonth: 0 }).ok);
  assert.deepEqual(validateTtsInput({ ...base, title: " " }, { ...LIMITS, usedThisMonth: 0 }), { ok: false, error: "Escribe un título." });
  assert.equal(validateTtsInput({ ...base, language: "fr" }, { ...LIMITS, usedThisMonth: 0 }).ok, false);
  assert.equal(validateTtsInput({ ...base, script: "\n \n" }, { ...LIMITS, usedThisMonth: 0 }).ok, false);
  const long = validateTtsInput({ ...base, script: "a".repeat(3001) }, { ...LIMITS, usedThisMonth: 0 });
  assert.match(long.ok ? "" : long.error, /máximo por pieza es 3\.000/);
  const month = validateTtsInput({ ...base, script: "a".repeat(100) }, { ...LIMITS, usedThisMonth: 5950 });
  assert.match(month.ok ? "" : month.error, /te quedan 50 caracteres/);
});

test("consumo mensual: cuentan piezas en curso/listas y las fallidas que llegaron a generar algo", () => {
  assert.equal(
    monthlyCharactersUsed([
      { characters: 100, status: "completed", segments_done: 2 },
      { characters: 50, status: "queued", segments_done: 0 },
      { characters: 70, status: "failed", segments_done: 0 },
      { characters: 30, status: "failed", segments_done: 1 },
    ]),
    180,
  );
});

test("downloadFileName: nombre seguro sin tildes ni símbolos", () => {
  assert.equal(downloadFileName("Episodio 12: ¿Quién construyó Göbekli Tepe?"), "episodio-12-quien-construyo-gobekli-tepe.mp3");
  assert.equal(downloadFileName("¡¿!?"), "texto-a-voz.mp3");
});

// ---------- Unión con ffmpeg ----------

test("concatArgs: cada fragmento seguido de su silencio y un único concat a MP3", () => {
  const args = concatArgs(["a.mp3", "b.mp3", "c.mp3"], [650, 180, 0], "out.mp3");
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.match(graph, /atrim=duration=0\.650\[s0\]/);
  assert.match(graph, /atrim=duration=0\.180\[s1\]/);
  assert.doesNotMatch(graph, /\[s2\]/);
  assert.match(graph, /\[a0\]\[s0\]\[a1\]\[s1\]\[a2\]concat=n=5:v=0:a=1\[out\]/);
  assert.deepEqual(args.slice(-5), ["-c:a", "libmp3lame", "-b:a", "128k", "out.mp3"]);
});

test("concatToMp3 (ffmpeg real): la duración final es la suma de fragmentos y pausas", async () => {
  const one = generateToneWav({ durationSeconds: 1, frequencyHz: 220, amplitude: 0.1 });
  const two = generateToneWav({ durationSeconds: 1.5, frequencyHz: 330, amplitude: 0.1 });
  const result = await concatToMp3([
    { audio: one, extension: "wav", pauseAfterMs: 500 },
    { audio: two, extension: "wav", pauseAfterMs: 0 },
  ]);
  assert.ok(Math.abs(result.durationSeconds - 3) < 0.15, `duración ${result.durationSeconds}`);
  assert.equal(result.audio.subarray(0, 3).toString("latin1") === "ID3" || result.audio[0] === 0xff, true, "es MP3");
});

// ---------- Crear y reintentar piezas ----------

const readyVoice = (over: Record<string, unknown> = {}) => ({
  id: VOICE_ROW,
  user_id: OWNER,
  name: "Mi voz",
  status: "ready",
  provider_voice_id: "privateProviderVoice01",
  deleted_at: null,
  ...over,
});

function form(over: Record<string, unknown> = {}) {
  return { title: "Episodio 1", script: "Primer párrafo.\n\nSegundo párrafo.", language: "es", voice: "miguel", clientRequestId: "44444444-4444-4444-8444-444444444444", ...over };
}

test("crear: guarda la pieza con su voz y estimación, y la encola una vez", async () => {
  const db = memoryDb();
  const dispatched: string[] = [];
  const result = await createTtsRequest({ service: db.client, userId: OWNER, form: form(), limits: LIMITS, dispatch: async (id) => void dispatched.push(id) });
  assert.ok(result.ok && !result.duplicate);
  const [row] = db.rows("tts_jobs");
  assert.equal(row.voice_choice, "miguel");
  assert.equal(row.voice_label, "Miguel");
  assert.equal(row.status, "queued");
  assert.equal(row.characters, "Primer párrafo.".length + "Segundo párrafo.".length);
  assert.equal(row.segments_total, 2);
  assert.ok((row.estimated_seconds as number) > 0);
  assert.deepEqual(dispatched, [row.id]);
});

test("doble envío: el mismo formulario devuelve la misma pieza, sin crear otra ni volver a encolarla", async () => {
  const db = memoryDb();
  const dispatched: string[] = [];
  const dispatch = async (id: string) => void dispatched.push(id);
  const first = await createTtsRequest({ service: db.client, userId: OWNER, form: form(), limits: LIMITS, dispatch });
  const second = await createTtsRequest({ service: db.client, userId: OWNER, form: form(), limits: LIMITS, dispatch });
  assert.ok(first.ok && second.ok);
  assert.equal(second.jobId, first.jobId);
  assert.equal(second.duplicate, true);
  assert.equal(db.rows("tts_jobs").length, 1);
  assert.equal(dispatched.length, 1);
  // Otra usuaria con el mismo id de formulario es otra pieza (la unicidad es por usuaria).
  const other = await createTtsRequest({ service: db.client, userId: OTHER, form: form(), limits: LIMITS, dispatch });
  assert.ok(other.ok && other.jobId !== first.jobId);
});

test("crear: sin id de formulario, con voz ajena o sin saldo mensual se rechaza sin guardar nada", async () => {
  const db = memoryDb({ user_voices: [readyVoice({ user_id: OTHER })] });
  const dispatch = async () => assert.fail("no debe encolar");
  const noId = await createTtsRequest({ service: db.client, userId: OWNER, form: form({ clientRequestId: "x" }), limits: LIMITS, dispatch });
  assert.equal(noId.ok, false);
  const foreign = await createTtsRequest({ service: db.client, userId: OWNER, form: form({ voice: `custom:${VOICE_ROW}` }), limits: LIMITS, dispatch });
  assert.deepEqual(foreign, { ok: false, error: "Esa voz no existe o no es tuya. Elige otra voz." });
  const tatianaEn = await createTtsRequest({ service: db.client, userId: OWNER, form: form({ voice: "tatiana", language: "en" }), limits: LIMITS, dispatch });
  assert.equal(tatianaEn.ok, false);
  const rawProviderId = await createTtsRequest({ service: db.client, userId: OWNER, form: form({ voice: "privateProviderVoice01" }), limits: LIMITS, dispatch });
  assert.deepEqual(rawProviderId, { ok: false, error: "Elige una voz válida." });
  assert.equal(db.rows("tts_jobs").length, 0);

  const full = memoryDb({ tts_jobs: [{ id: "old", user_id: OWNER, characters: 5990, status: "completed", segments_done: 5, created_at: new Date().toISOString() }] });
  const noQuota = await createTtsRequest({ service: full.client, userId: OWNER, form: form(), limits: LIMITS, dispatch });
  assert.match(noQuota.ok ? "" : noQuota.error, /te quedan 10 caracteres/);
});

test("crear: si no se puede encolar, la pieza queda fallida con un mensaje claro y se puede reintentar", async () => {
  const db = memoryDb();
  const result = await createTtsRequest({ service: db.client, userId: OWNER, form: form(), limits: LIMITS, dispatch: async () => { throw new Error("GH caído"); } });
  assert.ok(result.ok);
  const [row] = db.rows("tts_jobs");
  assert.equal(row.status, "failed");
  assert.equal(row.error_message, TTS_DISPATCH_FAILED_MESSAGE);

  const dispatched: string[] = [];
  assert.deepEqual(await retryTtsRequest({ service: db.client, userId: OTHER, jobId: row.id, dispatch: async (id) => void dispatched.push(id) }), {
    ok: false,
    error: "Esa pieza no existe, no es tuya o no está fallida.",
  });
  assert.equal(row.status, "failed", "una usuaria ajena no puede reintentarla");
  assert.deepEqual(await retryTtsRequest({ service: db.client, userId: OWNER, jobId: row.id, dispatch: async (id) => void dispatched.push(id) }), { ok: true });
  assert.equal(row.status, "queued");
  assert.equal(row.error_message, null);
  assert.deepEqual(dispatched, [row.id]);
  // Un segundo reintento sobre una pieza ya en cola no hace nada.
  assert.equal((await retryTtsRequest({ service: db.client, userId: OWNER, jobId: row.id, dispatch: async () => assert.fail() })).ok, false);
});

// ---------- Worker ----------

type Call = { text: string; options?: VoiceSynthesisOptions };

/** Proveedor «real» simulado: devuelve WAV y registra cada llamada; `fail(i)` decide si la llamada i falla y cómo. */
function recordingProvider(fail: (callIndex: number, text: string) => Error | null = () => null) {
  const calls: Call[] = [];
  const provider: VoiceProvider = {
    name: "elevenlabs",
    async synthesize(text, _language, _speed, options) {
      const index = calls.length;
      calls.push({ text, options });
      const err = fail(index, text);
      if (err) throw err;
      const durationSeconds = 0.4;
      return { audioBuffer: generateToneWav({ durationSeconds, frequencyHz: 200 + index, amplitude: 0.1 }), durationSeconds, words: [], mimeType: "audio/wav", extension: "wav" };
    },
  };
  return { provider, calls };
}

const SCRIPT = "Primer párrafo del episodio.\n\nSegundo párrafo, con más detalle.\n\nTercer párrafo y cierre.";

function jobRow(over: Record<string, unknown> = {}) {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    user_id: OWNER,
    title: "Episodio",
    language: "es",
    voice_choice: "norah",
    script: SCRIPT,
    characters: billableCharacters(segmentScript(SCRIPT)),
    status: "queued",
    attempts: 0,
    segments_done: 0,
    ...over,
  };
}

const fakeConcat: TtsDeps["concat"] = async (parts) => ({ audio: Buffer.concat(parts.map((p) => p.audio)), durationSeconds: parts.length * 0.4 });
const deps = (db: ReturnType<typeof memoryDb>, provider: VoiceProvider, over: Partial<TtsDeps> = {}): TtsDeps => ({
  service: db.client,
  voiceProvider: provider,
  concat: fakeConcat,
  quota: async () => ({ remaining: 100000 }),
  ...over,
});

test("worker: genera cada fragmento con la voz elegida y su contexto, une, guarda y completa", async () => {
  const db = memoryDb({ tts_jobs: [jobRow()] });
  const { provider, calls } = recordingProvider();
  assert.equal(await runTtsJob(jobRow().id, deps(db, provider)), "completed");
  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal(call.options?.voice?.providerVoiceId, "kcQkGnn0HAT2JRDQ4Ljp", "la voz elegida llega al proveedor");
  assert.equal(calls[1].options?.previousText, "Primer párrafo del episodio.");
  assert.equal(calls[1].options?.nextText, "Tercer párrafo y cierre.");
  const [row] = db.rows("tts_jobs");
  assert.equal(row.status, "completed");
  assert.equal(row.attempts, 1);
  assert.equal(row.segments_done, 3);
  assert.equal(row.segments_total, 3);
  assert.equal(row.audio_path, ttsAudioPath(row.id as string));
  assert.ok(db.storage.files.has(ttsAudioPath(row.id as string)));
  const ledger = db.storage.json<{ entries: { status: string }[]; capUsd: number }>(`${ttsStoragePrefix(row.id as string)}/state/paid-ledger.json`);
  assert.deepEqual(ledger?.entries.map((e) => e.status), ["spent", "spent", "spent"], "cada fragmento queda registrado como gasto");
  // Un segundo disparo del mismo trabajo no hace nada.
  assert.equal(await runTtsJob(row.id as string, deps(db, provider)), "skipped");
  assert.equal(calls.length, 3);
});

test("worker: solo reclama piezas en cola (una en proceso o fallida no se toca)", async () => {
  for (const status of ["processing", "failed", "completed"]) {
    const db = memoryDb({ tts_jobs: [jobRow({ status })] });
    const { provider, calls } = recordingProvider();
    assert.equal(await runTtsJob(jobRow().id, deps(db, provider)), "skipped");
    assert.equal(calls.length, 0);
  }
});

test("recuperación: un fallo sin cobro a mitad de pieza conserva lo generado; el reintento no vuelve a pagarlo", async () => {
  const db = memoryDb({ tts_jobs: [jobRow()] });
  let failSecond = true;
  const { provider, calls } = recordingProvider((_, text) => {
    if (failSecond && text.startsWith("Segundo")) {
      failSecond = false;
      return new Error("ElevenLabs respondió 400: texto rechazado");
    }
    return null;
  });
  assert.equal(await runTtsJob(jobRow().id, deps(db, provider)), "failed");
  const [row] = db.rows("tts_jobs");
  assert.equal(row.status, "failed");
  assert.equal(row.segments_done, 1);
  assert.match(String(row.error_message), /puedes reintentar sin volver a pagarlos/);

  assert.ok((await retryTtsRequest({ service: db.client, userId: OWNER, jobId: row.id, dispatch: async () => {} })).ok);
  assert.equal(await runTtsJob(row.id as string, deps(db, provider)), "completed");
  assert.deepEqual(
    calls.map((c) => c.text.split(" ")[0]),
    ["Primer", "Segundo", "Segundo", "Tercer"],
    "el primer fragmento no se vuelve a sintetizar",
  );
  assert.equal(row.attempts, 2);
});

test("recuperación: un fallo incierto (pudo cobrarse) detiene la pieza y el reintento no lo repite", async () => {
  const db = memoryDb({ tts_jobs: [jobRow()] });
  const { provider, calls } = recordingProvider((_, text) => (text.startsWith("Segundo") ? new Error("ElevenLabs respondió 500: error interno") : null));
  assert.equal(await runTtsJob(jobRow().id, deps(db, provider)), "failed");
  const [row] = db.rows("tts_jobs");
  assert.match(String(row.error_message), /estado incierto/);
  assert.ok((await retryTtsRequest({ service: db.client, userId: OWNER, jobId: row.id, dispatch: async () => {} })).ok);
  assert.equal(await runTtsJob(row.id as string, deps(db, provider)), "failed");
  assert.equal(calls.filter((c) => c.text.startsWith("Segundo")).length, 1, "nunca se envía dos veces un fragmento que pudo cobrarse");
  assert.match(String(row.error_message), /estado incierto/);
});

test("worker: sin caracteres suficientes en la cuenta no se sintetiza nada", async () => {
  const db = memoryDb({ tts_jobs: [jobRow()] });
  const { provider, calls } = recordingProvider();
  assert.equal(await runTtsJob(jobRow().id, deps(db, provider, { quota: async () => ({ remaining: 20 }) })), "failed");
  assert.equal(calls.length, 0);
  assert.match(String(db.rows("tts_jobs")[0].error_message), /no tiene caracteres suficientes/);
});

test("worker: una voz privada eliminada o ajena detiene la pieza con el motivo, sin cambiar de voz", async () => {
  for (const voice of [readyVoice({ status: "deleted" }), readyVoice({ user_id: OTHER })]) {
    const db = memoryDb({ tts_jobs: [jobRow({ voice_choice: `custom:${VOICE_ROW}` })], user_voices: [voice] });
    const { provider, calls } = recordingProvider();
    assert.equal(await runTtsJob(jobRow().id, deps(db, provider)), "failed");
    assert.equal(calls.length, 0);
    assert.match(String(db.rows("tts_jobs")[0].error_message), /fue eliminada|no es tuya/);
  }
  const db = memoryDb({ tts_jobs: [jobRow({ voice_choice: `custom:${VOICE_ROW}` })], user_voices: [readyVoice()] });
  const { provider, calls } = recordingProvider();
  assert.equal(await runTtsJob(jobRow().id, deps(db, provider)), "completed");
  assert.equal(calls[0].options?.voice?.providerVoiceId, "privateProviderVoice01");
  assert.equal(calls[0].options?.voice?.ownerId, OWNER);
});

test("prueba larga con el código real (fixture, ffmpeg real): ~2.900 caracteres en fragmentos con pausas → un MP3", async () => {
  const paragraph = "La historia del castillo empezó con una sola torre de piedra, levantada sobre la colina para vigilar el río. Con los siglos crecieron las murallas, los patios y los pasillos oscuros que todavía hoy sorprenden a quien los recorre. ";
  const script = Array.from({ length: 6 }, () => paragraph.repeat(2).trim()).join("\n\n");
  const segments = segmentScript(script);
  assert.ok(billableCharacters(segments) > 2500 && billableCharacters(segments) <= 3000);
  const db = memoryDb({ tts_jobs: [jobRow({ script, characters: billableCharacters(segments), voice_choice: "miguel" })] });
  assert.equal(await runTtsJob(jobRow().id, deps(db, fixtureVoiceProvider, { concat: concatToMp3 })), "completed");
  const [row] = db.rows("tts_jobs");
  assert.equal(row.segments_done, segments.length);
  const audio = db.storage.files.get(ttsAudioPath(row.id as string))!;
  assert.ok(audio.length > 10000);
  assert.ok((row.duration_seconds as number) > 100, `duración ${row.duration_seconds}`);
});

test("la sección existe detrás de su flag, con enlace en el menú y acciones que validan en el servidor", () => {
  const app = path.join(__dirname, "..", "..", "app");
  const read = (...p: string[]) => readFileSync(path.join(app, ...p), "utf8");
  const page = read("dashboard", "tts", "page.tsx");
  assert.match(page, /if \(!flags\.textToSpeechEnabled\) notFound\(\)/);
  assert.match(page, /clientRequestId=\{randomUUID\(\)\}/);
  assert.match(page, /createSignedUrl\(j\.audio_path!, 3600, \{ download: downloadFileName\(j\.title\) \}\)/);
  const actions = read("dashboard", "tts", "actions.ts");
  assert.match(actions, /textToSpeechEnabled\) redirect/);
  assert.match(actions, /createTtsRequest\(\{/);
  assert.match(actions, /retryTtsRequest\(\{ service: createServiceClient\(\), userId: user\.id/);
  const layout = read("dashboard", "layout.tsx");
  assert.equal((layout.match(/flags\.textToSpeechEnabled &&/g) ?? []).length, 2, "escritorio y móvil");
  const workflow = readFileSync(path.join(__dirname, "..", "..", "..", ".github", "workflows", "tts.yml"), "utf8");
  assert.match(workflow, /types: \[text-to-speech\]/);
  assert.match(workflow, /mark-tts-failed\.ts/);
  assert.doesNotMatch(workflow, /LONG_FORM_REAL_RUN_CONFIRM|VEO_API_KEY|OPENAI_API_KEY/);
});
