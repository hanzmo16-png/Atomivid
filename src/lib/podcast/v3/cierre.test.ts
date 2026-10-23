/**
 * Podcast V3 — cierre de auditoría: pruebas puras (sin red, sin ffmpeg, sin proveedores reales, USD 0).
 * Cubren los defectos encontrados en la auditoría independiente del PR #192.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { studioReadiness } from "./readiness";
import { stillMotion, FPS } from "./compose";
import { draftToSpec, defaultDraft, modalityToMode, MODALITIES, type WizardDraft } from "./wizard";
import { StudioSpec, STUDIO_VERSION, validateSpec, EL_DURO_VOICE_ID } from "./spec";
import { studioAction, type ApiDeps } from "./api";
import { estimateByMode } from "./studio";
import type { AccountVoice } from "@/lib/podcast/voices";
import type { CapacitySnapshot } from "@/lib/production-intelligence/capacity/capacity";

const snap = (provider: string, unit: CapacitySnapshot["unit"], available: number | null, health: CapacitySnapshot["health"] = "OK"): CapacitySnapshot =>
  ({ provider, accountLabel: "t", unit, available, reserved: 0, pending: 0, renewalDate: null, lastCheckedAt: "2026-10-23T00:00:00Z", health, reliability: available == null ? "none" : "provider_api" });
const needs = (o: Partial<{ ttsChars: number; ttsUsd: number; avatarUsd: number; imagesUsd: number }> = {}) => ({ ttsChars: 9000, ttsUsd: 0.9, avatarUsd: 0, imagesUsd: 0, ...o });

test("saldo previo: sin saldo verificable o insuficiente se bloquea ANTES de cualquier cargo; con saldo, listo", () => {
  assert.equal(studioReadiness(needs(), { elevenlabs: snap("elevenlabs", "character", 50_000) }), null);
  assert.match(studioReadiness(needs(), { elevenlabs: snap("elevenlabs", "character", 100) })!, /quedan 100 caracteres/);
  assert.match(studioReadiness(needs(), { elevenlabs: null })!, /no verificable/);
  assert.match(studioReadiness(needs(), { elevenlabs: snap("elevenlabs", "character", null, "DOWN") })!, /no verificable/);
  // Avatar: solo se exige saldo HeyGen si el episodio usa avatar; saldo en créditos (no USD) no cuenta como verificado.
  assert.equal(studioReadiness(needs({ avatarUsd: 7.7 }), { elevenlabs: snap("elevenlabs", "character", 50_000), heygen: snap("heygen", "usd", 10) }), null);
  assert.match(studioReadiness(needs({ avatarUsd: 7.7 }), { elevenlabs: snap("elevenlabs", "character", 50_000), heygen: snap("heygen", "usd", 3) })!, /HeyGen: saldo USD 3.00/);
  assert.match(studioReadiness(needs({ avatarUsd: 7.7 }), { elevenlabs: snap("elevenlabs", "character", 50_000), heygen: snap("heygen", "credit", 999) })!, /HeyGen/);
  assert.match(studioReadiness(needs({ avatarUsd: 1 }), { elevenlabs: snap("elevenlabs", "character", 50_000) })!, /HeyGen/);
  assert.match(studioReadiness(needs({ imagesUsd: 0.4 }), { elevenlabs: snap("elevenlabs", "character", 50_000) })!, /no está conectado/);
});

test("quien escucha no queda congelado: movimiento de cámara sutil, continuo, del largo exacto del plano y sin animar labios", () => {
  const f = stillMotion(400, 300, 125, 3);
  assert.match(f, /zoompan=/); assert.match(f, /:d=125:/); assert.match(f, /s=400x300/); assert.match(f, new RegExp(`fps=${FPS}`));
  // Sutil: zoom entre 1.01 y 1.07; periodo largo (≥ 6 s) para que no sea un vaivén.
  const [, base, amp, per] = /z='([\d.]+)\+([\d.]+)\*sin\(2\*PI\*on\/(\d+)/.exec(f)!;
  assert.ok(Number(base) - Number(amp) >= 1.0 && Number(base) + Number(amp) <= 1.08, f);
  assert.ok(Number(per) >= FPS * 6, `periodo ${per}`);
  assert.doesNotMatch(f, /drawbox|mouth|boca/i, "solo encuadre: nada que simule la boca");
  assert.notEqual(stillMotion(400, 300, 125, 1), stillMotion(400, 300, 125, 2), "planos distintos no se mueven en sincronía");
});

test("modos del asistente: A solo audio (sin video), B narración con imágenes (MP4), C avatares (MP4)", () => {
  assert.deepEqual([...MODALITIES], ["audio", "visual", "avatar", "dialogo"]);
  const mk = (modality: WizardDraft["modality"]): WizardDraft => ({ ...defaultDraft(), modality, mode: modality ? modalityToMode(modality) : null, title: "T", script: "x".repeat(40), count: 2 });
  const a = draftToSpec(mk("audio")), b = draftToSpec(mk("visual")), c = draftToSpec(mk("dialogo"));
  assert.equal(a.mode, "narracion"); assert.equal(a.output, "audio"); assert.equal(a.visual.provider, "solo_set");
  assert.equal(b.mode, "narracion"); assert.equal(b.output, "video"); assert.equal(b.visual.provider, "pexels");
  assert.equal(c.mode, "dialogo"); assert.equal(c.output, "video");
  // Especificaciones antiguas (sin «output») siguen siendo válidas: por defecto video.
  assert.equal(StudioSpec.parse({ version: STUDIO_VERSION, mode: "narracion", title: "T", script: "y".repeat(30), target_minutes: 1, participants: [{ id: "A", name: "A", voice_id: "voiceAnaHost1" }], visual: {}, music: {}, budget_usd: 1 }).output, "video");
});

const V = (voiceId: string, name: string): AccountVoice => ({ voiceId, name, category: "premade", language: "es", accent: null, gender: null, previewUrl: null } as AccountVoice);
const VOICES = [V("voiceAnaHost1", "Ana"), V("voiceLuisGuest", "Luis"), V(EL_DURO_VOICE_ID, "duro")];
const viewer = { id: "u1", email: "h@example.com", email_confirmed_at: "x" };
const deps = (over: Partial<ApiDeps> = {}): ApiDeps => ({ userId: "u1", viewer, voices: async () => VOICES, enabled: true, llm: null, env: {},
  insert: async () => ({ id: "11111111-1111-4111-8111-111111111111" }), load: async () => null, authorize: async () => true, dispatch: async () => true, ...over });

test("solo audio exige modo narración (un avatar sin video no tiene sentido); estimación de solo audio sin video", async () => {
  const avatarAudio = StudioSpec.parse({ version: STUDIO_VERSION, mode: "avatar", output: "audio", title: "T", script: "y".repeat(30), target_minutes: 1, participants: [{ id: "A", name: "A", voice_id: "voiceAnaHost1", avatar: { kind: "existente", avatar_id: "a1" } }], visual: {}, music: {}, budget_usd: 5 });
  assert.ok(validateSpec(avatarAudio, VOICES, viewer, {}).some((i) => i.field === "output"));
  const r = await studioAction(deps(), { action: "estimate", spec: { mode: "narracion", output: "audio", title: "T", script: "Primer párrafo sobre volcanes.\n\nSegundo párrafo sobre lava.", target_minutes: 1,
    participants: [{ id: "A", name: "Ana", voice_id: "voiceAnaHost1" }], visual: { provider: "solo_set" }, music: {}, budget_usd: 5 } });
  assert.equal(r.status, 200);
  const e = r.body.estimate as { lines: { concept: string; usd: number; detail: string }[]; shots: Record<string, number> };
  assert.match(e.lines.find((l) => l.concept === "video")!.detail, /Solo audio/);
  assert.equal(e.lines.find((l) => l.concept === "avatar")!.usd, 0);
  assert.ok(!e.shots.imagen && !e.shots.archivo, "sin imágenes en solo audio");
});

test("LLM de pago y subida de fotos: con el estudio apagado no se usa el LLM (plantilla gratuita)", async () => {
  let llmCalls = 0;
  const llm = async () => { llmCalls++; return "Ana: hola\nLuis: hola"; };
  const off = await studioAction(deps({ enabled: false, llm }), { action: "script", topic: "volcanes", hostName: "Ana", guestName: "Luis", minutes: 2, useAi: true });
  assert.equal(off.status, 200); assert.equal(off.body.source, "plantilla"); assert.equal(llmCalls, 0, "estudio apagado: ninguna llamada al LLM");
  await studioAction(deps({ enabled: true, llm }), { action: "script", topic: "volcanes", hostName: "Ana", guestName: "Luis", minutes: 2, useAi: true });
  assert.ok(llmCalls >= 1, "estudio encendido + useAi: sí se usa (con su libro de gastos)");
});

test("estimaciones de referencia (10 min) coherentes con tarifas públicas: voz USD 0,10/1K, HeyGen Avatar IV foto USD 2,31/min", () => {
  const m = Object.fromEntries(estimateByMode(10).map((x) => [x.mode, x]));
  const voz = m.solo_audio.estimate.lines.find((l) => l.concept === "voz")!.usd;
  assert.equal(voz, 0.9, "9.000 caracteres × USD 0,10/1K");
  // Avatar: segundos de avatar × 0,0385 USD/s (= 2,31 USD/min), redondeo por clip a centavo hacia arriba.
  const d = m.dialogo; const avatarUsd = d.estimate.lines.find((l) => l.concept === "avatar")!.usd;
  assert.ok(avatarUsd >= d.avatarSeconds * 0.0385 * 0.5 && avatarUsd <= d.avatarSeconds * 0.0385 + 0.01 * 40, `${avatarUsd} vs ${d.avatarSeconds}s`);
  assert.ok(m.solo_audio.estimate.totalUsd < 1.0, `solo audio ${m.solo_audio.estimate.totalUsd}`);
});
