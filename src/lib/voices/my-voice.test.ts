import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { VoiceProvider, VoiceSynthesisOptions } from "@/lib/providers/types";
import { generateToneWav } from "@/lib/providers/wav";
import { memoryDb } from "@/lib/tts/test-db";
import { resolveVoiceChoice, VoiceUnavailableError } from "./resolve";
import { listReadyUserVoices } from "./user-voices";
import { createUserVoice, deleteUserVoice, retryUserVoice, VOICE_DISPATCH_FAILED_MESSAGE } from "./requests";
import { runVoiceCloneJob, type CloneDeps } from "./clone-job";
import { VOICE_CONSENT_VERSION, detectSampleFormat, sampleDurationIssue, samplePath, validateVoiceName } from "./sample";

process.env.AUDIOVISUAL_STORAGE_RETRY_MS = "0";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const REQ = "66666666-6666-4666-8666-666666666666";

const wav = () => generateToneWav({ durationSeconds: 0.5, frequencyHz: 220, amplitude: 0.1 });
const file = (bytes: Uint8Array | Buffer, name = "muestra.wav") => new File([new Uint8Array(bytes)], name);

function form(over: Record<string, unknown> = {}) {
  return { name: "Mi voz de podcast", consentOwnVoice: "on", consentProcessing: "on", keepSample: null, clientRequestId: REQ, clientSeconds: "60", file: file(wav()), ...over };
}

// ---------- Reglas puras ----------

test("formato por bytes: WAV, MP3, M4A, WEBM y OGG; cualquier otra cosa se rechaza", () => {
  const pad = (head: number[] | string) => {
    const b = new Uint8Array(16);
    const src = typeof head === "string" ? [...head].map((c) => c.charCodeAt(0)) : head;
    b.set(src);
    return b;
  };
  assert.equal(detectSampleFormat(new Uint8Array(wav()))?.extension, "wav");
  assert.equal(detectSampleFormat(pad("ID3\u0004"))?.extension, "mp3");
  assert.equal(detectSampleFormat(pad([0xff, 0xfb, 0x90]))?.extension, "mp3");
  assert.equal(detectSampleFormat(pad("\u0000\u0000\u0000\u0018ftypM4A "))?.extension, "m4a");
  assert.equal(detectSampleFormat(pad([0x1a, 0x45, 0xdf, 0xa3]))?.extension, "webm");
  assert.equal(detectSampleFormat(pad("OggS"))?.extension, "ogg");
  assert.equal(detectSampleFormat(pad("%PDF-1.7")), null);
  assert.equal(detectSampleFormat(new Uint8Array(4)), null);
});

test("duración: entre 30 s y 3 min; nombre: 1-40 caracteres", () => {
  assert.match(sampleDurationIssue(12) ?? "", /al menos 30 s/);
  assert.equal(sampleDurationIssue(30), null);
  assert.equal(sampleDurationIssue(180), null);
  assert.match(sampleDurationIssue(181) ?? "", /máximo es 3 min/);
  assert.match(sampleDurationIssue(NaN) ?? "", /No se pudo leer/);
  assert.deepEqual(validateVoiceName("  Mi   voz "), { ok: true, name: "Mi voz" });
  assert.equal(validateVoiceName("").ok, false);
  assert.equal(validateVoiceName("x".repeat(41)).ok, false);
});

test("muestra (ffmpeg real): cualquier formato admitido → MP3 mono y duración medida en el worker", async () => {
  const { prepareSampleWithFfmpeg } = await import("./clone-deps");
  const sample = generateToneWav({ durationSeconds: 2.5, frequencyHz: 180, amplitude: 0.2 });
  const prepared = await prepareSampleWithFfmpeg(sample, "wav");
  assert.ok(Math.abs(prepared.durationSeconds - 2.5) < 0.1, `duración ${prepared.durationSeconds}`);
  assert.equal(detectSampleFormat(new Uint8Array(prepared.audio))?.extension, "mp3");
  await assert.rejects(prepareSampleWithFfmpeg(Buffer.from("no es audio"), "wav"));
});

// ---------- Crear, reintentar ----------

test("crear: guarda consentimiento y muestra en la carpeta de la usuaria y encola una vez; el doble envío devuelve la misma voz", async () => {
  const db = memoryDb();
  const dispatched: string[] = [];
  const dispatch = async (id: string) => void dispatched.push(id);
  const first = await createUserVoice({ service: db.client, userId: OWNER, form: form(), maxVoicesPerUser: 1, maxVoicesTotal: 3, dispatch });
  assert.ok(first.ok && !first.duplicate);
  const [row] = db.rows("user_voices");
  assert.equal(row.status, "uploaded");
  assert.equal(row.consent_version, VOICE_CONSENT_VERSION);
  assert.ok(row.consent_at);
  assert.equal(row.keep_sample, false);
  assert.equal(row.sample_path, samplePath(OWNER, row.id as string, "wav"));
  assert.ok(db.storage.files.has(row.sample_path as string));
  assert.deepEqual(dispatched, [row.id]);
  const again = await createUserVoice({ service: db.client, userId: OWNER, form: form(), maxVoicesPerUser: 1, maxVoicesTotal: 3, dispatch });
  assert.ok(again.ok && again.duplicate && again.voiceId === first.voiceId);
  assert.equal(db.rows("user_voices").length, 1);
  assert.equal(dispatched.length, 1);
});

