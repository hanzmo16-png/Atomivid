/**
 * Incidente 8f05fc37 (2026-11-01): 27 min pedidos, MP4 de 5:33 marcado «ready». Pruebas puras (USD 0, sin red ni
 * ffmpeg): la duración se valida antes de producir, el montaje se mide y la desviación queda registrada y visible.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptedMinutes, assertMuxComplete, deliveredDuration, RenderTruncatedError, scriptDuration } from "./duration";
import { generateConversation, scriptMaxTokens, targetWords, templateConversation } from "./script";
import { StudioSpec, STUDIO_VERSION } from "./spec";
import { authorizeAction, episodeAction, studioAction, type ApiDeps } from "./api";
import type { AccountVoice } from "@/lib/podcast/voices";
import type { StudioEpisodeRow } from "./store";

const names = { A: "Hans", B: "Valeria Montclair" };
// El guion real del incidente era la PLANTILLA (12/12 frases fijas): 43 turnos, ~4.500 caracteres.
const templateScript = (minutes: number) => templateConversation({ topic: "La base dulce", hostName: names.A, guestName: names.B, minutes })
  .map((t) => `${names[t.speaker]}: ${t.text}`).join("\n");
const V = (voiceId: string, name: string): AccountVoice => ({ voiceId, name, category: "premade", language: "es", accent: null, gender: null, previewUrl: null } as AccountVoice);
const VOICES = [V("voiceAnaHost1", "Ana"), V("voiceLuisGuest", "Luis")];
const viewer = { id: "u1", email: "h@example.com", email_confirmed_at: "x" };
const specOf = (target: number, script = templateScript(target)) => ({ mode: "narracion", output: "audio", title: "Episodio", script, target_minutes: target,
  participants: [{ id: "A", name: names.A, voice_id: "voiceAnaHost1" }, { id: "B", name: names.B, voice_id: "voiceLuisGuest" }], visual: { provider: "solo_set" }, music: {}, budget_usd: 40 });
const parsed = (target: number, script?: string) => StudioSpec.parse({ ...specOf(target, script), version: STUDIO_VERSION });
const deps = (over: Partial<ApiDeps> = {}): ApiDeps => ({ userId: "u1", viewer, voices: async () => VOICES, enabled: true, llm: null, env: {},
  insert: async () => ({ id: "11111111-1111-4111-8111-111111111111" }), load: async () => null, authorize: async () => true, dispatch: async () => true, ...over });

test("8f05fc37: un guion de ~5,5 min para 27 min pedidos se detecta antes de producir (y hay que aceptarlo)", () => {
  const c = scriptDuration(parsed(27));
  assert.ok(c.estimatedMinutes > 4.5 && c.estimatedMinutes < 6.5, `estimado ${c.estimatedMinutes}`);
  assert.equal(c.short, true); assert.equal(c.needsAcceptance, true);
  assert.ok(c.coverage < 0.25);
  assert.match(c.message!, /elegiste 27 min/); assert.match(c.message!, /no se rellena/);
  assert.equal(acceptedMinutes(c), Math.ceil(c.estimatedSeconds / 60));
});

test("lo que cabe no molesta; un episodio corto solo avisa (no bloquea)", () => {
  const ok = scriptDuration(parsed(5));
  assert.equal(ok.short, false); assert.equal(ok.needsAcceptance, false); assert.equal(ok.message, null);
  const shortish = scriptDuration(parsed(8)); // ~5,5 de 8: corto, pero un episodio < 10 min no exige aceptación
  assert.equal(shortish.short, true); assert.equal(shortish.needsAcceptance, false);
  const nearLong = scriptDuration(parsed(10, templateScript(5).repeat(1)));
  assert.equal(nearLong.needsAcceptance, true, "10 min con ~5,5 de guion (55 %) sí exige aceptarlo");
});

test("API: crear un episodio largo con guion corto se rechaza sin aceptación; al aceptarla se promete la duración real", async () => {
  const est = await studioAction(deps(), { action: "estimate", spec: specOf(27) });
  assert.equal(est.status, 200);
  assert.equal((est.body.estimate as { duration: { needsAcceptance: boolean } }).duration.needsAcceptance, true);
  let inserted: Record<string, unknown> | null = null;
  const d = deps({ insert: async (row) => { inserted = row; return { id: "11111111-1111-4111-8111-111111111111" }; } });
  const no = await studioAction(d, { action: "create", spec: specOf(27) });
  assert.equal(no.status, 409); assert.equal(no.body.code, "DURACION"); assert.equal(inserted, null, "no se crea nada");
  const yes = await studioAction(d, { action: "create", spec: specOf(27), acceptDuration: true });
  assert.equal(yes.status, 200);
  const spec = (inserted as unknown as { spec: { target_minutes: number; requested_minutes: number } }).spec;
  assert.equal(spec.requested_minutes, 27, "se guarda lo que se pidió");
  assert.ok(spec.target_minutes >= 5 && spec.target_minutes <= 7, `prometido ${spec.target_minutes}`);
  // Un episodio que cabe no cambia.
  const fits = await studioAction(d, { action: "create", spec: specOf(5) });
  assert.equal(fits.status, 200); assert.equal((inserted as unknown as { spec: { target_minutes: number; requested_minutes?: number } }).spec.target_minutes, 5);
  assert.equal((inserted as unknown as { spec: { requested_minutes?: number } }).spec.requested_minutes, undefined);
});

test("API: un borrador antiguo que promete 27 min con guion de 5 no se autoriza (ni se cobra)", async () => {
  const row = (target: number): StudioEpisodeRow => ({ id: "e1", user_id: "u1", status: "draft", estimated_usd: 1, spec: parsed(target), title: "T", mode: "narracion" } as unknown as StudioEpisodeRow);
  let charged = false;
  const r = await authorizeAction(deps({ load: async () => row(27), authorize: async () => { charged = true; return true; } }), "e1", { confirm: true, authorizedUsd: 5 });
  assert.equal(r.status, 409); assert.equal(r.body.code, "DURACION"); assert.equal(charged, false);
  const ok = await authorizeAction(deps({ load: async () => row(6), authorize: async () => { charged = true; return true; } }), "e1", { confirm: true, authorizedUsd: 5 });
  assert.equal(ok.status, 200); assert.equal(charged, true);
});

test("al terminar: el MP4 se mide contra su audio (truncado = error) y la desviación frente a lo pedido queda registrada", () => {
  assert.doesNotThrow(() => assertMuxComplete(332.66, 332.7));
  assert.throws(() => assertMuxComplete(200, 332.7), RenderTruncatedError);
  assert.throws(() => assertMuxComplete(Number.NaN, 332.7), RenderTruncatedError);
  const bad = deliveredDuration(parsed(27), 332.66);
  assert.equal(bad.ok, false); assert.equal(bad.measured_seconds, 332.66); assert.equal(bad.target_minutes, 27);
  assert.match(bad.note!, /5:33 frente a 27 min/);
  const good = deliveredDuration(parsed(6), 332.66); // prometido = duración aceptada (6 min)
  assert.equal(good.ok, true); assert.equal(good.note, null);
});

test("la tarjeta recibe la nota de duración solo cuando hubo desviación", async () => {
  const row = (ok: boolean) => ({ id: "e1", user_id: "u1", status: "ready", spec: parsed(27), title: "T", video_path: null, audio_path: null,
    result: { duration: 332.66, duration_check: ok ? { ok: true, note: null } : deliveredDuration(parsed(27), 332.66) } }) as unknown as StudioEpisodeRow;
  const sign = async () => null;
  assert.match(String((await episodeAction("u1", row(false), sign)).body.duration_note), /frente a 27 min/);
  assert.equal((await episodeAction("u1", row(true), sign)).body.duration_note, null);
});

test("guion con IA: los tokens alcanzan para la duración pedida; la plantilla dice cuánto dura de verdad", async () => {
  assert.equal(scriptMaxTokens(5), 4000, "nunca menos que antes");
  assert.ok(scriptMaxTokens(27) >= targetWords(27) * 1.9, `27 min → ${scriptMaxTokens(27)} tokens`);
  assert.ok(scriptMaxTokens(30) <= 16_000);
  const long = await generateConversation({ topic: "La base dulce", hostName: "Hans", guestName: "Valeria", minutes: 27 }, null);
  assert.equal(long.source, "plantilla"); assert.match(long.note ?? "", /pediste 27/);
  const fail = await generateConversation({ topic: "La base dulce", hostName: "Hans", guestName: "Valeria", minutes: 27 }, async () => { throw new Error("timeout"); });
  assert.match(fail.note ?? "", /El modelo no respondió/); assert.match(fail.note ?? "", /pediste 27/);
  const fits = await generateConversation({ topic: "La base dulce", hostName: "Hans", guestName: "Valeria", minutes: 5 }, null);
  assert.equal(fits.note, undefined, "si cabe, no hay nota");
});
