/**
 * PR #149 corrección 2 (2026-10-18): «dos pestañas = una solicitud» was false — each tab drew its own
 * crypto.randomUUID(). Now one draft key is shared by the browser's tabs (draft-key.ts) and the server derives the
 * request id from user + key + intent (submission-key.ts); the primary key stays the authority.
 *
 * ROJO/VERDE with counters: every case counts ROWS inserted and PAID voice calls (the avatar «text → voice» path,
 * the only one that pays at creation, through the real gatedVoiceSynthesize and ledger). The simulated server below
 * follows the action's order exactly (asserted against the source at the end): id → existing row → paid voice →
 * insert (UNIQUE) → 23505 = already created → redirect with the draft key → the dashboard rotates it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createdUrl, draftRequestId, intentFingerprint, requestIdForSubmission } from "@/lib/video/submission-key";
import { DRAFT_KEY_STORAGE, readOrCreateDraftKey, rotateDraftKey } from "@/app/dashboard/new/draft-key";
import { gatedVoiceSynthesize } from "@/lib/paid-calls/gated-providers";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { memoryResultStore } from "@/lib/paid-calls/result-store";
import type { VoiceProvider } from "@/lib/providers/types";

const ROOT = path.resolve(__dirname, "../../..");
const USER = "11111111-1111-4111-8111-111111111111";

/** localStorage of ONE browser: shared by all its tabs. */
function browserStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

function server() {
  const rows = new Map<string, { user_id: string }>();
  const ledger = memoryLedgerStore(), results = memoryResultStore();
  let voiceCalls = 0;
  const voiceProvider = { name: "elevenlabs", synthesize: async () => {
    voiceCalls++;
    await new Promise(r => setTimeout(r, 5));
    return { audioBuffer: Buffer.from("mp3"), durationSeconds: 10, words: [], mimeType: "audio/mpeg", extension: "mp3" };
  } } as unknown as VoiceProvider;
  /** One submission, in the action's order. `beforeInsert` lets a test interleave two submits (the 23505 race). */
  async function submit(fd: FormData, o: { legacyId?: string; beforeInsert?: () => Promise<void> } = {}): Promise<string> {
    const { requestId, draftKey } = o.legacyId ? { requestId: o.legacyId, draftKey: null } : requestIdForSubmission(USER, fd);
    const created = createdUrl(draftKey);
    const existing = rows.get(requestId);
    if (existing && existing.user_id === USER) return created;
    if (fd.get("narration_source") === "tts_text") {
      try {
        await gatedVoiceSynthesize({ requestId, ledger, results, voiceProvider, estimatedCostUsd: 0.05,
          voiceIdentity: { voiceId: "v", modelId: "m", voiceSettingsJson: "{}" } }, String(fd.get("avatar_tts_text")), "es");
      } catch {
        return "/dashboard/new?error=voz";
      }
    }
    await o.beforeInsert?.();
    if (rows.has(requestId)) return created; // 23505: the request exists, nothing more is paid
    rows.set(requestId, { user_id: USER });
    return created;
  }
  return { rows, submit, get voiceCalls() { return voiceCalls; } };
}

/** A tab of the browser: reads the shared draft key (its own key only when storage is unavailable). */
function tab(storage: ReturnType<typeof browserStorage> | null) {
  const own = randomUUID();
  return { key: () => readOrCreateDraftKey(storage, own), own };
}
const avatarForm = (key: string, text = "Hola, este es mi texto.") => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ submission_id: key, mode: "avatar", topic: "Mi video", style: "Educativo", duration_seconds: "30",
    language: "es", narration_source: "tts_text", avatar_tts_text: text, existing_avatar_id: "a1" })) fd.set(k, v);
  return fd;
};
const reelForm = (key: string, topic = "Mi video") => {
  const fd = avatarForm(key);
  fd.set("mode", "visual"); fd.set("narration_source", "tts"); fd.delete("avatar_tts_text"); fd.set("topic", topic);
  return fd;
};
/** The dashboard after a confirmed creation (DraftKeyRotation). */
const land = (storage: ReturnType<typeof browserStorage>, url: string) => rotateDraftKey(storage, new URL(url, "https://x").searchParams.get("draft"));

