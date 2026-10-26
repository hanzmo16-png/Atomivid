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

test("proveedores visuales: Recraft no disponible con motivo; elegirlo lanza (nunca se sustituye)", () => {
  const ps = visualProviders({});
  const rc = ps.find((p) => p.id === "recraft")!;
  assert.equal(rc.available, false); assert.match(rc.reason!, /FAL_KEY/);
  assert.match(visualProviders({ FAL_KEY: "x" }).find((p) => p.id === "recraft")!.reason!, /no está conectado/);
  assert.equal(visualProviders({ FAL_KEY: "x", PODCAST_STUDIO_RECRAFT: "1" }).find((p) => p.id === "recraft")!.available, true);
  assert.throws(() => requireProvider("recraft", {}), ProviderUnavailableError);
  assert.throws(() => requireProvider("dalle", {}), ProviderUnavailableError);
  assert.equal(requireProvider("pexels", {}).id, "pexels");
});

const V = (voiceId: string, name: string): AccountVoice => ({ voiceId, name, category: "premade", language: "es", accent: null, gender: null, previewUrl: null } as AccountVoice);
const VOICES = [V("voiceAnaHost1", "Ana"), V("voiceLuisGuest", "Luis"), V(EL_DURO_VOICE_ID, "duro")];
const deps = (over: Partial<ApiDeps> = {}): ApiDeps => ({ userId: "u1", viewer: { id: "u1", email: "h@example.com", email_confirmed_at: "x" }, voices: async () => VOICES, enabled: true, llm: null, env: {},
  insert: async () => ({ id: "11111111-1111-4111-8111-111111111111" }), load: async () => null, authorize: async () => true, dispatch: async () => true, ...over });
const dlg = (visual: Record<string, unknown> = {}) => ({ spec: { mode: "dialogo", title: "T", script: templateConversation({ topic: "la luna Europa", hostName: "Ana", guestName: "Luis", minutes: 3 }).map((t) => `${t.speaker === "A" ? "Ana" : "Luis"}: ${t.text}`).join("\n"), target_minutes: 3,
  participants: [{ id: "A", name: "Ana", voice_id: "voiceAnaHost1", avatar: { kind: "existente", avatar_id: "a1" } }, { id: "B", name: "Luis", voice_id: "voiceLuisGuest", avatar: { kind: "existente", avatar_id: "a2" } }], visual, music: {}, budget_usd: 50 } });

test("API: proveedor Recraft elegido y no disponible → 409 con motivo, sin crear ni estimar con otro proveedor", async () => {
  let inserted = 0;
  const r = await studioAction(deps({ insert: async () => { inserted++; return { id: "x" }; } }), { action: "create", ...dlg({ provider: "recraft" }) });
  assert.equal(r.status, 409); assert.match(String(r.body.error), /No se sustituye/); assert.equal(inserted, 0);
  assert.equal((await studioAction(deps(), { action: "estimate", ...dlg({ provider: "recraft" }) })).status, 409);
  const ok = await studioAction(deps(), { action: "estimate", ...dlg({ provider: "pexels" }) });
  assert.equal(ok.status, 200);
  const e = ok.body.estimate as { byProvider: Record<string, number>; providers: { id: string }[]; lipTimeline: unknown[]; coverage: Record<string, boolean>; turnList: { speaker: string; kind: string }[] };
  assert.ok(e.byProvider.ElevenLabs > 0 && "HeyGen" in e.byProvider, "costo por proveedor antes de autorizar");
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
  const d = { ...defaultDraft(), step: STEP.musica, modality: "dialogo" as const, mode: "dialogo" as const, count: 2 as const, intensity: "alta" as const, ducking: false, provider: "pexels" as const };
  const back = loadDraft(JSON.stringify(d));
  assert.equal(back.step, STEP.musica); assert.equal(back.intensity, "alta"); assert.equal(back.ducking, false);
  assert.ok(stepErrors({ ...d, provider: "recraft" }, STEP.visuales, { unavailableVoices: [], providers: visualProviders({}) }).some((e) => /no se cambia automáticamente/.test(e)));
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
