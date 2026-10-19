/**
 * PR #149 corrección 2 (2026-10-18): «dos pestañas = una solicitud» was false — each tab drew its own
 * crypto.randomUUID(). Now one draft key is shared by the browser's tabs (draft-key.ts) and the server derives the
 * request id from user + key + intent (submission-key.ts); the primary key stays the authority.
 *
 * ROJO/VERDE with counters: every case counts ROWS inserted and PAID voice calls (the avatar «text → voice» path,
 * the only one that pays at creation, through the real gatedVoiceSynthesize and ledger). The simulated server below
 * follows the action's order exactly (asserted against the source at the end): id → existing row → paid voice →
 * insert (UNIQUE) → 23505 = already created → redirect with the draft key → the dashboard rotates it.
 *
 * Residual review of cd8995a (same correction 2): A) a NEW photo creates the avatar at the provider before the
 * request row exists — now a storage claim derived from the request id is taken first (createAvatarCalls counted);
 * B) the first creation of the shared key is serialized by the browser's Web Locks; without that API the window
 * remains and is stated as a limit, never as a guarantee; C) files count by their bytes, not their name and size.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createdUrl, intentFingerprint, intentRequestId, requestIdForSubmission } from "@/lib/video/submission-key";
import { acquireDraftKey, DRAFT_KEY_LOCK, DRAFT_KEY_STORAGE, readOrCreateDraftKey, rotateDraftKey } from "@/app/dashboard/new/draft-key";
import { CLAIM_MESSAGES, createAvatarOnce, isDuplicateUpload, photoClaimPath, STALE_CLAIM_MS, type NewPhotoClaimDeps } from "@/lib/video/avatar/new-photo-claim";
import { AvatarProviderError } from "@/lib/providers/types";
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
    const r = o.legacyId ? { requestId: o.legacyId, draftKey: null } : (await requestIdForSubmission(USER, fd, async c => new Set(c.filter(id => rows.has(id)))));
    const requestId = r.requestId!, draftKey = r.draftKey;
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
  // T46 D1: a new draft key alone is NOT a new intent; the same data maps to the same request…
  await s.submit(avatarForm(second));
  assert.equal(s.rows.size, 1);
  assert.equal(s.voiceCalls, 1);
  // …a second identical video is an explicit choice (repeat_intent), resolved on the server to the next free ordinal.
  const again = avatarForm(second); again.set("repeat_intent", "on"); again.set("repeat_request_token", randomUUID());
  await s.submit(again);
  assert.equal(s.rows.size, 2);
  assert.equal(s.voiceCalls, 2);
  // D5: lost redirect after the committed explicit repeat; replaying exactly the same POST cannot select R2.
  await s.submit(again);
  assert.equal(s.rows.size, 2);
  assert.equal(s.voiceCalls, 2);
  const nextRepeat = avatarForm(second); nextRepeat.set("repeat_intent", "on"); nextRepeat.set("repeat_request_token", randomUUID());
  await s.submit(nextRepeat);
  assert.equal(s.rows.size, 3);
  assert.equal(s.voiceCalls, 3);
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

test("el id lo decide el servidor: incluye al usuario y la intención; el navegador no puede elegirlo ni sondear otro", async () => {
  const key = randomUUID(), fd = reelForm(key);
  const mine = (await requestIdForSubmission(USER, fd)).requestId!;
  assert.notEqual(mine, key, "la llave del navegador no es el id");
  assert.notEqual((await requestIdForSubmission("22222222-2222-4222-8222-222222222222", fd)).requestId, mine);
  assert.equal(intentRequestId(USER, await intentFingerprint(fd), 0), mine, "id = usuario + intención (ordinal 0)");
  assert.match(mine, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const legacy = new FormData(); legacy.set("submission_id", "x");
  assert.equal((await requestIdForSubmission(USER, legacy)).draftKey, null, "sin llave válida: draftKey nulo, pero el id sigue siendo el del servidor");
});

// ---------------------------------------------------------------- Residual C: archivos por sus bytes

test("residual C — ROJO/VERDE: dos fotos distintas con el mismo nombre, tamaño y tipo son intenciones distintas", async () => {
  const key = randomUUID();
  const withPhoto = (bytes: number[]) => { const fd = avatarForm(key); fd.delete("existing_avatar_id");
    fd.set("avatar_photo", new File([new Uint8Array(bytes)], "foto.jpg", { type: "image/jpeg" })); return fd; };
  const a = withPhoto([1, 2, 3, 4]), b = withPhoto([9, 9, 9, 9]), a2 = withPhoto([1, 2, 3, 4]);
  // ROJO (antes): la huella solo veía nombre, tamaño y tipo → mismo id → la segunda foto caía en la solicitud vieja.
  const meta = (f: FormData) => { const v = f.get("avatar_photo") as File; return { name: v.name, size: v.size, type: v.type }; };
  assert.deepEqual(meta(a), meta(b));
  // VERDE: los bytes deciden.
  const id = async (f: FormData) => (await requestIdForSubmission(USER, f)).requestId;
  assert.notEqual(await id(a), await id(b));
  assert.equal(await id(a), await id(a2), "la misma foto reenviada es la misma solicitud");
  assert.doesNotMatch(JSON.stringify(await intentFingerprint(a)), /foto\.jpg/, "el nombre del archivo ya no forma parte de la intención");
});

// ---------------------------------------------------------------- Residual B: primera creación de la llave

test("residual B — ROJO: sin candado, dos pestañas que crean la llave a la vez pueden quedarse con llaves distintas", async () => {
  // The unlocked algorithm, step by step, with the interleaving the auditor described (A get, B get, A set/get, B set/get).
  const storage = browserStorage();
  const step = async (tabKey: string, gate: Promise<void>) => {
    const seen = storage.getItem(DRAFT_KEY_STORAGE);
    await gate;
    if (seen) return seen;
    storage.setItem(DRAFT_KEY_STORAGE, tabKey);
    return storage.getItem(DRAFT_KEY_STORAGE)!;
  };
  let openA!: () => void, openB!: () => void;
  const gA = new Promise<void>(r => { openA = r; }), gB = new Promise<void>(r => { openB = r; });
  const pa = step(randomUUID(), gA), pb = step(randomUUID(), gB);
  openA(); const ka = await pa; openB(); const kb = await pb;
  assert.notEqual(ka, kb);
});

/** A Web Locks stand-in that is a real mutex: callbacks of the same name never overlap. */
function mutexLocks() {
  let tail: Promise<unknown> = Promise.resolve();
  const log: string[] = [];
  return { log, request<T>(name: string, options: { mode: "exclusive" }, cb: () => T | Promise<T>): Promise<T> {
    log.push(`${name}:${options.mode}`);
    const run = tail.then(() => cb());
    tail = run.catch(() => {});
    return run;
  } };
}

