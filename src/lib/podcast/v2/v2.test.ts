import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { directSegments, buildProviderRequest, classifyEmotion, DirectionPlan, UnsupportedDirectionError, monotonyScore, type SegmentDirection } from "./director";
import { Conversation, dialogueIssues } from "./conversation";
import { MemoryStore, synthOnce, estimateCall, UnknownPriceError, spent, segmentKey } from "./cost-cache";
import { planMusic, musicIssues } from "./music";
import { editorialQc } from "./qc";
import { canUsePrivateVoice, visibleVoices } from "@/lib/voices/private-voices";
import { conversationFixture, narrationFixture } from "../../../../scripts/podcast-2-0/fixtures";

const PASSAGE = ["Esa noche, de repente, el viento se detuvo.", "Nadie sabía qué venía después.", "Resulta que estaban dentro del ojo del huracán.", "¿Cuánto tiempo dura esa calma?", "Quizás menos de una hora, y luego vuelve todo."];
const inp = (model = "eleven_multilingual_v2") => PASSAGE.map((text, i) => ({ segment_id: `s${i}`, speaker_id: "A", text, voice_id: "voiceA0001", provider: "elevenlabs" as SegmentDirection["provider"], model }));

test("A) tres versiones del mismo pasaje: contrato válido y diferencias deterministas", () => {
  const ref = directSegments(inp(), { mode: "reference" }), pace = directSegments(inp(), { mode: "pace" }), full = directSegments(inp(), { mode: "full" });
  for (const p of [ref, pace, full]) DirectionPlan.parse(p);
  assert.ok(ref.segments.every(s => s.pace === 1 && s.emotion === "calm_explanation"));
  assert.ok(new Set(pace.segments.map(s => s.pace)).size > 1);
  assert.ok(monotonyScore(full) < 1);
  assert.deepEqual(directSegments(inp()), full, "determinista");
  assert.equal(full.segments[2].emotion, "revelation"); assert.equal(full.segments[3].emotion, "qa");
});

