/**
 * Podcast V3 — cierre de auditoría: pruebas puras (sin red, sin ffmpeg, sin proveedores reales, USD 0).
 * Cubren los defectos encontrados en la auditoría independiente del PR #192.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { studioSupplyDemands, studioSpendByProvider, unsupportedSpend } from "./readiness";
import { stillMotion, FPS } from "./compose";
import { draftToSpec, defaultDraft, modalityToMode, MODALITIES, type WizardDraft } from "./wizard";
import { StudioSpec, STUDIO_VERSION, validateSpec, EL_DURO_VOICE_ID } from "./spec";
import { studioAction, type ApiDeps } from "./api";
import { estimateByMode } from "./studio";
import type { AccountVoice } from "@/lib/podcast/voices";

const needs = (o: Partial<{ ttsChars: number; ttsUsd: number; avatarUsd: number; imagesUsd: number }> = {}) => ({ ttsChars: 9000, ttsUsd: 0.9, avatarUsd: 0, imagesUsd: 0, ...o });

test("saldo y topes previos: la demanda del estudio usa la regla de producción e incluye lo gastado por el estudio en 24 h", () => {
  assert.deepEqual(studioSupplyDemands(needs(), {}), [{ provider: "elevenlabs", unit: "character", units: 9000, usd: 0.9 }]);
  const d = studioSupplyDemands(needs({ avatarUsd: 7.7 }), studioSpendByProvider([
    { provider: "heygen", state: "settled", reserved_usd: 0.5, actual_usd: 0.4 }, { provider: "heygen", state: "uncertain", reserved_usd: 0.3, actual_usd: null },
    { provider: "heygen", state: "released", reserved_usd: 9, actual_usd: 0 }, { provider: "elevenlabs", state: "reserved", reserved_usd: 0.2, actual_usd: null }]));
  assert.deepEqual(d.find((x) => x.provider === "heygen"), { provider: "heygen", unit: "usd", units: 8.4, usd: 8.4 }, "liquidado al real + incierto al reservado; liberado no cuenta");
  assert.equal(d.find((x) => x.provider === "elevenlabs")!.usd, 1.1);
  assert.equal(unsupportedSpend(needs({ imagesUsd: 0.4 }))?.includes("no está conectado"), true);
  assert.equal(unsupportedSpend(needs()), null);
  // Daily call quotas: the calls still to make travel with the demand (only when there are any).
  const withCalls = studioSupplyDemands({ ...needs({ avatarUsd: 2 }), ttsCalls: 8, avatarCalls: 0 }, {});
  assert.equal(withCalls.find((x) => x.provider === "elevenlabs")!.calls, 8);
  assert.equal("calls" in withCalls.find((x) => x.provider === "heygen")!, false);
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
  // Evidencia (sin secretos): totales por modo con la tarifa de voz por defecto, para el informe de cierre.
  console.log("ESTIMACION_10MIN " + estimateByMode(10).map((x) => `${x.mode}=${x.estimate.totalUsd.toFixed(2)}(voz ${x.byProvider.ElevenLabs},avatar ${x.byProvider.HeyGen},${Math.round(x.avatarSeconds)}s)`).join(" "));
  const voz = m.solo_audio.estimate.lines.find((l) => l.concept === "voz")!.usd;
  assert.equal(voz, 0.9, "9.000 caracteres × USD 0,10/1K");
  // Avatar: segundos de avatar × 0,0385 USD/s (= 2,31 USD/min), redondeo por clip a centavo hacia arriba.
  const d = m.dialogo; const avatarUsd = d.estimate.lines.find((l) => l.concept === "avatar")!.usd;
  assert.ok(avatarUsd >= d.avatarSeconds * 0.0385 * 0.5 && avatarUsd <= d.avatarSeconds * 0.0385 + 0.01 * 40, `${avatarUsd} vs ${d.avatarSeconds}s`);
  assert.ok(m.solo_audio.estimate.totalUsd < 1.0, `solo audio ${m.solo_audio.estimate.totalUsd}`);
});

test("una sola fuente de tarifas: la estimación guarda sus tarifas y el worker estima/reserva con ellas", async () => {
  const { preflight } = await import("./pipeline");
  const { planningProviders } = await import("./api");
  const spec = StudioSpec.parse({ version: STUDIO_VERSION, mode: "narracion", output: "audio", title: "T", script: "Primer párrafo sobre volcanes y lava.\n\nSegundo párrafo sobre islas.", target_minutes: 1, participants: [{ id: "A", name: "A", voice_id: "voiceAnaHost1" }], visual: { provider: "solo_set" }, music: {}, budget_usd: 5 });
  const a = await preflight(spec, planningProviders(), { voiceUsdPer1kChars: 0.1 }), b = await preflight(spec, planningProviders(), { voiceUsdPer1kChars: 0.2 });
  assert.equal(a.estimate.rates.voiceUsdPer1kChars, 0.1); assert.equal(b.estimate.rates.voiceUsdPer1kChars, 0.2);
  const voz = (e: typeof a) => e.estimate.lines.find((l) => l.concept === "voz")!.usd;
  assert.ok(Math.abs(voz(b) - 2 * voz(a)) <= 0.0002, `${voz(a)} vs ${voz(b)}`);
  assert.equal(a.estimate.rates.avatarUsdPerSecond, 0.0385);
});

test("tope duro de autorización por episodio (USD 50), aunque el presupuesto escrito sea mayor", async () => {
  const { authorizeAction, STUDIO_MAX_AUTHORIZED_USD } = await import("./api");
  const row = { id: "e1", user_id: "u1", status: "draft", estimated_usd: 10, spec: { version: STUDIO_VERSION, mode: "narracion", title: "T", script: "y".repeat(30), target_minutes: 1, participants: [{ id: "A", name: "A", voice_id: "voiceAnaHost1" }], visual: {}, music: {}, budget_usd: 400 } };
  let authorized = 0;
  const d = deps({ load: async () => row as never, authorize: async () => { authorized++; return true; } });
  assert.equal(STUDIO_MAX_AUTHORIZED_USD, 50);
  assert.equal((await authorizeAction(d, "e1", { confirm: true, authorizedUsd: 60 })).status, 402); assert.equal(authorized, 0);
  assert.equal((await authorizeAction(d, "e1", { confirm: true, authorizedUsd: 50 })).status, 200); assert.equal(authorized, 1);
});

// Audit F3 (#200 @ 7153c35): a studio episode left «generating» by a lost runner (mark-failed never ran) could not be
// retried from the API (409). Past the job timeout it is closed like mark-failed does, then the owner can retry.
test("F3 runner perdido: «generating» más viejo que el timeout del job → markStale y reintento; uno reciente sigue en 409", async () => {
  const { authorizeAction, STUDIO_RUNNER_MAX_MS } = await import("./api");
  const spec = { version: STUDIO_VERSION, mode: "narracion", title: "T", script: "y".repeat(30), target_minutes: 1, participants: [{ id: "A", name: "A", voice_id: "voiceAnaHost1" }], visual: {}, music: {}, budget_usd: 10 };
  const mk = (startedMsAgo: number) => {
    let row: Record<string, unknown> = { id: "e1", user_id: "u1", status: "generating", estimated_usd: 1, spec, run_started_at: new Date(Date.now() - startedMsAgo).toISOString() };
    const calls = { mark: 0, authorize: 0, dispatch: 0, before: "" };
    const d = deps({
      load: async () => row as never,
      markStale: async (_id, before) => { calls.mark++; calls.before = before; row = { ...row, status: "failed" }; return true; },
      authorize: async () => { calls.authorize++; return true; },
      dispatch: async () => { calls.dispatch++; return true; },
    });
    return { d, calls };
  };
  const old = mk(STUDIO_RUNNER_MAX_MS + 60_000);
  const r1 = await authorizeAction(old.d, "e1", { confirm: true, authorizedUsd: 2 });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.deepEqual([old.calls.mark, old.calls.authorize, old.calls.dispatch], [1, 1, 1]);
  assert.ok(Date.parse(old.calls.before) <= Date.now() - STUDIO_RUNNER_MAX_MS + 1000, "CAS bound = job timeout");
  const fresh = mk(50 * 60_000); // pasó el umbral de 45 min del run guard, pero el job (200 min) puede seguir vivo
  const r2 = await authorizeAction(fresh.d, "e1", { confirm: true, authorizedUsd: 2 });
  assert.equal(r2.status, 409);
  assert.deepEqual([fresh.calls.mark, fresh.calls.authorize, fresh.calls.dispatch], [0, 0, 0]);
  assert.ok(STUDIO_RUNNER_MAX_MS > 200 * 60_000, "más que el timeout de podcast-video.yml");
});

test("F3 el route implementa markStale como mark-failed: CAS generating→failed y reserved→uncertain (nunca released)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/app/api/podcast/v3/[id]/route.ts", "utf8");
  const m = src.slice(src.indexOf("markStale:"), src.indexOf("}, id, body);"));
  assert.match(m, /\.eq\("status", "generating"\)/);
  assert.match(m, /run_started_at\.lt\./);
  assert.match(m, /state: "uncertain"/);
  assert.doesNotMatch(m, /released/);
});