test("crear: sin consentimiento, sin muestra, muy grande, formato desconocido, duración fuera de rango o cupo lleno → rechazo sin guardar", async () => {
  const db = memoryDb();
  const dispatch = async () => assert.fail("no debe encolar");
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ consentProcessing: null }, /consentimiento/],
    [{ consentOwnVoice: "off" }, /consentimiento/],
    [{ file: null }, /Graba o sube/],
    [{ file: file(new Uint8Array(10 * 1024 * 1024 + 1)) }, /supera 10 MB/],
    [{ file: file(Buffer.from("%PDF-1.7 no es audio")) }, /Formato no reconocido/],
    [{ clientSeconds: "8" }, /entre 30 s y 3 min/],
    [{ name: "" }, /nombre/],
    [{ clientRequestId: "abc" }, /Recarga/],
  ];
  for (const [over, error] of cases) {
    const result = await createUserVoice({ service: db.client, userId: OWNER, form: form(over), maxVoicesPerUser: 1, maxVoicesTotal: 3, dispatch });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, error);
  }
  assert.equal(db.rows("user_voices").length, 0);
  assert.equal(db.storage.files.size, 0);

  const full = memoryDb({ user_voices: [{ id: "v1", user_id: OWNER, client_request_id: "x", status: "ready" }] });
  const limit = await createUserVoice({ service: full.client, userId: OWNER, form: form(), maxVoicesPerUser: 1, maxVoicesTotal: 3, dispatch });
  assert.deepEqual(limit, { ok: false, error: "Ya tienes una voz propia. Elimínala para crear otra." });
  // Una voz fallida o eliminada no ocupa el cupo; otra usuaria tampoco cuenta.
  const freed = memoryDb({ user_voices: [{ id: "v1", user_id: OWNER, client_request_id: "x", status: "deleted" }, { id: "v2", user_id: OTHER, client_request_id: "y", status: "ready" }] });
  assert.ok((await createUserVoice({ service: freed.client, userId: OWNER, form: form(), maxVoicesPerUser: 1, maxVoicesTotal: 3, dispatch: async () => {} })).ok);
});

test("crear: si no se puede encolar queda fallida y se puede reintentar (solo su dueña)", async () => {
  const db = memoryDb();
  assert.ok((await createUserVoice({ service: db.client, userId: OWNER, form: form(), maxVoicesPerUser: 1, maxVoicesTotal: 3, dispatch: async () => { throw new Error("GH caído"); } })).ok);
  const [row] = db.rows("user_voices");
  assert.equal(row.status, "failed");
  assert.equal(row.error_message, VOICE_DISPATCH_FAILED_MESSAGE);
  assert.equal((await retryUserVoice({ service: db.client, userId: OTHER, voiceId: row.id, dispatch: async () => assert.fail() })).ok, false);
  const dispatched: string[] = [];
  assert.ok((await retryUserVoice({ service: db.client, userId: OWNER, voiceId: row.id, dispatch: async (id) => void dispatched.push(id) })).ok);
  assert.equal(row.status, "uploaded");
  assert.deepEqual(dispatched, [row.id]);
});

// ---------- Worker de clonación ----------

function recordingVoiceProvider() {
  const calls: { text: string; options?: VoiceSynthesisOptions }[] = [];
  const provider: VoiceProvider = {
    name: "elevenlabs",
    async synthesize(text, _l, _s, options) {
      calls.push({ text, options });
      return { audioBuffer: wav(), durationSeconds: 0.5, words: [], mimeType: "audio/mpeg", extension: "mp3" };
    },
  };
  return { provider, calls };
}

async function uploadedVoice(over: Record<string, unknown> = {}) {
  const db = memoryDb();
  assert.ok((await createUserVoice({ service: db.client, userId: OWNER, form: form(over), maxVoicesPerUser: 1, maxVoicesTotal: 3, dispatch: async () => {} })).ok);
  return { db, row: db.rows("user_voices")[0] };
}