test("multilingual_v2 no recibe audio tags: adaptación registrada; <break> nativo sí", () => {
  const full = directSegments(inp());
  for (const s of full.segments) assert.deepEqual(s.native.audio_tags, []);
  assert.ok(full.segments.some(s => s.adaptations.some(a => a.includes("no admitida"))));
  const req = buildProviderRequest(full.segments[0], { previous_text: "x" });
  assert.match(req.text, /<break time="/); assert.equal(req.previous_text, "x");
});

test("v3: audio tags sí, <break> y previous_text no se envían", () => {
  const p = directSegments(inp("eleven_v3"));
  assert.ok(p.segments.some(s => s.native.audio_tags.length));
  const req = buildProviderRequest(p.segments[0], { previous_text: "x" });
  assert.doesNotMatch(req.text, /<break/); assert.equal("previous_text" in req, false);
  const bad = { ...p.segments[0], native: { ...p.segments[0].native, use_break_tags: true } };
  assert.throws(() => buildProviderRequest(bad, {}), UnsupportedDirectionError);
});

test("modelo desconocido y cambio de timbre fallan explicando", () => {
  assert.throws(() => directSegments(inp("eleven_inventado")), UnsupportedDirectionError);
  const x = inp(); x[1] = { ...x[1], voice_id: "otraVoz0002" };
  assert.throws(() => directSegments(x), /timbre/);
});

test("mixto en un mismo hablante: su grabación propia no cuenta como cambio de timbre; su voz sintética sigue vigilada", () => {
  const x = inp(); x[0] = { ...x[0], voice_id: `own-${x[0].speaker_id}`, provider: "own_recording", model: "own_recording" };
  assert.doesNotThrow(() => directSegments(x));
  const y = inp(); y[0] = { ...y[0], voice_id: `own-${y[0].speaker_id}`, provider: "own_recording", model: "own_recording" }; y[1] = { ...y[1], voice_id: "otraVoz0002" };
  assert.throws(() => directSegments(y), /timbre/);
});

test("guardas: velocidad alta sostenida y salto emocional", () => {
  const t = ["¡Genial!", "¡Fantástico!", "¡Impresionante!", "¡Me encanta!"].map((text, i) => ({ segment_id: `e${i}`, speaker_id: "A", text, voice_id: "voiceA0001", provider: "elevenlabs" as const, model: "eleven_multilingual_v2" }));
  const p = directSegments(t);
  assert.ok(p.segments[2].pace <= 1.0); assert.ok(p.segments[2].adaptations.some(a => a.includes("sostenida")));
  for (let i = 2; i < p.segments.length; i++) assert.ok(!(p.segments[i].pace > 1.05 && p.segments[i - 1].pace > 1.05 && p.segments[i - 2].pace > 1.05));
  assert.equal(classifyEmotion("Murió en la tragedia"), "solemnity");
});

test("C) conversación: esquema, fuentes en hechos, sin problemas de diálogo", () => {
  const c = Conversation.parse(conversationFixture());
  assert.deepEqual(dialogueIssues(c), []);
  const bad = structuredClone(c); bad.turns[2].source_url = null; bad.turns[2].claim = "documented_fact";
  assert.equal(Conversation.safeParse(bad).success, false);
  const same = structuredClone(c); same.participants[1].voice_id = same.participants[0].voice_id; same.participants[1].source = same.participants[0].source;
  assert.equal(Conversation.safeParse(same).success, false);
});

test("E/F) caché: sin doble gasto, ambiguo bloquea, aislamiento entre cuentas", async () => {
  const store = new MemoryStore(); let calls = 0;
  const key = segmentKey({ owner_id: "u1", voice_id: "v", model: "m", text: "hola", settings: {} });
  const ok = async () => { calls++; return { file: "/x.wav" }; };
  await synthOnce(store, { key, owner_id: "u1", usd: 0.01, capUsd: 1 }, ok);
  assert.equal((await synthOnce(store, { key, owner_id: "u1", usd: 0.01, capUsd: 1 }, ok)).reused, true);
  assert.equal(calls, 1);
  await assert.rejects(synthOnce(store, { key, owner_id: "u2", usd: 0.01, capUsd: 1 }, ok), /ACCESO_DENEGADO/);
  const k2 = "k2";
  await assert.rejects(synthOnce(store, { key: k2, owner_id: "u1", usd: 0.02, capUsd: 1 }, async () => { throw new Error("timeout"); }));
  await assert.rejects(synthOnce(store, { key: k2, owner_id: "u1", usd: 0.02, capUsd: 1 }, ok), /SEGMENTO_INCIERTO/);
  assert.equal(spent(store, "u1"), 0.03, "el ambiguo cuenta como gastado");
  await assert.rejects(synthOnce(store, { key: "k3", owner_id: "u1", usd: 0.98, capUsd: 1 }, ok), /PRESUPUESTO/);
  assert.throws(() => estimateCall("modelo_x", 100), UnknownPriceError);
  assert.equal(estimateCall("eleven_multilingual_v2", 486), 0.0389);
});

test("F) voz privada (El Duro): solo cuenta autorizada y confirmada", () => {
  const env = { PRIVATE_VOICE_GRANTS: "CeFSZuaHs4SxcBxb9nCr=owner@example.com" };
  assert.equal(canUsePrivateVoice("CeFSZuaHs4SxcBxb9nCr", { email: "owner@example.com", email_confirmed_at: "2026-01-01" }, env), true);
  assert.equal(canUsePrivateVoice("CeFSZuaHs4SxcBxb9nCr", { email: "otro@example.com", email_confirmed_at: "2026-01-01" }, env), false);
  assert.equal(canUsePrivateVoice("CeFSZuaHs4SxcBxb9nCr", { email: "owner@example.com", email_confirmed_at: null }, env), false);
  const v = [{ voiceId: "CeFSZuaHs4SxcBxb9nCr", name: "duro hans", category: "cloned", language: null, accent: null, gender: null, previewUrl: null }];
  assert.equal(visibleVoices(v, { email: "otro@example.com", email_confirmed_at: "x" }, env).length, 0);
});

test("música y QC editorial", () => {
  const plan = directSegments(narrationFixture().map(s => ({ segment_id: s.id, speaker_id: "A", text: s.text, voice_id: "m", provider: "mock" as const, model: "mock" })));
  const cues = planMusic(plan, [{ file: "a.mp3", title: "a", artist: "x", license: "CC BY 4.0", source_url: "https://x", moods: ["calm", "suspense", "revelation", "reflection", "enthusiasm"] }]);
  for (let i = 1; i < cues.length - 1; i++) assert.ok(cues[i].end_ms - cues[i].start_ms >= 8000);
  assert.ok(musicIssues(cues, new Set()).some(x => x.includes("sin licencia")));
  const qc = editorialQc(plan, { targetMinutes: 15 });
  assert.ok(qc.find(f => !f.objective)?.detail.includes("ESCUCHA HUMANA"));
});

test("worker con PODCAST_V2_ENABLED distinto de la app: una fila Podcast 2 nunca se narra por la ruta 1.x (fail-closed antes de pagar)", async () => {
  const { refuseUnreadV2Production, V2ProductionNotReadError } = await import("../server");
  const fake = (res: { data?: unknown; error?: { code?: string; message?: string } | null }) =>
    ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: res.data ?? null, error: res.error ?? null }) }) }) }) }) as never;
  await refuseUnreadV2Production(fake({ error: { code: "42703", message: 'column podcast_episodes.production does not exist' } }), "e1"); // BD sin migrar → 1.x
  await refuseUnreadV2Production(fake({ data: { production: null } }), "e1");                                                       // fila 1.x
  await assert.rejects(refuseUnreadV2Production(fake({ data: { production: { version: "podcast-production/1" } } }), "e1"), V2ProductionNotReadError);
  await assert.rejects(refuseUnreadV2Production(fake({ error: { code: "PGRST000", message: "timeout" } }), "e1"), V2ProductionNotReadError); // error ambiguo → no se paga
  const src = readFileSync("src/lib/podcast/server.ts", "utf8"), run = src.slice(src.indexOf("export async function runGeneration"));
  assert.ok(run.indexOf("refuseUnreadV2Production(") > 0 && run.indexOf("refuseUnreadV2Production(") < run.indexOf("narrateEpisode("), "la comprobación va antes de la narración 1.x");
  const wf = readFileSync(".github/workflows/podcast-video.yml", "utf8");
  assert.match(wf.slice(wf.indexOf("- name: Produce"), wf.indexOf("- name: Mark failed")), /PODCAST_V2_ENABLED: \$\{\{ vars\.PODCAST_V2_ENABLED \}\}/, "el worker recibe el mismo flag que la app");
});