test("ROJO (antes): dos pestañas del mismo borrador con su propio randomUUID → 2 filas y 2 voces pagadas", async () => {
  const s = server();
  const a = tab(null), b = tab(null);
  await Promise.all([s.submit(avatarForm(a.own), { legacyId: a.own }), s.submit(avatarForm(b.own), { legacyId: b.own })]);
  assert.equal(s.rows.size, 2);
  assert.equal(s.voiceCalls, 2);
});

test("VERDE: dos pestañas simultáneas del mismo borrador → 1 fila, 1 voz pagada", async () => {
  const s = server(), storage = browserStorage();
  const a = tab(storage), b = tab(storage);
  assert.equal(a.key(), b.key(), "las pestañas comparten la llave del borrador");
  const [ra, rb] = await Promise.all([s.submit(avatarForm(a.key())), s.submit(avatarForm(b.key()))]);
  // Both voices in flight at the same instant: the ledger sees the same paid operation twice and, by its audited
  // conservative rule (T32), never calls again — ONE paid call. Neither tab can confirm it, so both are told to
  // retry and no row exists yet (honest, not hidden)...
  assert.equal(s.voiceCalls, 1);
  assert.deepEqual([ra, rb], ["/dashboard/new?error=voz", "/dashboard/new?error=voz"]);
  assert.equal(s.rows.size, 0);
  // ...and the retry reuses the stored audio of that one call: 1 row, still 1 paid call.
  assert.match(await s.submit(avatarForm(b.key())), /^\/dashboard\?created=1&draft=/);
  assert.equal(s.rows.size, 1);
  assert.equal(s.voiceCalls, 1);
});

test("VERDE: dos pestañas simultáneas del mismo borrador Reel → 1 fila (un Reel no paga al crearse)", async () => {
  const s = server(), storage = browserStorage();
  const a = tab(storage), b = tab(storage);
  const [ra, rb] = await Promise.all([s.submit(reelForm(a.key())), s.submit(reelForm(b.key()))]);
  assert.equal(s.rows.size, 1);
  assert.equal(ra, rb);
  assert.equal(s.voiceCalls, 0);
});

test("VERDE: doble clic y reenvío del navegador → 1 fila, 1 voz pagada", async () => {
  const s = server(), storage = browserStorage(), t = tab(storage);
  await s.submit(avatarForm(t.key()));
  await s.submit(avatarForm(t.key())); // second click after the first finished
  await s.submit(avatarForm(t.key())); // browser «resend form data»
  assert.equal(s.rows.size, 1);
  assert.equal(s.voiceCalls, 1);
});

test("VERDE: carrera 23505 (dos envíos pasan la comprobación previa) → 1 fila, ambos ven «creado», 1 voz", async () => {
  const s = server(), storage = browserStorage(), t = tab(storage);
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let waiting = 0;
  const barrier = async () => { if (++waiting === 2) release(); await gate; };
  const fd = reelForm(t.key());
  const [r1, r2] = await Promise.all([s.submit(fd, { beforeInsert: barrier }), s.submit(fd, { beforeInsert: barrier })]);
  assert.equal(s.rows.size, 1);
  assert.equal(r1, r2);
  assert.match(r1, /^\/dashboard\?created=1&draft=/);
  assert.equal(s.voiceCalls, 0, "un Reel no paga nada al crearse");
});

test("VERDE: respuesta perdida (el servidor creó, el navegador no llegó al panel) → reenviar no crea ni paga otra vez", async () => {
  const s = server(), storage = browserStorage(), t = tab(storage);
  await s.submit(avatarForm(t.key())); // response lost: no landing, no rotation
  assert.ok(storage.getItem(DRAFT_KEY_STORAGE), "la llave NO rota sin éxito confirmado");
  const url = await s.submit(avatarForm(t.key()));
  assert.equal(s.rows.size, 1);
  assert.equal(s.voiceCalls, 1);
  assert.ok(land(storage, url), "al confirmar, la llave usada rota");
});

test("VERDE: una creación nueva deliberada (después del éxito confirmado) → 2 filas, 2 voces", async () => {
  const s = server(), storage = browserStorage(), t = tab(storage);
  const first = t.key();
  assert.ok(land(storage, await s.submit(avatarForm(first))));
  const second = t.key();
  assert.notEqual(second, first, "el siguiente borrador tiene otra llave");
  await s.submit(avatarForm(second)); // same text, deliberately a second video
  assert.equal(s.rows.size, 2);
  assert.equal(s.voiceCalls, 2);
});