test("residual B — VERDE: bajo el candado entre pestañas, dos pestañas simultáneas reciben la MISMA llave; sin candado se dice el límite", async () => {
  const storage = browserStorage(), locks = mutexLocks();
  let inside = 0;
  const watched = { getItem: (k: string) => { assert.equal(inside, 1, "leer la llave solo dentro del candado"); return storage.getItem(k); },
    setItem: (k: string, v: string) => { assert.equal(inside, 1); storage.setItem(k, v); }, removeItem: storage.removeItem };
  const guarded = { request<T>(n: string, o: { mode: "exclusive" }, cb: () => T | Promise<T>) {
    return locks.request(n, o, async () => { inside++; try { return await cb(); } finally { inside--; } }); } };
  const [ka, kb] = await Promise.all([acquireDraftKey(watched, randomUUID(), guarded), acquireDraftKey(watched, randomUUID(), guarded)]);
  assert.equal(ka, kb);
  assert.deepEqual(locks.log, [`${DRAFT_KEY_LOCK}:exclusive`, `${DRAFT_KEY_LOCK}:exclusive`]);
  // No Web Locks or a failing lock: the unlocked read (the stated limit), never a crash nor an empty key.
  const plain = browserStorage(), fb = randomUUID();
  assert.match(await acquireDraftKey(plain, fb, null), /^[0-9a-f-]{36}$/);
  const broken = { request: () => Promise.reject(new Error("locks off")) } as unknown as Parameters<typeof acquireDraftKey>[2];
  assert.equal(await acquireDraftKey(plain, fb, broken), plain.getItem(DRAFT_KEY_STORAGE));
});