function cloneDeps(db: ReturnType<typeof memoryDb>, over: Partial<CloneDeps> & { seconds?: number } = {}) {
  const cloneCalls: { name: string; mimeType: string }[] = [];
  const { provider, calls } = recordingVoiceProvider();
  const deps: CloneDeps = {
    service: db.client,
    voiceProvider: provider,
    prepareSample: async (audio) => ({ audio, durationSeconds: over.seconds ?? 65 }),
    slots: async () => ({ used: 0, limit: 10 }),
    clone: async (input) => {
      cloneCalls.push({ name: input.name, mimeType: input.mimeType });
      return "providerVoiceNew01";
    },
    ...over,
  };
  return { deps, cloneCalls, synthCalls: calls };
}

test("clonar: muestra → clon → prueba corta con la voz nueva → lista; la grabación original se borra y el nombre en el proveedor es neutro", async () => {
  const { db, row } = await uploadedVoice();
  const { deps, cloneCalls, synthCalls } = cloneDeps(db);
  const sample = row.sample_path as string;
  assert.equal(await runVoiceCloneJob(row.id as string, deps), "ready");
  assert.equal(row.status, "ready");
  assert.equal(row.provider_voice_id, "providerVoiceNew01");
  assert.equal(row.sample_seconds, 65);
  assert.equal(cloneCalls.length, 1);
  assert.doesNotMatch(cloneCalls[0].name, /podcast/i, "el nombre de la usuaria no viaja al proveedor");
  assert.equal(synthCalls.length, 1);
  assert.equal(synthCalls[0].options?.voice?.providerVoiceId, "providerVoiceNew01");
  assert.equal(synthCalls[0].options?.voice?.ownerId, OWNER);
  assert.ok(db.storage.files.has(row.test_audio_path as string));
  assert.equal(row.sample_path, null);
  assert.equal(db.storage.files.has(sample), false, "sin pedir conservarla, la muestra se borra");
  assert.equal(await runVoiceCloneJob(row.id as string, deps), "skipped", "un segundo disparo no clona otra vez");
  assert.equal(cloneCalls.length, 1);
  // Ya se puede elegir, solo por su dueña.
  assert.equal((await listReadyUserVoices(db.client, OWNER)).length, 1);
  assert.equal((await listReadyUserVoices(db.client, OTHER)).length, 0, "una voz privada nunca aparece a otra usuaria");
  await assert.rejects(resolveVoiceChoice({ service: db.client, userId: OTHER, choice: { kind: "custom", id: row.id as string }, language: "es" }), VoiceUnavailableError);
});

test("clonar: con «conservar grabación» la muestra se mantiene", async () => {
  const { db, row } = await uploadedVoice({ keepSample: "on" });
  const sample = row.sample_path as string;
  assert.equal(await runVoiceCloneJob(row.id as string, cloneDeps(db).deps), "ready");
  assert.equal(row.sample_path, sample);
  assert.ok(db.storage.files.has(sample));
});

test("clonar: duración real fuera de rango o sin espacios libres → falla sin enviar la muestra", async () => {
  for (const over of [{ seconds: 12 }, { slots: async () => ({ used: 10, limit: 10 }) }, { slots: async () => null }]) {
    const { db, row } = await uploadedVoice();
    const { deps, cloneCalls } = cloneDeps(db, over);
    assert.equal(await runVoiceCloneJob(row.id as string, deps), "failed");
    assert.equal(cloneCalls.length, 0);
    assert.equal(row.needs_review, false);
    assert.ok(row.sample_path, "la muestra se conserva mientras la voz no esté lista");
  }
});

test("clonar: un rechazo del proveedor permite reintentar; un fallo incierto queda en revisión y no se repite", async () => {
  const rejected = await uploadedVoice();
  let attempt = 0;
  const flaky = cloneDeps(rejected.db, {
    clone: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("ElevenLabs respondió 422: audio inválido");
      return "providerVoiceRetry";
    },
  });
  assert.equal(await runVoiceCloneJob(rejected.row.id as string, flaky.deps), "failed");
  assert.match(String(rejected.row.error_message), /rechazó la muestra/);
  assert.ok((await retryUserVoice({ service: rejected.db.client, userId: OWNER, voiceId: rejected.row.id, dispatch: async () => {} })).ok);
  assert.equal(await runVoiceCloneJob(rejected.row.id as string, flaky.deps), "ready");
  assert.equal(rejected.row.provider_voice_id, "providerVoiceRetry");

  const uncertain = await uploadedVoice();
  const cut = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
  const lost = cloneDeps(uncertain.db, { clone: async () => { throw cut; } });
  assert.equal(await runVoiceCloneJob(uncertain.row.id as string, lost.deps), "failed");
  assert.equal(uncertain.row.needs_review, true);
  assert.match(String(uncertain.row.error_message), /estado incierto/);
  const retry = await retryUserVoice({ service: uncertain.db.client, userId: OWNER, voiceId: uncertain.row.id, dispatch: async () => assert.fail() });
  assert.match(retry.ok ? "" : retry.error, /en revisión/);
});

