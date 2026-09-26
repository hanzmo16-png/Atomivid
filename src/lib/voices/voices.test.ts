import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VoiceProvider } from "@/lib/providers/types";
import { getVoiceIdentity } from "@/lib/ai/voice";
import { voiceCacheKey, voiceIdentityFor } from "@/lib/video/audiovisual/voice-cache";
import { CATALOG_VOICE_IDS, DEFAULT_VOICE_ID, VOICE_CATALOG, catalogLanguageIssue, catalogVoicesFor, parseVoiceChoice, serializeVoiceChoice } from "./catalog";
import { checkUserVoice, loadRequestVoice, resolveCatalogVoice, resolveVoiceChoice, VoiceUnavailableError, type UserVoiceRow } from "./resolve";
import { voiceChoiceFromForm } from "./form";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const VOICE_ROW_ID = "33333333-3333-4333-8333-333333333333";

/** Cliente mínimo: from(tabla).select().eq().maybeSingle() devuelve la fila configurada para esa tabla. */
function fakeService(rows: Record<string, { data: unknown; error?: { code?: string; message: string } | null }>) {
  const calls: { table: string; eq: [string, unknown][] }[] = [];
  const client = {
    from(table: string) {
      const call = { table, eq: [] as [string, unknown][] };
      calls.push(call);
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          call.eq.push([col, val]);
          return chain;
        },
        maybeSingle: async () => ({ data: rows[table]?.data ?? null, error: rows[table]?.error ?? null }),
      };
      return chain;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const readyRow = (over: Partial<UserVoiceRow> = {}): UserVoiceRow => ({
  id: VOICE_ROW_ID,
  user_id: OWNER,
  name: "Mi voz",
  status: "ready",
  provider_voice_id: "privateProviderVoice01",
  deleted_at: null,
  ...over,
});

test("catálogo: cinco voces fijas (Mateo + 2 masculinas + 2 femeninas), ids distintos y Mateo por defecto", () => {
  assert.deepEqual(CATALOG_VOICE_IDS, ["mateo", "miguel", "mauricio", "norah", "tatiana"]);
  assert.equal(DEFAULT_VOICE_ID, "mateo");
  const genders = CATALOG_VOICE_IDS.map((id) => VOICE_CATALOG[id].gender);
  assert.equal(genders.filter((g) => g === "male").length, 3);
  assert.equal(genders.filter((g) => g === "female").length, 2);
  const providerIds = CATALOG_VOICE_IDS.map((id) => VOICE_CATALOG[id].providerVoiceId);
  assert.equal(new Set(providerIds).size, 5);
  assert.equal(VOICE_CATALOG.mateo.providerVoiceId, "uYlzyj2kIZo3HfBB21vF");
  for (const id of CATALOG_VOICE_IDS) assert.ok(VOICE_CATALOG[id].languages.includes("es"), `${id} narra en español`);
});

test("catálogo: Tatiana solo en español, con motivo visible; el resto admite inglés", () => {
  assert.equal(catalogLanguageIssue("tatiana", "es"), null);
  assert.match(catalogLanguageIssue("tatiana", "en") ?? "", /solo está disponible en español/);
  assert.deepEqual(catalogVoicesFor("en").map((v) => v.id), ["mateo", "miguel", "mauricio", "norah"]);
  assert.equal(catalogVoicesFor("es").length, 5);
});

test("parseVoiceChoice: vacío = Mateo; catálogo y custom:<uuid> válidos; cualquier otra cosa se rechaza (nunca un voice_id crudo del proveedor)", () => {
  assert.deepEqual(parseVoiceChoice(null), { kind: "catalog", id: "mateo" });
  assert.deepEqual(parseVoiceChoice(""), { kind: "catalog", id: "mateo" });
  assert.deepEqual(parseVoiceChoice(" miguel "), { kind: "catalog", id: "miguel" });
  assert.deepEqual(parseVoiceChoice(`custom:${VOICE_ROW_ID.toUpperCase()}`), { kind: "custom", id: VOICE_ROW_ID });
  assert.equal(parseVoiceChoice("k8cFOyAg7B9qwBlDDNTC"), null, "un voice_id del proveedor no es una elección válida");
  assert.equal(parseVoiceChoice("custom:no-es-uuid"), null);
  assert.equal(parseVoiceChoice("Mateo"), null);
  assert.equal(parseVoiceChoice(42), null);
  for (const id of CATALOG_VOICE_IDS) assert.deepEqual(parseVoiceChoice(serializeVoiceChoice({ kind: "catalog", id })), { kind: "catalog", id });
  assert.equal(serializeVoiceChoice({ kind: "custom", id: VOICE_ROW_ID }), `custom:${VOICE_ROW_ID}`);
});

test("resolveCatalogVoice: Mateo conserva su identidad configurada; las demás llevan su voice_id fijo; idioma no admitido = error, sin sustituir", () => {
  assert.equal(resolveCatalogVoice("mateo", "es").providerVoiceId, getVoiceIdentity("es").voiceId);
  assert.equal(resolveCatalogVoice("mateo", "en").providerVoiceId, getVoiceIdentity("en").voiceId);
  const miguel = resolveCatalogVoice("miguel", "es");
  assert.deepEqual(miguel, { choice: "miguel", label: "Miguel", providerVoiceId: "k8cFOyAg7B9qwBlDDNTC", ownerId: null });
  assert.throws(() => resolveCatalogVoice("tatiana", "en"), VoiceUnavailableError);
});

test("checkUserVoice: solo la propietaria, solo lista; ajena, eliminada, en proceso o sin id del proveedor se rechazan", () => {
  const ok = checkUserVoice(readyRow(), OWNER);
  assert.deepEqual(ok, { choice: `custom:${VOICE_ROW_ID}`, label: "Mi voz", providerVoiceId: "privateProviderVoice01", ownerId: OWNER });
  assert.throws(() => checkUserVoice(readyRow(), OTHER), /no existe o no es tuya/);
  assert.throws(() => checkUserVoice(null, OWNER), /no existe o no es tuya/);
  assert.throws(() => checkUserVoice(readyRow({ status: "deleted" }), OWNER), /fue eliminada/);
  assert.throws(() => checkUserVoice(readyRow({ status: "deleting" }), OWNER), /fue eliminada/);
  assert.throws(() => checkUserVoice(readyRow({ deleted_at: "2026-09-26T00:00:00Z" }), OWNER), /fue eliminada/);
  assert.throws(() => checkUserVoice(readyRow({ status: "cloning" }), OWNER), /todavía no está lista/);
  assert.throws(() => checkUserVoice(readyRow({ provider_voice_id: null }), OWNER), /todavía no está lista/);
});

test("resolveVoiceChoice: una voz ajena enviada por id falla igual que una inexistente; el catálogo no consulta la base", async () => {
  const foreign = fakeService({ user_voices: { data: readyRow({ user_id: OTHER }) } });
  await assert.rejects(
    resolveVoiceChoice({ service: foreign.client, userId: OWNER, choice: { kind: "custom", id: VOICE_ROW_ID }, language: "es" }),
    VoiceUnavailableError,
  );
  assert.deepEqual(foreign.calls[0], { table: "user_voices", eq: [["id", VOICE_ROW_ID]] });

  const own = fakeService({ user_voices: { data: readyRow() } });
  const resolved = await resolveVoiceChoice({ service: own.client, userId: OWNER, choice: { kind: "custom", id: VOICE_ROW_ID }, language: "en" });
  assert.equal(resolved.providerVoiceId, "privateProviderVoice01");

  const none = fakeService({});
  await resolveVoiceChoice({ service: none.client, userId: OWNER, choice: { kind: "catalog", id: "norah" }, language: "en" });
  assert.equal(none.calls.length, 0);

  const broken = fakeService({ user_voices: { data: null, error: { message: "timeout" } } });
  await assert.rejects(
    resolveVoiceChoice({ service: broken.client, userId: OWNER, choice: { kind: "custom", id: VOICE_ROW_ID }, language: "es" }),
    (err: Error) => !(err instanceof VoiceUnavailableError) && /No se pudo comprobar/.test(err.message),
  );
});

test("loadRequestVoice (worker): sin columna o sin elección = voz de siempre; una voz privada eliminada detiene la producción con el motivo", async () => {
  const missingColumn = fakeService({ video_requests: { data: null, error: { code: "42703", message: "column video_requests.voice_choice does not exist" } } });
  assert.equal(await loadRequestVoice(missingColumn.client, "req", OWNER, "es"), undefined);
  const nullChoice = fakeService({ video_requests: { data: { voice_choice: null } } });
  assert.equal(await loadRequestVoice(nullChoice.client, "req", OWNER, "es"), undefined);
  const catalog = fakeService({ video_requests: { data: { voice_choice: "mauricio" } } });
  assert.equal((await loadRequestVoice(catalog.client, "req", OWNER, "es"))?.providerVoiceId, "94zOad0g7T7K4oa7zhDq");
  const deleted = fakeService({ video_requests: { data: { voice_choice: `custom:${VOICE_ROW_ID}` } }, user_voices: { data: readyRow({ status: "deleted" }) } });
  await assert.rejects(loadRequestVoice(deleted.client, "req", OWNER, "es"), /fue eliminada/);
  const garbage = fakeService({ video_requests: { data: { voice_choice: "voz-rara" } } });
  await assert.rejects(loadRequestVoice(garbage.client, "req", OWNER, "es"), VoiceUnavailableError);
  const otherError = fakeService({ video_requests: { data: null, error: { code: "08006", message: "connection failure" } } });
  await assert.rejects(loadRequestVoice(otherError.client, "req", OWNER, "es"), /No se pudo leer la voz/);
});

test("voiceChoiceFromForm: apagado o Mateo no guarda nada; otra voz se guarda; inválida/ajena/idioma no admitido se rechaza con motivo", async () => {
  const neverCalled = () => {
    throw new Error("no debe consultar la base");
  };
  assert.deepEqual(await voiceChoiceFromForm({ raw: "miguel", enabled: false, userId: OWNER, language: "es", service: neverCalled }), { ok: true, stored: null });
  const mateo = await voiceChoiceFromForm({ raw: "mateo", enabled: true, userId: OWNER, language: "es", service: neverCalled });
  assert.equal(mateo.ok && mateo.stored, null);
  const norah = await voiceChoiceFromForm({ raw: "norah", enabled: true, userId: OWNER, language: "en", service: neverCalled });
  assert.ok(norah.ok);
  assert.equal(norah.stored, "norah");
  assert.equal(norah.resolved?.providerVoiceId, "kcQkGnn0HAT2JRDQ4Ljp");

  const tatianaEn = await voiceChoiceFromForm({ raw: "tatiana", enabled: true, userId: OWNER, language: "en", service: neverCalled });
  assert.deepEqual(tatianaEn, { ok: false, error: "Tatiana solo está disponible en español. Elige otra voz para narrar en inglés." });
  assert.deepEqual(await voiceChoiceFromForm({ raw: "k8cFOyAg7B9qwBlDDNTC", enabled: true, userId: OWNER, language: "es", service: neverCalled }), { ok: false, error: "Elige una voz válida." });

  const foreign = fakeService({ user_voices: { data: readyRow({ user_id: OTHER }) } });
  const stolen = await voiceChoiceFromForm({ raw: `custom:${VOICE_ROW_ID}`, enabled: true, userId: OWNER, language: "es", service: () => foreign.client });
  assert.equal(stolen.ok, false);
  const own = fakeService({ user_voices: { data: readyRow() } });
  const mine = await voiceChoiceFromForm({ raw: `custom:${VOICE_ROW_ID}`, enabled: true, userId: OWNER, language: "es", service: () => own.client });
  assert.ok(mine.ok);
  assert.equal(mine.stored, `custom:${VOICE_ROW_ID}`);
  assert.equal(mine.resolved?.ownerId, OWNER);
});

const elevenlabs = { name: "elevenlabs" } as VoiceProvider;
const fixture = { name: "fixture" } as VoiceProvider;

test("caché de voz: sin elección o con Mateo la clave es EXACTAMENTE la de antes (reintentos reutilizan el audio pagado)", () => {
  for (const provider of [elevenlabs, fixture]) {
    for (const language of ["es", "en"] as const) {
      const before = voiceCacheKey(voiceIdentityFor(provider, "Hola mundo.", language, 1.05));
      assert.equal(voiceCacheKey(voiceIdentityFor(provider, "Hola mundo.", language, 1.05, {})), before);
      assert.equal(voiceCacheKey(voiceIdentityFor(provider, "Hola mundo.", language, 1.05, { voice: resolveCatalogVoice("mateo", language) })), before);
    }
  }
});

test("caché de voz: la clave distingue voz, propietaria, texto, idioma, velocidad y contexto de fragmentos", () => {
  const key = (provider: VoiceProvider, opts: Parameters<typeof voiceIdentityFor>[4] = {}, text = "Hola.", language: "es" | "en" = "es", speed?: number) =>
    voiceCacheKey(voiceIdentityFor(provider, text, language, speed, opts));
  for (const provider of [elevenlabs, fixture]) {
    const base = key(provider);
    const miguel = key(provider, { voice: resolveCatalogVoice("miguel", "es") });
    const norah = key(provider, { voice: resolveCatalogVoice("norah", "es") });
    assert.equal(new Set([base, miguel, norah]).size, 3, `${provider.name}: cada voz su clave`);
    const mine = checkUserVoice(readyRow(), OWNER);
    const sameProviderIdOtherOwner = { ...mine, ownerId: OTHER };
    assert.notEqual(key(provider, { voice: mine }), key(provider, { voice: sameProviderIdOtherOwner }), "propietaria distinta = clave distinta");
    assert.notEqual(key(provider, {}, "Adiós."), base);
    assert.notEqual(key(provider, {}, "Hola.", "en"), base);
    assert.notEqual(key(provider, {}, "Hola.", "es", 1.1), base);
    assert.notEqual(key(provider, { previousText: "Antes." }), base);
    assert.notEqual(key(provider, { previousText: "Antes." }), key(provider, { nextText: "Antes." }));
  }
  const identity = voiceIdentityFor(elevenlabs, "Hola.", "es", undefined, { voice: resolveCatalogVoice("miguel", "es") });
  assert.equal(identity.voice?.voiceId, "k8cFOyAg7B9qwBlDDNTC");
  assert.equal(identity.voice?.voiceSettingsJson, getVoiceIdentity("es").voiceSettingsJson, "mismos ajustes aprobados para toda voz");
});

test("la voz elegida llega hasta el proveedor: formulario → solicitud → worker → pipelines → synthesize", () => {
  const root = path.join(__dirname, "..", "..");
  const read = (...p: string[]) => readFileSync(path.join(root, ...p), "utf8");
  const actions = read("app", "dashboard", "new", "actions.ts");
  assert.match(actions, /voiceChoiceFromForm\(\{\s*raw: formData\.get\("voice_choice"\)/);
  assert.match(actions, /voice_choice: voice\.stored/);
  assert.match(actions, /synthesize\(ttsText, language as "es" \| "en", undefined, \{ voice: voice\.resolved \}\)/);
  assert.match(actions, /narrationSourceForDb !== "own_audio" \? \{ voice_choice: voice\.stored \}/);

  const runJob = read("lib", "video", "run-job.ts");
  assert.match(runJob, /loadRequestVoice\(service, requestId, row\.user_id,/);
  assert.equal((runJob.match(/^\s+voice,$/gm) ?? []).length, 2, "avatar y reel reciben la voz");

  const generate = read("lib", "video", "generate-video.ts");
  assert.match(generate, /voice\?: ResolvedVoice/);
  assert.equal((generate.match(/voiceProvider\.synthesize\([^)]*\{ voice \}\)/g) ?? []).length, 2, "narración y corrección de ritmo usan la misma voz");
  const directed = read("lib", "video", "audiovisual", "directed-reel.ts");
  assert.match(directed, /synthesizeNarrationCached\(\{[\s\S]*?voice: narrationVoice/);
  const avatar = read("lib", "video", "avatar", "pipeline.ts");
  assert.match(avatar, /voice\?: ResolvedVoice/);
  assert.match(avatar, /voiceProvider!\.synthesize\(fullText, language, undefined, \{ voice \}\)/);
  const real = read("lib", "providers", "voice", "real.ts");
  assert.match(real, /voiceId: options\?\.voice\?\.providerVoiceId/);
});