// ---------------------------------------------------------------- Residual A: avatar con FOTO NUEVA

/** Supabase Storage stand-in: object names are unique (upsert disabled), with creation time. */
function avatarWorld(o: { refuse?: boolean; timeout?: boolean; failInsert?: boolean } = {}) {
  const objects = new Map<string, Date>(), avatars = new Map<string, { id: string; status: string }>();
  let createAvatarCalls = 0, now = Date.parse("2026-10-18T23:00:00Z");
  const deps = (): NewPhotoClaimDeps => ({
    async upload(path) {
      await new Promise(r => setTimeout(r, 1));
      if (objects.has(path)) return { ok: false, duplicate: isDuplicateUpload({ statusCode: "409", message: "The resource already exists" }), message: "The resource already exists" };
      objects.set(path, new Date(now)); return { ok: true };
    },
    async findAvatarByPhoto(path) { return avatars.get(path) ?? null; },
    async claimCreatedAt(path) { return objects.get(path) ?? null; },
    async removePhoto(path) { objects.delete(path); },
    async createAvatar() {
      createAvatarCalls++;
      await new Promise(r => setTimeout(r, 5));
      if (o.refuse) throw new AvatarProviderError("foto rechazada por el proveedor", "heygen", "moderation_rejected");
      if (o.timeout) throw new AvatarProviderError("la foto pudo haber sido aceptada, timeout en la respuesta", "heygen", "upstream_error");
      return { providerAvatarId: `pa_${createAvatarCalls}`, status: "ready", providerName: "fixture" };
    },
    async insertAvatar(_p, path) {
      if (o.failInsert) return null;
      const row = { id: `av_${avatars.size + 1}`, status: "ready" }; avatars.set(path, row); return row;
    },
    now: () => now,
  });
  return { objects, avatars, deps, get createAvatarCalls() { return createAvatarCalls; }, advance(ms: number) { now += ms; } };
}

test("residual A — ROJO (antes): ruta aleatoria por envío → dos pestañas con foto nueva crean 2 avatares en el proveedor", async () => {
  const w = avatarWorld();
  await Promise.all([createAvatarOnce(w.deps(), `${USER}/${randomUUID()}.jpg`), createAvatarOnce(w.deps(), `${USER}/${randomUUID()}.jpg`)]);
  assert.equal(w.createAvatarCalls, 2);
  assert.equal(w.avatars.size, 2);
});

test("residual A — VERDE: la reserva (ruta derivada del id) se toma ANTES de createAvatar: dos pestañas → 1 llamada, 1 avatar", async () => {
  const w = avatarWorld(), path = photoClaimPath(USER, randomUUID(), "jpg");
  const results = await Promise.all([createAvatarOnce(w.deps(), path), createAvatarOnce(w.deps(), path)]);
  assert.deepEqual(results.map(r => r.kind).sort(), ["created", "in_flight"]);
  assert.equal(w.createAvatarCalls, 1);
  assert.equal(w.avatars.size, 1);
  assert.equal(w.objects.size, 1, "ningún archivo huérfano");
  // Resend after a lost or uncertain response: the recorded avatar is reused, 0 new calls.
  const again = await createAvatarOnce(w.deps(), path);
  assert.equal(again.kind, "reused");
  assert.equal(w.createAvatarCalls, 1);
});

