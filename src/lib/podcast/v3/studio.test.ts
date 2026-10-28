/** Podcast 2.1 Estudio audiovisual — pruebas puras (sin red, sin ffmpeg, sin proveedores reales). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { studioFlag, visualProviders, requireProvider, ProviderUnavailableError, lipTimeline, lipViolations, shotCoverage, estimateByMode, syntheticTurns } from "./studio";
import { planEpisode, type VisualAsset } from "./editorial";
import { classifyTurn, templateConversation, conversationPrompt, coherenceIssues } from "./script";
import { mixGraph } from "./audio";
import { STEPS, STEP, defaultDraft, loadDraft, stepErrors, draftToSpec, modalityToMode, INTENSITY_DB } from "./wizard";
import { StudioSpec, STUDIO_VERSION } from "./spec";
import { studioAction, type ApiDeps } from "./api";
import { EL_DURO_VOICE_ID } from "./spec";
import type { AccountVoice } from "@/lib/podcast/voices";

test("flag: activado con PODCAST_V3_ENABLED=1 o por defecto SOLO en Vercel Preview; producción y local apagados", () => {
  assert.equal(studioFlag({}).enabled, false);
  assert.equal(studioFlag({ VERCEL_ENV: "production" }).enabled, false, "producción sin env: apagado");
  assert.equal(studioFlag({ VERCEL_ENV: "development" }).enabled, false);
  assert.deepEqual(studioFlag({ VERCEL_ENV: "preview" }).source, "preview");
  assert.equal(studioFlag({ VERCEL_ENV: "preview", PODCAST_STUDIO_PREVIEW: "0" }).enabled, false, "Preview se puede apagar");
  assert.equal(studioFlag({ PODCAST_V3_ENABLED: "1", VERCEL_ENV: "production" }).source, "env");
});

test("proveedores visuales: Recraft es el principal del estudio; Pexels ya no se ofrece; apagado → motivo y nunca se sustituye", () => {
  const ps = visualProviders({});
  assert.deepEqual(ps.map((p) => p.id), ["recraft", "solo_set"], "Pexels no está en el estudio");
  assert.equal(ps[0].available, true);
  const off = visualProviders({ PODCAST_STUDIO_RECRAFT: "0" }).find((p) => p.id === "recraft")!;
  assert.equal(off.available, false); assert.match(off.reason!, /desactivado/);
  assert.throws(() => requireProvider("recraft", { PODCAST_STUDIO_RECRAFT: "0" }), ProviderUnavailableError);
  assert.throws(() => requireProvider("pexels", {}), ProviderUnavailableError, "un borrador con Pexels se rechaza (no se usa en silencio)");
  assert.equal(requireProvider("recraft", {}).id, "recraft");
});

const V = (voiceId: string, name: string): AccountVoice => ({ voiceId, name, category: "premade", language: "es", accent: null, gender: null, previewUrl: null } as AccountVoice);
const VOICES = [V("voiceAnaHost1", "Ana"), V("voiceLuisGuest", "Luis"), V(EL_DURO_VOICE_ID, "duro")];
const deps = (over: Partial<ApiDeps> = {}): ApiDeps => ({ userId: "u1", viewer: { id: "u1", email: "h@example.com", email_confirmed_at: "x" }, voices: async () => VOICES, enabled: true, llm: null, env: {},
  insert: async () => ({ id: "11111111-1111-4111-8111-111111111111" }), load: async () => null, authorize: async () => true, dispatch: async () => true, ...over });
const dlg = (visual: Record<string, unknown> = {}) => ({ spec: { mode: "dialogo", title: "T", script: templateConversation({ topic: "la luna Europa", hostName: "Ana", guestName: "Luis", minutes: 3 }).map((t) => `${t.speaker === "A" ? "Ana" : "Luis"}: ${t.text}`).join("\n"), target_minutes: 3,
  participants: [{ id: "A", name: "Ana", voice_id: "voiceAnaHost1", avatar: { kind: "existente", avatar_id: "a1" } }, { id: "B", name: "Luis", voice_id: "voiceLuisGuest", avatar: { kind: "existente", avatar_id: "a2" } }], visual, music: {}, budget_usd: 50 } });

test("API: Recraft apagado → 409 con motivo, sin crear; la estimación con Recraft incluye ilustraciones y verificación", async () => {
  let inserted = 0;
  const offEnv = { PODCAST_STUDIO_RECRAFT: "0" };
  const r = await studioAction(deps({ env: offEnv, insert: async () => { inserted++; return { id: "x" }; } }), { action: "create", ...dlg({ provider: "recraft" }) });
  assert.equal(r.status, 409); assert.match(String(r.body.error), /No se sustituye/); assert.equal(inserted, 0);
  assert.equal((await studioAction(deps(), { action: "estimate", ...dlg({ provider: "pexels" }) })).status, 409, "Pexels ya no se acepta en el estudio");
  const ok = await studioAction(deps(), { action: "estimate", ...dlg({ provider: "recraft", avatar_frequency: 0.5 }) });
  assert.equal(ok.status, 200);
  const e = ok.body.estimate as { byProvider: Record<string, number>; providers: { id: string }[]; lipTimeline: unknown[]; coverage: Record<string, boolean>; turnList: { speaker: string; kind: string }[]; lines: { concept: string; provider: string; usd: number }[] };
  assert.ok(e.byProvider.ElevenLabs > 0 && "HeyGen" in e.byProvider, "costo por proveedor antes de autorizar");
  // La verificación de las imágenes es local (CLIP en el worker): aparece en la estimación con USD 0.
  assert.ok(e.byProvider.Recraft > 0 && e.byProvider["Verificación local"] === 0, `Recraft y verificación en la estimación: ${JSON.stringify(e.byProvider)}`);
  assert.ok(e.lipTimeline.length > 0 && e.turnList.length > 0);
  assert.ok(e.coverage.general && (e.coverage.primerPlanoA || e.coverage.primerPlanoB), JSON.stringify(e.coverage));
});

test("guion: conversación real (preguntas, respuestas, desacuerdo, comentario, transición) con identidad por turno", () => {
  const turns = templateConversation({ topic: "volcanes", hostName: "Ana", guestName: "Luis", minutes: 4 });
  const kinds = new Set(turns.map((t) => t.kind));
  for (const k of ["apertura", "pregunta", "desacuerdo", "transicion", "cierre"]) assert.ok(kinds.has(k as never), `falta ${k}: ${[...kinds]}`);
  assert.ok(turns.some((t) => t.kind === "respuesta" || t.kind === "comentario"));
  assert.deepEqual(coherenceIssues(turns), []);
  assert.ok(turns.every((t) => t.speaker === "A" || t.speaker === "B"));
  assert.equal(classifyTurn("No estoy de acuerdo con eso.", 3, 9), "desacuerdo");
  assert.equal(classifyTurn("Pasemos a la historia. ¿Qué pasó?", 3, 9), "transicion");
  assert.match(conversationPrompt({ topic: "x", hostName: "A", guestName: "B", minutes: 2, guestPersonality: "escéptica" }), /escéptica[\s\S]*desacuerdo/);
});

const ASSETS: VisualAsset[] = Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, query: "luna europa", kind: "foto", tags: ["luna", "europa", "hielo"] }));
const dialogPlan = () => {
  const turns = templateConversation({ topic: "la luna Europa", hostName: "Ana", guestName: "Luis", minutes: 4 });
  let t = 4; const voice = turns.map((x) => { const d = Math.max(1.2, x.text.length / 15); const v = { speaker: x.speaker, start: t, end: t + d }; t += d; return v; });
  const plan = planEpisode({ mode: "dialogo", turns: turns.map((x) => ({ ...x, seconds: Math.max(1.2, x.text.length / 15) })), assets: ASSETS, avatarFrequency: 1, avatarMaxSeconds: 60, recreations: false, hasAvatar: { A: true, B: true }, introSeconds: 4 });
  return { plan, voice };
};

test("lip-sync: nadie mueve los labios mientras habla el otro (línea de tiempo de segmentos)", () => {
  const { plan, voice } = dialogPlan();
  const segs = lipTimeline(plan);
  assert.deepEqual(lipViolations(segs, voice), []);
  for (const s of segs) {
    if (s.lips.A === "habla") assert.equal(s.speaker, "A");
    if (s.lips.B === "habla") assert.equal(s.speaker, "B");
    assert.ok(!(s.lips.A === "habla" && s.lips.B === "habla"), "nunca dos labios activos a la vez");
    if (s.shot === "two_shot") assert.ok(s.lips.A === "reposo" || s.lips.B === "reposo", "en plano general el que escucha queda en reposo");
  }
  // Un plan alterado (labios de B en un turno de A) se detecta.
  const bad = segs.map((s) => (s.speaker === "A" && s.shot === "two_shot" ? { ...s, lips: { A: "reposo" as const, B: "habla" as const } } : s));
  assert.ok(lipViolations(bad, voice).length > 0);
});

test("planos: conversación con plano general de los dos + primeros planos individuales", () => {
  const c = shotCoverage(dialogPlan().plan);
  assert.ok(c.general && c.primerPlanoA && c.primerPlanoB, JSON.stringify(c));
});

test("música: ducking desactivable, intro y outro controlables; −16 LUFS es el objetivo del máster", () => {
  const on = mixGraph({ total: 60, musicGainDb: -8, stings: true, transitions: [20], ambient: false, music: true });
  assert.match(on.graph, /sidechaincompress/);
  const off = mixGraph({ total: 60, musicGainDb: -8, stings: true, transitions: [20], ambient: false, music: true, ducking: false });
  assert.doesNotMatch(off.graph, /sidechaincompress/);
  const noIntro = mixGraph({ total: 60, musicGainDb: -8, stings: true, transitions: [], ambient: false, music: true, intro: false, outro: true });
  assert.match(noIntro.graph, /\[2:a\]anullsink/); assert.match(noIntro.graph, /adelay=57000/);
  assert.deepEqual(INTENSITY_DB, { suave: -28, media: -22, alta: -17 });
});

test("asistente: 10 pasos en el orden pedido, persistencia y modalidades visibles", () => {
  assert.deepEqual([...STEPS], ["Modalidad", "Tema", "Participantes", "Voces", "Avatares", "Música", "Visuales", "Presupuesto", "Vista previa", "Generación"]);
  assert.equal(modalityToMode("audio"), "narracion");
  assert.equal(defaultDraft().provider, "recraft", "Recraft es el proveedor principal del estudio");
  assert.equal(loadDraft(JSON.stringify({ ...defaultDraft(), provider: "pexels", set: "neon" })).provider, "recraft", "un borrador con Pexels pasa a Recraft");
  assert.equal(loadDraft(JSON.stringify({ ...defaultDraft(), set: "biblioteca" })).set, "calido", "escenario anterior → estudio compartido");
  const d = { ...defaultDraft(), step: STEP.musica, modality: "dialogo" as const, mode: "dialogo" as const, count: 2 as const, intensity: "alta" as const, ducking: false, provider: "recraft" as const };
  const back = loadDraft(JSON.stringify(d));
  assert.equal(back.step, STEP.musica); assert.equal(back.intensity, "alta"); assert.equal(back.ducking, false);
  assert.ok(stepErrors(d, STEP.visuales, { unavailableVoices: [], providers: visualProviders({ PODCAST_STUDIO_RECRAFT: "0" }) }).some((e) => /no se cambia automáticamente/.test(e)));
  assert.ok(stepErrors(d, STEP.avatares, { unavailableVoices: [] }).some((e) => /avatar/.test(e)));
  assert.deepEqual(stepErrors({ ...d, modality: "audio", mode: "narracion" }, STEP.avatares, { unavailableVoices: [] }), []);
  const s = StudioSpec.parse({ ...draftToSpec({ ...d, title: "T", script: "x".repeat(30), participants: [{ ...d.participants[0], voice_id: "voiceA1", personality: "curioso", gender: "femenino" }, { ...d.participants[1], voice_id: "voiceB1" }] }), version: STUDIO_VERSION });
  assert.equal(s.music.ducking, false); assert.equal(s.music.intensity, "alta"); assert.equal(s.participants[0].personality, "curioso"); assert.equal(s.participants[0].gender, "femenino");
  assert.equal(StudioSpec.parse({ ...draftToSpec({ ...d, modality: "audio", mode: "narracion", title: "T", script: "x".repeat(30), participants: [{ ...d.participants[0], voice_id: "voiceA1" }, d.participants[1]], count: 1 }), version: STUDIO_VERSION }).visual.provider, "solo_set");
});

test("costos: estimación por modo para un episodio de 10 minutos (desglose por proveedor)", () => {
  const rows = estimateByMode(10);
  assert.deepEqual(rows.map((r) => r.mode), ["solo_audio", "narracion", "avatar", "dialogo"]);
  const [audio, , one, two] = rows;
  assert.ok(audio.estimate.totalUsd < one.estimate.totalUsd && one.estimate.totalUsd <= two.estimate.totalUsd * 1.5);
  assert.equal(audio.byProvider.HeyGen, 0);
  assert.ok(one.avatarSeconds > 0 && one.avatarSeconds <= 600 * 0.5 + 30, "avatar en segmentos cortos (≈50% de turnos, tope 20 s)");
  assert.equal(syntheticTurns(10, true).length, 20);
});

test("asistente: el presupuesto por encima del tope del servidor se rechaza en «Presupuesto», no con un 402 al final", async () => {
  const { STUDIO_BUDGET_MAX_USD } = await import("./wizard");
  const { STUDIO_MAX_AUTHORIZED_USD } = await import("./api");
  assert.equal(STUDIO_BUDGET_MAX_USD, STUDIO_MAX_AUTHORIZED_USD, "el tope del asistente es el mismo que hace cumplir el servidor");
  const d = { ...defaultDraft(), budgetUsd: STUDIO_MAX_AUTHORIZED_USD + 10 };
  assert.ok(stepErrors(d, STEP.presupuesto, { unavailableVoices: [] }).some((e) => /no puede autorizar más de USD 50/.test(e)));
  assert.deepEqual(stepErrors({ ...d, budgetUsd: STUDIO_MAX_AUTHORIZED_USD }, STEP.presupuesto, { unavailableVoices: [] }), []);
});

// Piloto del dueño (cierre 2026-10-27): sin PODCAST_V3_ENABLED, el estudio genera SOLO para INTERNAL_PRODUCTION_OWNER_USER_ID.
test("owner pilot: only the internal owner (email confirmed) gets the studio; PODCAST_V3_OWNER_PILOT=0 turns it off", async () => {
  const { studioOwnerPilot, studioGenerationEnabled, studioFlag } = await import("./studio");
  const OWNER = "11111111-2222-4333-8444-555555555555";
  const env = { INTERNAL_PRODUCTION_OWNER_USER_ID: OWNER };
  const owner = { id: OWNER, email_confirmed_at: "2026-01-01T00:00:00Z" };
  assert.equal(studioGenerationEnabled(owner, env), true);
  assert.equal(studioFlag(env, owner).source, "owner");
  assert.equal(studioGenerationEnabled({ id: "99999999-2222-4333-8444-555555555555", email_confirmed_at: "2026-01-01T00:00:00Z" }, env), false, "another account");
  assert.equal(studioGenerationEnabled({ id: OWNER, email_confirmed_at: null }, env), false, "unconfirmed email");
  assert.equal(studioGenerationEnabled(null, env), false);
  assert.equal(studioGenerationEnabled(owner, {}), false, "no owner configured");
  assert.equal(studioOwnerPilot(owner, { ...env, PODCAST_V3_OWNER_PILOT: "0" }), false, "kill switch");
  assert.equal(studioFlag({ ...env, PODCAST_V3_OWNER_PILOT: "0" }, owner).enabled, false);
  assert.equal(studioGenerationEnabled({ id: "99999999-2222-4333-8444-555555555555" }, { PODCAST_V3_ENABLED: "1" }), true, "global switch unchanged");
});

test("owner pilot in the worker: only the owner's episodes run with the switch off (owner id, or the app's signed answer)", async () => {
  const { studioWorkerEnabled } = await import("../../../../scripts/podcast-3-0/studio-worker");
  const OWNER = "11111111-2222-4333-8444-555555555555", OTHER = "99999999-2222-4333-8444-555555555555", EP = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  let reads = 0, asks = 0;
  const of = (id: string | null) => async () => { reads++; return id; };
  const app = (answer: boolean) => async () => { asks++; return answer; };
  assert.equal(await studioWorkerEnabled(EP, { PODCAST_V3_OWNER_USER_ID: OWNER }, { ownerOf: of(OWNER), askApp: app(false) }), true, "owner id configured: compared locally");
  assert.equal(await studioWorkerEnabled(EP, { PODCAST_V3_OWNER_USER_ID: OWNER.toUpperCase() }, { ownerOf: of(OWNER) }), true, "case-insensitive");
  assert.equal(await studioWorkerEnabled(EP, { PODCAST_V3_OWNER_USER_ID: OWNER }, { ownerOf: of(OTHER), askApp: app(true) }), false, "another account (the app is not asked)");
  assert.equal(asks, 0);
  assert.equal(await studioWorkerEnabled(EP, {}, { ownerOf: of(OWNER), askApp: app(true) }), true, "no owner id: the app confirms the owner");
  assert.equal(await studioWorkerEnabled(EP, {}, { ownerOf: of(OTHER), askApp: app(false) }), false, "no owner id: the app says not the owner");
  assert.equal(await studioWorkerEnabled(EP, {}, { ownerOf: of(null), askApp: app(true) }), false, "episode not found");
  reads = 0; asks = 0;
  assert.equal(await studioWorkerEnabled(EP, { PODCAST_V3_OWNER_PILOT: "0" }, { ownerOf: of(OWNER), askApp: app(true) }), false, "kill switch");
  assert.equal(await studioWorkerEnabled(EP, { PODCAST_V3_OWNER_USER_ID: "not-a-uuid" }, { ownerOf: of(OWNER), askApp: app(true) }), false, "malformed owner id");
  assert.equal(await studioWorkerEnabled("not-an-id", {}, { ownerOf: of(OWNER), askApp: app(true) }), false);
  assert.equal(reads + asks, 0, "no lookup when the pilot cannot apply");
  assert.equal(await studioWorkerEnabled(EP, { PODCAST_V3_ENABLED: "1" }, { ownerOf: of(null) }), true, "global switch unchanged");
});

test("owner check: signed request bound to the account; any error or other answer fails closed", async () => {
  const { askAppIsStudioOwner, validStudioOwnerSignature, studioOwnerSignature, STUDIO_OWNER_PATH } = await import("./owner-check");
  const KEY = "k".repeat(40), U = "11111111-2222-4333-8444-555555555555", N = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", T = String(Date.now());
  assert.equal(validStudioOwnerSignature(KEY, U, N, T, studioOwnerSignature(KEY, U, N, T)), true);
  assert.equal(validStudioOwnerSignature(KEY, "99999999-2222-4333-8444-555555555555", N, T, studioOwnerSignature(KEY, U, N, T)), false, "signature bound to the account");
  assert.equal(validStudioOwnerSignature(KEY, U, N, String(Date.now() - 600_000), studioOwnerSignature(KEY, U, N, String(Date.now() - 600_000))), false, "expired");
  assert.equal(validStudioOwnerSignature("short", U, N, T, studioOwnerSignature("short", U, N, T)), false, "weak secret");
  let seen: { url: string; ok: boolean } | null = null;
  const f = (owner: unknown, status = 200) => (async (url: string, init: RequestInit) => { const h = init.headers as Record<string, string>; seen = { url, ok: validStudioOwnerSignature(KEY, U, h["x-probe-nonce"], h["x-probe-time"], h["x-probe-signature"]) }; return new Response(JSON.stringify({ owner }), { status }); }) as unknown as typeof fetch;
  assert.equal(await askAppIsStudioOwner(U, { SUPABASE_SERVICE_ROLE_KEY: KEY }, f(true)), true);
  assert.ok(seen!.ok && seen!.url.endsWith(STUDIO_OWNER_PATH), "the request is signed for this account");
  assert.equal(await askAppIsStudioOwner(U, { SUPABASE_SERVICE_ROLE_KEY: KEY }, f(false)), false);
  assert.equal(await askAppIsStudioOwner(U, { SUPABASE_SERVICE_ROLE_KEY: KEY }, f("yes")), false, "only a literal true counts");
  assert.equal(await askAppIsStudioOwner(U, { SUPABASE_SERVICE_ROLE_KEY: KEY }, f(true, 401)), false, "HTTP error");
  assert.equal(await askAppIsStudioOwner(U, { SUPABASE_SERVICE_ROLE_KEY: KEY }, (async () => { throw new Error("down"); }) as unknown as typeof fetch), false, "network error");
  assert.equal(await askAppIsStudioOwner(U, {}, f(true)), false, "no key");
});

test("still photo source: wizard photo from «videos», existing avatar from «avatar-uploads»; never another account's path", async () => {
  // Regresión P2 real (episodio 0de4b445): la foto de un avatar existente se buscaba en «videos» y el episodio falló con «FOTO».
  const { stillSource, STUDIO_BUCKET } = await import("./still-source");
  const { RECORDING_BUCKET } = await import("@/lib/video/avatar/recording");
  const owner = "0f8fad5b-d9cb-469f-a165-70867728950e";
  assert.deepEqual(stillSource(owner, `foto:${owner}/podcast-studio/photos/a.jpg`, null), { bucket: STUDIO_BUCKET, path: `${owner}/podcast-studio/photos/a.jpg` });
  assert.deepEqual(stillSource(owner, "avatar-row-id", `${owner}/avatars/photo.jpg`), { bucket: RECORDING_BUCKET, path: `${owner}/avatars/photo.jpg` });
  assert.equal(RECORDING_BUCKET, "avatar-uploads");
  for (const [ref, photo] of [["avatar-row-id", null], ["avatar-row-id", "otra-cuenta/avatars/p.jpg"], [`foto:otra-cuenta/x.jpg`, null], ["avatar-row-id", `${owner}/../otra/p.jpg`]] as const)
    assert.throws(() => stillSource(owner, ref, photo), /Avatar sin foto fija/, `${ref} ${photo}`);
});
