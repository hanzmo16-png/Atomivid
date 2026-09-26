import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { VoiceProvider } from "@/lib/providers/types";
import { generateToneWav } from "@/lib/providers/wav";
import { memoryDb, type BeforeInsert } from "@/lib/tts/test-db";
import { createTtsRequest } from "@/lib/tts/requests";
import { runTtsJob } from "@/lib/tts/run-tts-job";
import { billableCharacters, monthStartIso, segmentScript } from "@/lib/tts/segment";
import { canUseMyVoice } from "./access";
import { createUserVoice, PILOT_FULL_MESSAGE } from "./requests";
import { runVoiceCloneJob } from "./clone-job";

process.env.AUDIOVISUAL_STORAGE_RETRY_MS = "0";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const wav = () => generateToneWav({ durationSeconds: 0.4, frequencyHz: 200, amplitude: 0.1 });

/**
 * Mismas reglas que los disparadores de la migración 0021, aplicadas en el
 * momento del INSERT (como en Postgres, después de las comprobaciones
 * previas de la aplicación): son las que garantizan el límite cuando dos
 * envíos pasan a la vez la comprobación previa.
 */
const triggers: BeforeInsert = (table, row, rows) => {
  if (table === "tts_jobs") {
    const used = rows
      .filter((r) => r.user_id === row.user_id && String(r.created_at) >= monthStartIso() && !(r.status === "failed" && !r.segments_done))
      .reduce((sum, r) => sum + (r.characters as number), 0);
    return used + (row.characters as number) > (row.max_chars_per_month as number) ? "tts_monthly_limit: excedido" : null;
  }
  if (table === "user_voices") {
    const active = (r: Record<string, unknown>) => ["uploaded", "cloning", "testing", "ready", "deleting"].includes(String(r.status)) || (r.status === "failed" && r.needs_review === true);
    if (rows.filter((r) => r.user_id === row.user_id && active(r) && r.status !== "failed").length >= (row.max_voices_per_user as number)) return "user_voice_limit: 1";
    if (rows.filter(active).length >= (row.max_voices_total as number)) return "user_voice_capacity: 3";
  }
  return null;
};

test("Texto a voz: dos envíos simultáneos que juntos superan el límite mensual → solo se guarda uno", async () => {
  const db = memoryDb({}, {}, triggers);
  const script = "x".repeat(2000);
  const form = (id: string) => ({ title: "Pieza", script, language: "es", voice: "mateo", clientRequestId: id });
  const limits = { maxCharsPerPiece: 3000, maxCharsPerUserMonth: 3000 };
  const dispatched: string[] = [];
  const [one, two] = await Promise.all([
    createTtsRequest({ service: db.client, userId: A, form: form("aaaaaaaa-0000-4000-8000-000000000001"), limits, dispatch: async (id) => void dispatched.push(id) }),
    createTtsRequest({ service: db.client, userId: A, form: form("aaaaaaaa-0000-4000-8000-000000000002"), limits, dispatch: async (id) => void dispatched.push(id) }),
  ]);
  assert.equal([one, two].filter((r) => r.ok).length, 1);
  const rejected = [one, two].find((r) => !r.ok);
  assert.deepEqual(rejected, { ok: false, error: "Con esta pieza superarías tus caracteres de Texto a voz de este mes." });
  assert.equal(db.rows("tts_jobs").length, 1);
  assert.equal(dispatched.length, 1);
  assert.equal(db.rows("tts_jobs")[0].max_chars_per_month, 3000, "el límite vigente viaja con la fila para que la base lo aplique");
});