test("residual A — resultado incierto y recuperación: nunca se repite createAvatar sin una decisión nueva", async () => {
  // Avatar created at the provider but its row could not be saved: the claim is KEPT.
  const w = avatarWorld({ failInsert: true }), path = photoClaimPath(USER, randomUUID(), "jpg");
  assert.equal((await createAvatarOnce(w.deps(), path)).kind, "not_recorded");
  assert.equal((await createAvatarOnce(w.deps(), path)).kind, "in_flight", "reenvío inmediato: 0 llamadas");
  w.advance(STALE_CLAIM_MS + 1);
  assert.equal((await createAvatarOnce(w.deps(), path)).kind, "stale", "más tarde: se informa, sin repetir");
  assert.equal(w.createAvatarCalls, 1);
  // A provider REFUSAL releases the claim (nothing was created): a corrected retry may call again, once.
  const r = avatarWorld({ refuse: true }), p2 = photoClaimPath(USER, randomUUID(), "jpg");
  assert.equal((await createAvatarOnce(r.deps(), p2)).kind, "provider_failed");
  assert.equal(r.objects.size, 0);
  assert.match(CLAIM_MESSAGES.stale, /No se repitió/);
  assert.match(CLAIM_MESSAGES.stale, /permanece bloqueada/);
  assert.doesNotMatch(CLAIM_MESSAGES.stale, /vuelv[ea]s? a enviar|solicitud nueva/i,
    "un resultado incierto nunca invita a crear otra intención pagada");
  assert.doesNotMatch(Object.values(CLAIM_MESSAGES).join(" "), /no se (cobró|ha cobrado)/i, "nunca promete que no hubo cobro");
});

test("CORRECCIÓN-3: timeout después de aceptar foto conserva reserva y NUNCA reenvía createAvatar", async () => {
  const w = avatarWorld({ timeout: true }), path = photoClaimPath(USER, randomUUID(), "jpg");
  assert.equal((await createAvatarOnce(w.deps(), path)).kind, "uncertain");
  assert.equal(w.objects.size, 1, "el claim se conserva ante resultado desconocido");
  assert.equal(w.createAvatarCalls, 1);
  assert.equal((await createAvatarOnce(w.deps(), path)).kind, "in_flight");
  assert.equal(w.createAvatarCalls, 1, "segundo envío nunca llama al proveedor");
  w.advance(STALE_CLAIM_MS + 1);
  assert.equal((await createAvatarOnce(w.deps(), path)).kind, "stale");
  assert.equal(w.createAvatarCalls, 1);
  assert.match(CLAIM_MESSAGES.uncertain, /No pudimos confirmar/);
  const other = avatarWorld(), otherPath = photoClaimPath(USER, randomUUID(), "jpg");
  const deps = other.deps();
  deps.createAvatar = async () => { throw new Error("connection dropped"); };
  assert.equal((await createAvatarOnce(deps, otherPath)).kind, "uncertain");
  assert.equal(other.objects.size, 1, "una excepción desconocida también conserva la reserva");
});

test("CORRECCIÓN-3: solo el rechazo definitivo libera la reserva", async () => {
  const w = avatarWorld({ refuse: true }), path = photoClaimPath(USER, randomUUID(), "jpg");
  assert.equal((await createAvatarOnce(w.deps(), path)).kind, "provider_failed");
  assert.equal(w.objects.size, 0);
  assert.equal((await createAvatarOnce(w.deps(), path)).kind, "provider_failed");
  assert.equal(w.createAvatarCalls, 2, "dos intentos solo después de rechazos definitivos");
});