test("reintento con la voz ya creada: solo repite la prueba corta, nunca vuelve a clonar", async () => {
  const { db, row } = await uploadedVoice();
  let failTest = true;
  const { deps, cloneCalls } = cloneDeps(db);
  deps.voiceProvider = {
    name: "elevenlabs",
    async synthesize() {
      if (failTest) {
        failTest = false;
        throw new Error("ElevenLabs respondió 429: demasiadas solicitudes");
      }
      return { audioBuffer: wav(), durationSeconds: 0.5, words: [], mimeType: "audio/mpeg", extension: "mp3" };
    },
  };
  assert.equal(await runVoiceCloneJob(row.id as string, deps), "failed");
  assert.equal(row.provider_voice_id, "providerVoiceNew01");
  assert.ok((await retryUserVoice({ service: db.client, userId: OWNER, voiceId: row.id, dispatch: async () => {} })).ok);
  assert.equal(row.status, "testing");
  assert.equal(await runVoiceCloneJob(row.id as string, deps), "ready");
  assert.equal(cloneCalls.length, 1);
});

// ---------- Eliminar ----------

test("eliminar: solo la dueña; primero en el proveedor, luego muestra y prueba; los audios ya generados no se tocan", async () => {
  const { db, row } = await uploadedVoice({ keepSample: "on" });
  assert.equal(await runVoiceCloneJob(row.id as string, cloneDeps(db).deps), "ready");
  db.storage.files.set("tts/job-1/audio.mp3", Buffer.from("audio ya generado"));
  const providerDeletes: string[] = [];
  const del = async (id: string) => (providerDeletes.push(id), "deleted" as const);

  assert.deepEqual(await deleteUserVoice({ service: db.client, userId: OTHER, voiceId: row.id, deleteProviderVoice: del }), { ok: false, error: "Esa voz no existe o no es tuya." });
  assert.equal(row.status, "ready");
  assert.equal(providerDeletes.length, 0);

  const sample = row.sample_path as string;
  const testAudio = row.test_audio_path as string;
  assert.deepEqual(await deleteUserVoice({ service: db.client, userId: OWNER, voiceId: row.id, deleteProviderVoice: del }), { ok: true });
  assert.deepEqual(providerDeletes, ["providerVoiceNew01"]);
  assert.equal(row.status, "deleted");
  assert.ok(row.deleted_at);
  assert.equal(db.storage.files.has(sample), false);
  assert.equal(db.storage.files.has(testAudio), false);
  assert.ok(db.storage.files.has("tts/job-1/audio.mp3"), "los audios generados siguen disponibles");
  await assert.rejects(resolveVoiceChoice({ service: db.client, userId: OWNER, choice: { kind: "custom", id: row.id as string }, language: "es" }), /fue eliminada/);
  assert.equal((await listReadyUserVoices(db.client, OWNER)).length, 0);
});

test("eliminar: si el proveedor falla, la voz queda como estaba y no se borra nada", async () => {
  const { db, row } = await uploadedVoice({ keepSample: "on" });
  assert.equal(await runVoiceCloneJob(row.id as string, cloneDeps(db).deps), "ready");
  const result = await deleteUserVoice({ service: db.client, userId: OWNER, voiceId: row.id, deleteProviderVoice: async () => { throw new Error("ElevenLabs respondió 500"); } });
  assert.equal(result.ok, false);
  assert.equal(row.status, "ready");
  assert.ok(db.storage.files.has(row.sample_path as string));
});

test("la sección existe detrás de su flag y sus acciones usan el usuario de la sesión", () => {
  const app = path.join(__dirname, "..", "..", "app");
  const read = (...p: string[]) => readFileSync(path.join(app, ...p), "utf8");
  const page = read("dashboard", "voices", "page.tsx");
  assert.match(page, /if \(!user \|\| !canUseMyVoice\(user\)\) notFound\(\)/);
  assert.match(page, /\.neq\("status", "deleted"\)/);
  const actions = read("dashboard", "voices", "actions.ts");
  assert.match(actions, /if \(!canUseMyVoice\(user\)\) redirect/);
  assert.equal((actions.match(/userId: user\.id/g) ?? []).length, 3, "crear, reintentar y eliminar con el id de la sesión");
  const layout = read("dashboard", "layout.tsx");
  assert.equal((layout.match(/canUseMyVoice\(user\) &&/g) ?? []).length, 2);
  const form = read("dashboard", "voices", "VoiceForm.tsx");
  assert.match(form, /name="consent_own_voice" required/);
  assert.match(form, /name="consent_processing" required/);
  const workflow = readFileSync(path.join(__dirname, "..", "..", "..", ".github", "workflows", "voice-clone.yml"), "utf8");
  assert.match(workflow, /types: \[clone-voice\]/);
  assert.match(workflow, /mark-voice-clone-failed\.ts/);
});