test("Mi voz: dos usuarias a la vez con la capacidad de la cuenta casi llena → solo una ocupa el último espacio", async () => {
  const seed = { user_voices: [{ id: "v0", user_id: "otra", client_request_id: "x", status: "ready" }, { id: "v1", user_id: "otra2", client_request_id: "y", status: "ready" }] };
  const db = memoryDb(seed, {}, triggers);
  const form = (id: string) => ({ name: "Mi voz", consentOwnVoice: "on", consentProcessing: "on", keepSample: null, clientRequestId: id, clientSeconds: "60", file: new File([new Uint8Array(wav())], "m.wav") });
  const [a, b] = await Promise.all([
    createUserVoice({ service: db.client, userId: A, form: form("bbbbbbbb-0000-4000-8000-000000000001"), maxVoicesPerUser: 1, maxVoicesTotal: 3, dispatch: async () => {} }),
    createUserVoice({ service: db.client, userId: B, form: form("bbbbbbbb-0000-4000-8000-000000000002"), maxVoicesPerUser: 1, maxVoicesTotal: 3, dispatch: async () => {} }),
  ]);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  assert.deepEqual([a, b].find((r) => !r.ok), { ok: false, error: PILOT_FULL_MESSAGE });
  assert.equal(db.rows("user_voices").length, 3);
  // Con la capacidad completa, la comprobación previa ya lo dice sin guardar la muestra.
  const full = await createUserVoice({ service: db.client, userId: "33333333-3333-4333-8333-333333333333", form: form("bbbbbbbb-0000-4000-8000-000000000003"), maxVoicesPerUser: 1, maxVoicesTotal: 3, dispatch: async () => assert.fail() });
  assert.deepEqual(full, { ok: false, error: PILOT_FULL_MESSAGE });
});

test("Mi voz: el mismo usuario con dos formularios a la vez no supera su límite", async () => {
  const db = memoryDb({}, {}, triggers);
  const form = (id: string) => ({ name: "Mi voz", consentOwnVoice: "on", consentProcessing: "on", keepSample: null, clientRequestId: id, clientSeconds: "60", file: new File([new Uint8Array(wav())], "m.wav") });
  const results = await Promise.all(
    ["cccccccc-0000-4000-8000-000000000001", "cccccccc-0000-4000-8000-000000000002"].map((id) =>
      createUserVoice({ service: db.client, userId: A, form: form(id), maxVoicesPerUser: 1, maxVoicesTotal: 10, dispatch: async () => {} }),
    ),
  );
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.match(results.find((r) => !r.ok && "error" in r)?.error ?? "", /máximo de voces propias/);
});

const provider = (calls: string[]): VoiceProvider => ({
  name: "elevenlabs",
  async synthesize(text) {
    calls.push(text);
    return { audioBuffer: wav(), durationSeconds: 0.4, words: [], mimeType: "audio/wav", extension: "wav" };
  },
});

test("worker de Texto a voz: la cuota del proveedor descuenta lo reservado por otras piezas en curso", async () => {
  const script = "Primer párrafo.\n\nSegundo párrafo.";
  const chars = billableCharacters(segmentScript(script));
  const job = { id: "dddddddd-0000-4000-8000-000000000001", user_id: A, title: "T", language: "es", voice_choice: "mateo", script, characters: chars, status: "queued", attempts: 0, segments_done: 0 };
  const other = { id: "dddddddd-0000-4000-8000-000000000002", user_id: B, title: "O", language: "es", voice_choice: "mateo", script: "…", characters: 5000, status: "processing", attempts: 1, segments_done: 0 };
  const calls: string[] = [];
  const concat = async () => ({ audio: Buffer.from("mp3"), durationSeconds: 1 });

  const tight = memoryDb({ tts_jobs: [{ ...job }, { ...other }] });
  assert.equal(await runTtsJob(job.id, { service: tight.client, voiceProvider: provider(calls), concat, quota: async () => ({ remaining: 5000 + chars - 1 }) }), "failed");
  assert.equal(calls.length, 0, "sola cabría, pero no junto con la otra pieza en curso");
  assert.match(String(tight.rows("tts_jobs")[0].error_message), /caracteres suficientes/);

  const enough = memoryDb({ tts_jobs: [{ ...job }, { ...other }] });
  assert.equal(await runTtsJob(job.id, { service: enough.client, voiceProvider: provider(calls), concat, quota: async () => ({ remaining: 5000 + chars }) }), "completed");

  const unknown = memoryDb({ tts_jobs: [{ ...job }] });
  assert.equal(await runTtsJob(job.id, { service: unknown.client, voiceProvider: provider(calls), concat, quota: async () => null }), "failed");
  assert.match(String(unknown.rows("tts_jobs")[0].error_message), /no se cobró nada/, "sin poder consultar la cuota no se gasta");
});