test("la acción y el formulario siguen exactamente ese orden (fuente)", () => {
  const actions = fs.readFileSync(path.join(ROOT, "src/app/dashboard/new/actions.ts"), "utf8");
  const id = actions.indexOf("const resolved = await requestIdForSubmission(user.id, formData, lookup);");
  const existing = actions.indexOf('.from("video_requests").select("id").eq("id", requestId).eq("user_id", user.id).maybeSingle();');
  const visual = actions.indexOf('if (mode === "visual") {'), voice = actions.indexOf("const voiceResult = await gatedVoiceSynthesize({ requestId,");
  assert.ok(id > 0 && id < existing && existing < visual && visual < voice, "id → fila existente → ramas → voz pagada");
  assert.equal(actions.match(/if \(error\.code === "23505"\) redirect\(created\);/g)?.length, 2, "Reel y avatar tratan 23505 como «ya creado»");
  assert.doesNotMatch(actions, /redirect\("\/dashboard\?created=1"\)/, "toda confirmación lleva la llave para rotarla");
  assert.match(actions, /if \(error\.code === "23505"\) redirect\(created\);\n    if \(audioPath\) await/, "la carrera perdida nunca borra el audio de la ganadora");
  // Residual A: the photo's claim is derived from the request id and taken before the provider is called.
  const claim = actions.indexOf("const photoPath = photoClaimPath(user.id, requestId, format);");
  const repeatPhotoBlock = actions.indexOf("if (blocksRepeatWithNewAvatarPhoto(");
  assert.ok(id < repeatPhotoBlock && repeatPhotoBlock < claim,
    "un POST directo de repetición con foto se bloquea en servidor antes del claim y del proveedor");
  assert.ok(id < claim && claim < actions.indexOf("await provider.createAvatar(") && claim < actions.indexOf("const voiceResult = await gatedVoiceSynthesize"));
  assert.doesNotMatch(actions, /\$\{user\.id\}\/\$\{randomUUID\(\)\}/, "ya no hay ruta aleatoria por envío");
  assert.equal(actions.match(/provider\.createAvatar\(/g)?.length, 1, "createAvatar solo dentro de createAvatarOnce");
  assert.match(actions, /claim\.kind === "stale"\) redirect\(formErrorUrl\(CLAIM_MESSAGES\.stale, \{ blockAvatarReconciliation: true \}\)\)/,
    "stale vuelve al mismo borrador y bloquea otra creación hasta conciliar");
  assert.doesNotMatch(actions, /formErrorUrl\(CLAIM_MESSAGES\.stale,\s*draftKey\)/,
    "stale no convierte una respuesta incierta en otra intención");
  const form = fs.readFileSync(path.join(ROOT, "src/app/dashboard/new/NewVideoForm.tsx"), "utf8");
  assert.doesNotMatch(form, /useState\(\(\) => \(typeof crypto/, "ya no hay un id por pestaña");
  assert.match(form, /acquireDraftKey\(browserStorage\(\), submissionIdRef\.current\)/, "la llave se toma bajo el candado entre pestañas");
  assert.match(form, /addEventListener\("storage"/, "una pestaña abierta antes toma la llave vigente");
  // CORRECCIÓN-3: the form is disabled until browser-wide draft-key acquisition completes.
  assert.ok(form.includes("const [draftReady, setDraftReady] = useState(false)"), "formulario bloqueado desde el primer render");
  assert.ok(form.includes("setDraftReady(Boolean(k))"), "solo se habilita después de obtener clave");
  assert.ok(form.includes('!draftReady ? "Sincronizando borrador'), "botón bloqueado mientras no hay clave");
  assert.ok(form.includes("onSubmit={event => { if (!draftReady || reconciliationBlocked) event.preventDefault(); }}"),
    "Enter no envía el formulario temprano ni durante conciliación");
  assert.ok(form.includes("disabled={!draftReady}"), "hidden draft key deshabilitada hasta adquirirla");
  assert.ok(form.includes("const version = ++syncVersion.current"), "no sobrescribir con adquisiciones antiguas");
  assert.doesNotMatch(form, /searchParams\.get\(["']reset["']\)/,
    "el cliente no rota el borrador por una respuesta de error");
  assert.match(form, /disabled=\{reconciliationBlocked \|\| repeatBlockedByNewAvatarPhoto\}/,
    "conciliación o una foto nueva deshabilitan la repetición explícita");
  assert.match(form, /onExistingAvatarChange=\{usesExisting =>/,
    "la UI sólo habilita repetir cuando reutiliza un avatar confirmado");
  const runbook = fs.readFileSync(path.join(ROOT, "docs/runbooks/avatar-uncertain-claims.md"), "utf8");
  assert.match(runbook, /Crear otro video igual[^\n]*only reuse an existing, confirmed avatar/,
    "la guía operativa no autoriza otro activo pagado con la misma foto");
  const page = fs.readFileSync(path.join(ROOT, "src/app/dashboard/page.tsx"), "utf8");
  assert.match(page, /\{created && <DraftKeyRotation draft=\{draft\} \/>\}/, "solo una creación confirmada rota la llave");
});