test("VERDE: otra intención en otra pestaña con la misma llave → otra solicitud (nunca se descarta en silencio)", async () => {
  const s = server(), storage = browserStorage();
  const a = tab(storage), b = tab(storage);
  await Promise.all([s.submit(reelForm(a.key(), "Tema A")), s.submit(reelForm(b.key(), "Tema B"))]);
  assert.equal(s.rows.size, 2);
});

test("la rotación solo borra la llave que se usó; un borrador más nuevo de otra pestaña se conserva", () => {
  const storage = browserStorage(), t = tab(storage);
  const used = t.key();
  storage.setItem(DRAFT_KEY_STORAGE, randomUUID()); // another tab already started a newer draft
  assert.equal(rotateDraftKey(storage, used), false);
  assert.ok(storage.getItem(DRAFT_KEY_STORAGE));
  assert.equal(rotateDraftKey(storage, "no-es-uuid"), false);
});

test("sin almacenamiento (modo privado, datos bloqueados) cada pestaña usa su propia llave: nunca peor que antes", () => {
  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
  const fallback = randomUUID();
  assert.equal(readOrCreateDraftKey(throwing, fallback), fallback);
  assert.equal(readOrCreateDraftKey(null, fallback), fallback);
  assert.equal(rotateDraftKey(throwing, fallback), false);
});

test("el id lo decide el servidor: incluye al usuario y la intención; el navegador no puede elegirlo ni sondear otro", () => {
  const key = randomUUID(), fd = reelForm(key);
  const mine = requestIdForSubmission(USER, fd).requestId;
  assert.notEqual(mine, key, "la llave del navegador no es el id");
  assert.notEqual(requestIdForSubmission("22222222-2222-4222-8222-222222222222", fd).requestId, mine);
  assert.equal(draftRequestId(USER, key.toUpperCase(), intentFingerprint(fd)), mine, "mayúsculas no cambian la llave");
  assert.match(mine, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const legacy = new FormData(); legacy.set("submission_id", "x");
  assert.equal(requestIdForSubmission(USER, legacy).draftKey, null, "sin llave válida: id nuevo como antes");
});

test("la acción y el formulario siguen exactamente ese orden (fuente)", () => {
  const actions = fs.readFileSync(path.join(ROOT, "src/app/dashboard/new/actions.ts"), "utf8");
  const id = actions.indexOf("const { requestId, draftKey } = requestIdForSubmission(user.id, formData);");
  const existing = actions.indexOf('.from("video_requests").select("id").eq("id", requestId).eq("user_id", user.id).maybeSingle();');
  const visual = actions.indexOf('if (mode === "visual") {'), voice = actions.indexOf("const voiceResult = await gatedVoiceSynthesize({ requestId,");
  assert.ok(id > 0 && id < existing && existing < visual && visual < voice, "id → fila existente → ramas → voz pagada");
  assert.equal(actions.match(/if \(error\.code === "23505"\) redirect\(created\);/g)?.length, 2, "Reel y avatar tratan 23505 como «ya creado»");
  assert.doesNotMatch(actions, /redirect\("\/dashboard\?created=1"\)/, "toda confirmación lleva la llave para rotarla");
  assert.match(actions, /if \(error\.code === "23505"\) redirect\(created\);\n    if \(audioPath\) await/, "la carrera perdida nunca borra el audio de la ganadora");
  const form = fs.readFileSync(path.join(ROOT, "src/app/dashboard/new/NewVideoForm.tsx"), "utf8");
  assert.doesNotMatch(form, /useState\(\(\) => \(typeof crypto/, "ya no hay un id por pestaña");
  assert.match(form, /readOrCreateDraftKey\(browserStorage\(\), current\)/);
  assert.match(form, /addEventListener\("storage"/, "una pestaña abierta antes toma la llave vigente");
  const page = fs.readFileSync(path.join(ROOT, "src/app/dashboard/page.tsx"), "utf8");
  assert.match(page, /\{created && <DraftKeyRotation draft=\{draft\} \/>\}/, "solo una creación confirmada rota la llave");
});