test("worker de Mi voz: los espacios libres descuentan otras clonaciones en curso", async () => {
  const voice = { id: "eeeeeeee-0000-4000-8000-000000000001", user_id: A, name: "Mi voz", status: "uploaded", provider_voice_id: null, sample_path: "voices/a/e/sample.wav", keep_sample: false, attempts: 0, deleted_at: null };
  const cloning = { id: "eeeeeeee-0000-4000-8000-000000000002", user_id: B, name: "Otra", status: "cloning", provider_voice_id: null, attempts: 1 };
  const db = memoryDb({ user_voices: [{ ...voice }, { ...cloning }] });
  db.storage.files.set(voice.sample_path, wav());
  let cloned = 0;
  const result = await runVoiceCloneJob(voice.id, {
    service: db.client,
    voiceProvider: provider([]),
    prepareSample: async (audio) => ({ audio, durationSeconds: 60 }),
    slots: async () => ({ used: 9, limit: 10 }),
    clone: async () => (cloned++, "x"),
  });
  assert.equal(result, "failed");
  assert.equal(cloned, 0, "9 usados + 1 en curso = sin espacio");
  assert.match(String(db.rows("user_voices")[0].error_message), /espacios de clonación libres/);
});

test("acceso a Mi voz: flag encendido Y cuenta en la lista; sin lista, nadie", () => {
  const user = { id: "USER-1", email: "Hans@Example.com" };
  assert.equal(canUseMyVoice(user, {}), false);
  assert.equal(canUseMyVoice(user, { MY_VOICE_ENABLED: "true" }), false, "sin lista no hay acceso");
  assert.equal(canUseMyVoice(user, { MY_VOICE_ENABLED: "true", MY_VOICE_ALLOWLIST_EMAILS: "otra@example.com, hans@example.com" }), true);
  assert.equal(canUseMyVoice(user, { MY_VOICE_ENABLED: "true", MY_VOICE_ALLOWLIST_USER_IDS: "user-1" }), true);
  assert.equal(canUseMyVoice(user, { MY_VOICE_ENABLED: "false", MY_VOICE_ALLOWLIST_EMAILS: "hans@example.com" }), false);
  assert.equal(canUseMyVoice(null, { MY_VOICE_ENABLED: "true", MY_VOICE_ALLOWLIST_EMAILS: "hans@example.com" }), false);
});

test("migración 0021: los límites se aplican en la base con bloqueo, dentro del INSERT", () => {
  const sql = readFileSync(path.join(__dirname, "..", "..", "..", "supabase", "migrations", "0021_voices_and_text_to_speech.sql"), "utf8");
  assert.match(sql, /create trigger tts_jobs_monthly_limit before insert on public\.tts_jobs/);
  assert.match(sql, /create trigger user_voices_limits before insert on public\.user_voices/);
  assert.match(sql, /pg_advisory_xact_lock\(hashtext\('tts_jobs:' \|\| new\.user_id::text\)\)/);
  assert.match(sql, /pg_advisory_xact_lock\(hashtext\('user_voices:account'\)\)/);
  assert.match(sql, /max_chars_per_month integer not null/);
  assert.match(sql, /max_voices_total integer not null/);
  assert.match(sql, /or \(status = 'failed' and needs_review\)/, "una clonación incierta sigue ocupando capacidad");
});
