/**
 * «Animación IA» en Reels (image-to-video): contrato, disponibilidad,
 * plan por escena, resolver durable del clip y recorrido del pipeline.
 * Todo con proveedores simulados, Storage en memoria y render espía —
 * cero red, cero gasto. Demuestra funcionamiento técnico, no calidad visual.
 */
process.env.AUDIOVISUAL_STORAGE_RETRY_MS = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { GenerativeProviderError, type GeneratedScript, type GenerativeAsset, type VideoGenerationRequest, type VideoProvider } from "@/lib/providers/types";
import { isAudiovisualSelection, motionModeOf, parseSelection, previewSummary } from "./catalog";
import { directionFingerprint, resolveDirection } from "./direction";
import { AnimationPlanError, MIN_ACTION_SECONDS, REEL_ANIMATION, animationClipCostUsd, buildContinuityBible, planAnimatedShots, planSceneAnimation, scenesMissingAction, scenesTooLongForClip } from "./animation";
import { checkAnimationAvailability, evaluateDirectionReadiness } from "./readiness";
import { ANIMATION_INPUT_SIZE, AnimatedClipUncertainError, animationLedgerKey, animationMarkerPath, frameAnimationInput, looksLikeMp4, prepareAnimationInputImage, resolveAnimatedClipForScene } from "./animated-clip";
import { PaidBudgetExceededError, PaidLedger, memoryLedgerStore } from "./paid-ledger";
import { openStorageLedger } from "./paid-costs";
import { memoryStorage } from "./test-storage";
import { recoverPaidOperation, RecoveryRefusedError } from "./recovery";
import type { Scene } from "../../../../remotion/VerticalReel";

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(64, 1)]);

// ---------- Contrato: estilo y movimiento separados ----------

test("contrato: el movimiento es un eje propio; «Imágenes» es el valor por defecto y no se guarda", () => {
  const images = parseSelection({ profile: "comic", motion: "images" });
  assert.ok(images.ok && images.selection.motion === undefined && motionModeOf(images.selection) === "images");
  const anim = parseSelection({ profile: "comic", motion: "ai_animation" });
  assert.ok(anim.ok && anim.selection.motion === "ai_animation");
  assert.equal(parseSelection({ profile: "comic", motion: "zoom" }).ok, false);
  for (const profile of ["cinematic_realistic", "illustration_3d", "anime", "comic", "horror_mystery"]) {
    const p = parseSelection({ profile, motion: "ai_animation" });
    assert.ok(p.ok && isAudiovisualSelection(p.selection), `${profile} puede pedir animación`);
  }
  assert.match(previewSummary({ version: 1, profile: "anime", motion: "ai_animation" }, "Humor"), /animación IA$/);
});

test("compatibilidad: una selección antigua (sin movimiento) conserva su huella; elegir animación la cambia", () => {
  const scenes = [{ text: "Hola", energy: "low" }];
  const legacy = { version: 1 as const, profile: "comic" as const };
  const legacyPayloadFingerprint = directionFingerprint({ selection: legacy, scenes });
  assert.equal(directionFingerprint({ selection: { ...legacy }, scenes }), legacyPayloadFingerprint);
  assert.notEqual(directionFingerprint({ selection: { ...legacy, motion: "ai_animation" }, scenes }), legacyPayloadFingerprint);
  // Huella calculada con la versión anterior del código para esta misma entrada (sin campo motion).
  assert.equal(legacyPayloadFingerprint, directionFingerprint({ selection: JSON.parse(JSON.stringify(legacy)), scenes }));
});

// ---------- Disponibilidad antes de gastar ----------

const flags = (over: Record<string, unknown> = {}) =>
  ({ imageGenerationEnabled: true, maxVisualCostUsd: 1, maxStyledImagesPerVideo: 10, reelAiAnimationEnabled: true, maxAiAnimationCostUsd: 10, ...over }) as never;

test("disponibilidad: apagada por defecto, sin proveedor o sin tope → bloqueada con motivo; «Imágenes» nunca evalúa animación", () => {
  const base = { profile: "comic" as const, music: "none" as const, sceneCount: 4, imageProvider: "openai", musicProviderSetting: "fixture" };
  const off = evaluateDirectionReadiness({ ...base, flags: flags({ reelAiAnimationEnabled: false }), motion: "ai_animation", animationProvider: "veo" });
  assert.equal(off.ok, false);
  assert.equal(off.issues[0].code, "animation_disabled");
  assert.equal(evaluateDirectionReadiness({ ...base, flags: flags(), motion: "ai_animation", animationProvider: null }).issues[0].code, "provider_unavailable");
  assert.equal(evaluateDirectionReadiness({ ...base, flags: flags({ maxAiAnimationCostUsd: 0 }), motion: "ai_animation", animationProvider: "veo" }).issues[0].code, "no_budget");
  const over = evaluateDirectionReadiness({ ...base, flags: flags({ maxAiAnimationCostUsd: 2 }), motion: "ai_animation", animationProvider: "veo" });
  assert.equal(over.issues[0].code, "over_budget");
  const images = evaluateDirectionReadiness({ ...base, flags: flags({ reelAiAnimationEnabled: false }), motion: "images", animationProvider: null });
  assert.equal(images.ok, true);
  assert.equal(images.animation, undefined);
  // Perfiles de stock en animación necesitan ilustraciones base: sin generación de imágenes, bloqueado.
  const stockAnim = evaluateDirectionReadiness({ ...base, profile: "horror_mystery", flags: flags({ imageGenerationEnabled: false }), motion: "ai_animation", animationProvider: "veo" });
  assert.ok(stockAnim.issues.some((i) => i.code === "generation_disabled"));
});

test("disponibilidad: una escena cuya narración no cabe en un clip de 8 s se rechaza antes de gastar", () => {
  const long = Array.from({ length: 30 }, () => "palabra").join(" ");
  assert.deepEqual(scenesTooLongForClip(["corta y breve", long]), [1]);
  const a = checkAnimationAvailability({ sceneCount: 2, sceneTexts: ["corta y breve", long], enabled: true, provider: "veo", maxCostUsd: 10 });
  assert.ok(!a.ok && a.code === "scene_too_long");
  const ok = checkAnimationAvailability({ sceneCount: 6, enabled: true, provider: "veo", maxCostUsd: 10 });
  assert.ok(ok.ok && ok.estimatedUsd === 5.76 && ok.model === "veo-3.1-fast-generate-preview" && ok.clipSeconds === 8);
});

// ---------- Plan por escena ----------

const SCRIPT: GeneratedScript = {
  title: "El faro",
  segments: [
    { text: "Nadie sabe qué pasó aquella noche en el faro.", visualQuery: "old lighthouse at night", visualConcepts: ["old lighthouse at night", "stormy coast"], energy: "low", visibleAction: "the lighthouse beam sweeps slowly across the sea" },
    { text: "El guardián desapareció sin dejar rastro.", visualQuery: "empty stairway", energy: "medium", visibleAction: "a lantern on the stairs flickers and goes out" },
    { text: "Entonces encontraron la puerta cerrada por dentro.", visualQuery: "locked wooden door", energy: "high", visibleAction: "the door handle rattles hard and stops" },
  ],
};

test("plan: cada escena declara narración, sujeto, acción, estados, referencia, constantes y encuadre; la clave cambia con la imagen", () => {
  const bible = buildContinuityBible({ profile: "comic", intent: "suspense", topic: "El faro", scenes: SCRIPT.segments });
  assert.match(bible.text, /old lighthouse at night/);
  const spec = planSceneAnimation({ sceneIndex: 0, segment: SCRIPT.segments[0], energy: "low", intent: "suspense", bible, referenceImagePath: "req/scene-0-animbase-a.png", referenceImageKey: "a", visibleSeconds: 4 });
  for (const field of ["narration", "subject", "action", "startState", "endState", "referenceImagePath", "framing", "camera", "prompt", "negativePrompt"] as const) {
    assert.ok(String(spec[field]).length > 0, field);
  }
  assert.ok(spec.constants.length >= 3);
  assert.match(spec.framing, /bottom third free for subtitles/);
  assert.match(spec.negativePrompt, /dialogue/);
  const other = planSceneAnimation({ sceneIndex: 0, segment: SCRIPT.segments[0], energy: "low", intent: "suspense", bible, referenceImagePath: "req/x.png", referenceImageKey: "b", visibleSeconds: 4 });
  assert.notEqual(other.key, spec.key, "otra imagen de entrada → otro clip");
  // La acción declarada (no una genérica por energía) y el intervalo visible real entran en el prompt.
  assert.equal(spec.action, "the lighthouse beam sweeps slowly across the sea");
  assert.equal(spec.visibleSeconds, 4);
  assert.match(spec.prompt, /The ONLY visible action: the lighthouse beam sweeps slowly across the sea/);
  assert.match(spec.prompt, /fully completed by second 3\.7; the shot is cut at second 4\.0/);
  const longer = planSceneAnimation({ sceneIndex: 0, segment: SCRIPT.segments[0], energy: "low", intent: "suspense", bible, referenceImagePath: "req/scene-0-animbase-a.png", referenceImageKey: "a", visibleSeconds: 6 });
  assert.notEqual(longer.key, spec.key, "otro intervalo visible → otras instrucciones → otro clip");
});

test("plan: sin acción declarada, o si no cabe en lo que se ve del plano, se bloquea (sin acelerar ni congelar)", () => {
  const bible = buildContinuityBible({ profile: "comic", intent: "suspense", topic: "El faro", scenes: SCRIPT.segments });
  const base = { sceneIndex: 1, energy: "medium" as const, intent: "suspense" as const, bible, referenceImagePath: "req/b.png", referenceImageKey: "b" };
  const noAction = { ...SCRIPT.segments[1], visibleAction: undefined };
  assert.throws(() => planSceneAnimation({ ...base, segment: noAction, visibleSeconds: 4 }), (e: unknown) => e instanceof AnimationPlanError && /no declara una acción visible/.test((e as Error).message));
  assert.throws(() => planSceneAnimation({ ...base, segment: { ...SCRIPT.segments[1], visibleAction: "  " }, visibleSeconds: 4 }), AnimationPlanError);
  assert.throws(
    () => planSceneAnimation({ ...base, segment: SCRIPT.segments[1], visibleSeconds: MIN_ACTION_SECONDS.medium - 0.2 }),
    (e: unknown) => e instanceof AnimationPlanError && /solo se ve 1\.8 s/.test((e as Error).message) && /no se acelera ni se congela/.test((e as Error).message),
  );
  assert.throws(() => planSceneAnimation({ ...base, segment: SCRIPT.segments[1], visibleSeconds: 8.5 }), AnimationPlanError);
  assert.doesNotThrow(() => planSceneAnimation({ ...base, segment: SCRIPT.segments[1], visibleSeconds: MIN_ACTION_SECONDS.medium }));
  assert.deepEqual(scenesMissingAction([{ visibleAction: "a door opens" }, {}, { visibleAction: "" }]), [1, 2]);
  const shots = planAnimatedShots({ sceneSpans: [{ start: 0, end: 3 }, { start: 3, end: 4.2 }, { start: 4.2, end: 7 }], transitionInFrames: 18, fps: 30, sceneEnergy: ["low", "medium", "high"] });
  assert.deepEqual(shots.tooShort.map((t) => [t.sceneIndex, t.minimumSeconds]), [[1, MIN_ACTION_SECONDS.medium]]);
});

test("disponibilidad: sin acción declarada o con escenas estimadas demasiado cortas, la animación se bloquea antes de pagar nada", () => {
  const base = { sceneCount: 2, enabled: true, provider: "veo", maxCostUsd: 10 };
  const texts = ["Nadie sabe qué pasó aquella noche en el faro del norte.", "Entonces encontraron la puerta cerrada por dentro."];
  const missing = checkAnimationAvailability({ ...base, sceneTexts: texts, sceneActions: ["a beam sweeps", undefined] });
  assert.ok(!missing.ok && missing.code === "action_missing" && /escena 2/.test(missing.message));
  const short = checkAnimationAvailability({ ...base, sceneTexts: ["Silencio.", texts[1]], sceneActions: ["a", "b c d"], sceneEnergy: ["low", "high"] });
  assert.ok(!short.ok && short.code === "scene_too_short" && /escena 1/.test(short.message));
  assert.ok(checkAnimationAvailability({ ...base, sceneTexts: texts, sceneActions: ["a beam sweeps", "a handle rattles"] }).ok);
});

test("montaje animado: un plano continuo por escena sin zoom añadido; una escena más larga que el clip se rechaza (nunca se congela)", () => {
  const ok = planAnimatedShots({ sceneSpans: [{ start: 0, end: 4 }, { start: 4, end: 9 }, { start: 9, end: 12.5 }], transitionInFrames: 18, fps: 30 });
  assert.deepEqual(ok.shots.map((s) => [s.startSeconds, s.endSeconds, s.motion]), [[0, 4, "hold"], [4, 9, "hold"], [9, 12.5, "hold"]]);
  assert.equal(ok.tooLong.length, 0);
  const bad = planAnimatedShots({ sceneSpans: [{ start: 0, end: 7.9 }, { start: 7.9, end: 10 }], transitionInFrames: 18, fps: 30 });
  assert.deepEqual(bad.tooLong.map((t) => t.sceneIndex), [0], "7,9 s + fundido supera los 8 s del clip");
});

// ---------- Resolver durable del clip ----------

function fakeVeo(behaviors: Array<"ok" | "timeout_after_accept" | "moderation_after_accept" | "refused" | "invalid">) {
  const calls: { kind: "generate" | "resume"; request: VideoGenerationRequest; op?: string }[] = [];
  let n = 0;
  const asset = (op: string): GenerativeAsset => ({ buffer: MP4, mimeType: "video/mp4", extension: "mp4", durationSeconds: 8, model: "veo-3.1-fast-generate-preview", costUsd: animationClipCostUsd(), providerJobId: op, sourceHasGeneratedAudio: true });
  const provider: VideoProvider = {
    name: "veo",
    capabilities: { id: "veo", models: ["veo-3.1-fast-generate-preview"], formats: ["video/mp4"], aspectRatios: ["9:16"], timeoutMs: 0, maxRetries: 0 },
    isAvailable: () => true,
    async generateVideo(request) {
      const b = behaviors[Math.min(n, behaviors.length - 1)];
      n += 1;
      calls.push({ kind: "generate", request });
      if (b === "refused") throw new GenerativeProviderError("red antes del envío", "veo", "upstream_error", undefined, undefined, "not_sent");
      const op = `models/veo/operations/op-${n}`;
      await request.onProviderJobAccepted?.(op);
      if (b === "timeout_after_accept") throw new GenerativeProviderError("tiempo agotado sondeando", "veo", "timeout", undefined, op);
      if (b === "moderation_after_accept") throw new GenerativeProviderError("La operación de Veo falló: safety", "veo", "moderation_rejected", undefined, op);
      if (b === "invalid") return { ...asset(op), buffer: Buffer.from("no-es-mp4") };
      return asset(op);
    },
    async resumeGeneration(op, request) {
      calls.push({ kind: "resume", request, op });
      return asset(op);
    },
  };
  return { provider, calls };
}

async function withBaseImage(s: ReturnType<typeof memoryStorage>) {
  const png = await sharp({ create: { width: 1024, height: 1536, channels: 3, background: { r: 30, g: 60, b: 90 } } }).png().toBuffer();
  s.files.set("req/scene-0-animbase-a.png", png);
  return png;
}

const bible = buildContinuityBible({ profile: "anime", intent: "suspense", topic: "El faro", scenes: SCRIPT.segments });
const spec = planSceneAnimation({ sceneIndex: 0, segment: SCRIPT.segments[0], energy: "low", intent: "suspense", bible, referenceImagePath: "req/scene-0-animbase-a.png", referenceImageKey: "a", visibleSeconds: 4 });

async function resolveClip(s: ReturnType<typeof memoryStorage>, provider: VideoProvider, ledger?: PaidLedger, newOperationBudget?: { capUsd: number; committedUsd: () => number }) {
  const input = await prepareAnimationInputImage({ supabase: s.client, bucket: "videos", requestId: "req", baseImagePath: spec.referenceImagePath, objectPrefix: `scene-0-anim-${spec.key}`, signedUrlTtlSeconds: 60 });
  return resolveAnimatedClipForScene({ supabase: s.client, bucket: "videos", requestId: "req", spec, inputImage: input, videoProvider: provider, maxCostUsd: animationClipCostUsd(), signedUrlTtlSeconds: 60, ledger, newOperationBudget });
}

const markerOf = (s: ReturnType<typeof memoryStorage>) => s.json<{ status: string; operationName?: string }>(animationMarkerPath("req", `scene-0-anim-${spec.key}`));

test("clip: la ilustración de la escena viaja como imagen de entrada (encuadrada en 9:16 sin recortar), con reserva guardada ANTES de llamar", async () => {
  const s = memoryStorage();
  await withBaseImage(s);
  const veo = fakeVeo(["ok"]);
  const ledger = await openStorageLedger(s.client, "videos", "req", { capUsd: 5 });
  let reservedDuringCall = "";
  const spy: VideoProvider = {
    ...veo.provider,
    async generateVideo(request) {
      reservedDuringCall = s.json<{ entries: { status: string; kind: string }[] }>("req/state/paid-ledger.json")!.entries.at(-1)!.status;
      return veo.provider.generateVideo(request);
    },
  };
  const out = await resolveClip(s, spy, ledger);
  assert.equal(out.status, "generated");
  assert.equal(reservedDuringCall, "reserved");
  const sent = veo.calls[0].request;
  assert.equal(sent.referenceImageUrl, "memory://req/anim-input/scene-0-anim-" + spec.key + ".png", "imagen de entrada real, no solo texto");
  const meta = await sharp(s.files.get(`req/anim-input/scene-0-anim-${spec.key}.png`)!).metadata();
  assert.deepEqual([meta.width, meta.height], [1080, 1920]);
  assert.equal(sent.aspectRatio, "9:16");
  assert.equal(sent.durationSeconds, REEL_ANIMATION.clipSeconds);
  assert.match(sent.prompt, /Animate this illustration with real motion/);
  assert.ok(s.files.has(out.path) && looksLikeMp4(s.files.get(out.path)!));
  assert.equal(markerOf(s)?.status, "stored");
  const entry = ledger.snapshot().entries.at(-1)!;
  assert.deepEqual([entry.kind, entry.status, entry.key], ["video", "spent", animationLedgerKey("req", `scene-0-anim-${spec.key}`)]);
  assert.equal(entry.actualUsd, 0.96);

  // Reintento: se reutiliza el clip guardado, sin llamar.
  const again = await resolveClip(s, veo.provider, await openStorageLedger(s.client, "videos", "req", { capUsd: 5 }));
  assert.equal(again.status, "reused");
  assert.equal(veo.calls.length, 1);
});

test("clip: si el sondeo se corta tras aceptar la operación, el reintento la REANUDA sin crear otra y liquida la misma reserva", async () => {
  const s = memoryStorage();
  await withBaseImage(s);
  const veo = fakeVeo(["timeout_after_accept"]);
  await assert.rejects(resolveClip(s, veo.provider, await openStorageLedger(s.client, "videos", "req", { capUsd: 5 })), /tiempo agotado/);
  assert.deepEqual([markerOf(s)?.status, markerOf(s)?.operationName], ["submitted", "models/veo/operations/op-1"]);

  const retryLedger = await openStorageLedger(s.client, "videos", "req", { capUsd: 5 });
  const out = await resolveClip(s, veo.provider, retryLedger);
  assert.equal(out.status, "resumed");
  assert.deepEqual(veo.calls.map((c) => c.kind), ["generate", "resume"]);
  assert.equal(veo.calls[1].op, "models/veo/operations/op-1");
  assert.equal(retryLedger.snapshot().entries.length, 1, "una sola reserva para una sola operación");
  assert.equal(retryLedger.summary().committedUsd, 0.96);
});

test("clip: una operación fallida (p. ej. seguridad) o un archivo inválido bloquean el reintento; nunca se regenera solo", async () => {
  for (const behavior of ["moderation_after_accept", "invalid"] as const) {
    const s = memoryStorage();
    await withBaseImage(s);
    const veo = fakeVeo([behavior, "ok"]);
    await assert.rejects(resolveClip(s, veo.provider, await openStorageLedger(s.client, "videos", "req", { capUsd: 5 })));
    await assert.rejects(resolveClip(s, veo.provider, await openStorageLedger(s.client, "videos", "req", { capUsd: 5 })), AnimatedClipUncertainError);
    assert.equal(veo.calls.length, 1, behavior);
  }
});

test("clip: fallo inequívocamente previo al envío → se libera y el reintento sí genera", async () => {
  const s = memoryStorage();
  await withBaseImage(s);
  const veo = fakeVeo(["refused", "ok"]);
  const ledger = await openStorageLedger(s.client, "videos", "req", { capUsd: 5 });
  await assert.rejects(resolveClip(s, veo.provider, ledger), /antes del envío/);
  assert.equal(markerOf(s)?.status, "released");
  assert.equal(ledger.summary().committedUsd, 0);
  assert.equal((await resolveClip(s, veo.provider, await openStorageLedger(s.client, "videos", "req", { capUsd: 5 }))).status, "generated");
});

test("clip: sin presupuesto para la reserva no se llama al proveedor", async () => {
  const s = memoryStorage();
  await withBaseImage(s);
  const veo = fakeVeo(["ok"]);
  await assert.rejects(resolveClip(s, veo.provider, await PaidLedger.open(memoryLedgerStore(), { scope: "req", capUsd: 0.5 })), PaidBudgetExceededError);
  assert.equal(veo.calls.length, 0);
});

test("clip: con el tope de animación YA comprometido, un clip guardado se reutiliza y una operación pendiente se reanuda; solo una operación NUEVA exige presupuesto", async () => {
  const cost = animationClipCostUsd();
  // Tope exactamente igual a lo ya comprometido por este clip.
  const fullCap = (ledger: PaidLedger) => ({ capUsd: cost, committedUsd: () => ledger.summary().byKind.video?.usd ?? 0 });

  // 1) Clip guardado.
  const s = memoryStorage();
  await withBaseImage(s);
  const veo = fakeVeo(["ok"]);
  const first = await openStorageLedger(s.client, "videos", "req", { capUsd: 5 });
  assert.equal((await resolveClip(s, veo.provider, first, fullCap(first))).status, "generated");
  const again = await openStorageLedger(s.client, "videos", "req", { capUsd: 5 });
  assert.equal(again.summary().byKind.video?.usd, cost, "el tope ya está comprometido");
  assert.equal((await resolveClip(s, veo.provider, again, fullCap(again))).status, "reused");
  assert.equal(veo.calls.length, 1);

  // 2) Operación enviada cuyo sondeo se cortó.
  const s2 = memoryStorage();
  await withBaseImage(s2);
  const veo2 = fakeVeo(["timeout_after_accept"]);
  const l1 = await openStorageLedger(s2.client, "videos", "req", { capUsd: 5 });
  await assert.rejects(resolveClip(s2, veo2.provider, l1, fullCap(l1)), /tiempo agotado/);
  const l2 = await openStorageLedger(s2.client, "videos", "req", { capUsd: 5 });
  assert.equal(l2.summary().byKind.video?.usd, cost);
  const resumed = await resolveClip(s2, veo2.provider, l2, fullCap(l2));
  assert.equal(resumed.status, "resumed");
  assert.deepEqual(veo2.calls.map((c) => c.kind), ["generate", "resume"]);
  assert.equal(l2.summary().committedUsd, cost, "reanudar no reserva de nuevo");

  // 3) Operación nueva con el tope comprometido → bloqueada sin llamar.
  const s3 = memoryStorage();
  await withBaseImage(s3);
  const veo3 = fakeVeo(["ok"]);
  const l3 = await openStorageLedger(s3.client, "videos", "req", { capUsd: 5 });
  await assert.rejects(resolveClip(s3, veo3.provider, l3, { capUsd: cost, committedUsd: () => cost }), (e: unknown) => e instanceof PaidBudgetExceededError && /No se llamó al proveedor/.test((e as Error).message));
  assert.equal(veo3.calls.length, 0);
  assert.equal(l3.snapshot().entries.length, 0, "sin reserva");
});

test("encuadre: la imagen de entrada conserva la ilustración COMPLETA (elementos en los cuatro bordes), también en formatos no 9:16", async () => {
  const marker = (color: { r: number; g: number; b: number }, left: number, top: number) => ({
    input: { create: { width: 40, height: 40, channels: 3 as const, background: color } },
    left,
    top,
  });
  const RED = { r: 255, g: 0, b: 0 };
  const GREEN = { r: 0, g: 255, b: 0 };
  const BLUE = { r: 0, g: 0, b: 255 };
  const YELLOW = { r: 255, g: 255, b: 0 };
  for (const [w, h] of [[1024, 1536], [1536, 1024], [1024, 1024], [1080, 1920]] as const) {
    // Marcadores tocando cada borde: arriba, abajo, izquierda, derecha.
    const edges = [
      { color: RED, x: w / 2 - 20, y: 0 },
      { color: GREEN, x: w / 2 - 20, y: h - 40 },
      { color: BLUE, x: 0, y: h / 2 - 20 },
      { color: YELLOW, x: w - 40, y: h / 2 - 20 },
    ];
    const source = await sharp({ create: { width: w, height: h, channels: 3, background: { r: 128, g: 128, b: 128 } } })
      .composite(edges.map((e) => marker(e.color, e.x, e.y)))
      .png()
      .toBuffer();
    const { png, content } = await frameAnimationInput(source);
    const meta = await sharp(png).metadata();
    assert.deepEqual([meta.width, meta.height], [ANIMATION_INPUT_SIZE.width, ANIMATION_INPUT_SIZE.height]);
    assert.ok(content.left >= 0 && content.top >= 0 && content.left + content.width <= ANIMATION_INPUT_SIZE.width && content.top + content.height <= ANIMATION_INPUT_SIZE.height, `${w}x${h}: la ilustración cabe entera`);
    assert.ok(Math.abs(content.width / content.height - w / h) < 0.01, `${w}x${h}: sin deformar`);
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const scale = content.width / w;
    for (const e of edges) {
      // Centro del marcador, llevado al lienzo 9:16.
      const x = Math.round(content.left + (e.x + 20) * scale);
      const y = Math.round(content.top + (e.y + 20) * scale);
      const i = (y * info.width + x) * info.channels;
      const px = { r: data[i], g: data[i + 1], b: data[i + 2] };
      assert.ok(Math.abs(px.r - e.color.r) < 30 && Math.abs(px.g - e.color.g) < 30 && Math.abs(px.b - e.color.b) < 30, `${w}x${h}: marcador ${JSON.stringify(e.color)} conservado, visto ${JSON.stringify(px)}`);
    }
  }
  // Control: el recorte anterior («cover» centrado) perdía los bordes laterales de una ilustración 2:3.
  const portrait = await sharp({ create: { width: 1024, height: 1536, channels: 3, background: { r: 128, g: 128, b: 128 } } })
    .composite([marker(BLUE, 0, 748)])
    .png()
    .toBuffer();
  const cropped = await sharp(portrait).resize(1080, 1920, { fit: "cover", position: "centre" }).raw().toBuffer({ resolveWithObject: true });
  const blueSurvived = (() => {
    for (let x = 0; x < cropped.info.width; x++) {
      const i = (960 * cropped.info.width + x) * cropped.info.channels;
      if (cropped.data[i + 2] > 200 && cropped.data[i] < 60) return true;
    }
    return false;
  })();
  assert.equal(blueSurvived, false, "el recorte destructivo eliminaba el marcador del borde izquierdo");
});

test("clip: recuperación explícita de una operación fallida (presupuesto primero, gasto conservado); una operación reanudable no se «recupera»", async () => {
  const s = memoryStorage();
  await withBaseImage(s);
  const veo = fakeVeo(["moderation_after_accept", "ok"]);
  await assert.rejects(resolveClip(s, veo.provider, await openStorageLedger(s.client, "videos", "req", { capUsd: 5 })));
  const key = animationLedgerKey("req", `scene-0-anim-${spec.key}`);
  const tight = await openStorageLedger(s.client, "videos", "req", { capUsd: 1 });
  await assert.rejects(recoverPaidOperation({ supabase: s.client, bucket: "videos", ledger: tight, key, note: "revisado" }), PaidBudgetExceededError);
  const operator = await openStorageLedger(s.client, "videos", "req", { capUsd: 5 });
  const r = await recoverPaidOperation({ supabase: s.client, bucket: "videos", ledger: operator, key, note: "revisado en la consola" });
  assert.equal(r.released?.previousStatus, "failed_operation");
  const retry = await openStorageLedger(s.client, "videos", "req", { capUsd: 5 });
  assert.equal((await resolveClip(s, veo.provider, retry)).status, "generated");
  assert.equal(retry.summary().committedUsd, 1.92, "ambos intentos contabilizados");

  const s2 = memoryStorage();
  await withBaseImage(s2);
  await assert.rejects(resolveClip(s2, fakeVeo(["timeout_after_accept"]).provider, await openStorageLedger(s2.client, "videos", "req", { capUsd: 5 })));
  await assert.rejects(
    recoverPaidOperation({ supabase: s2.client, bucket: "videos", ledger: await openStorageLedger(s2.client, "videos", "req", { capUsd: 5 }), key, note: "x" }),
    RecoveryRefusedError,
  );
});

test("clip con el adaptador real de Veo (fetch simulado): la imagen de entrada llega como bytes base64 a predictLongRunning", async () => {
  const { veoVideoProvider } = await import("@/lib/providers/video-gen/veo");
  const s = memoryStorage();
  const png = await withBaseImage(s);
  const input = await prepareAnimationInputImage({ supabase: s.client, bucket: "videos", requestId: "req", baseImagePath: spec.referenceImagePath, objectPrefix: `scene-0-anim-${spec.key}`, signedUrlTtlSeconds: 60 });
  const inputBytes = s.files.get(`req/anim-input/scene-0-anim-${spec.key}.png`)!;
  assert.notDeepEqual(inputBytes, png, "se envía la versión encuadrada en 9:16");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.VEO_API_KEY;
  process.env.VEO_API_KEY = "prueba-sin-red";
  process.env.VEO_POLL_TIMEOUT_MS = "5000";
  const bodies: unknown[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://signed.example/")) return new Response(new Uint8Array(inputBytes), { status: 200, headers: { "content-type": "image/png" } });
    if (u.endsWith(":predictLongRunning")) {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ name: "models/veo-3.1-fast-generate-preview/operations/abc" }), { status: 200 });
    }
    if (u.endsWith("/operations/abc")) {
      return new Response(JSON.stringify({ name: "x", done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://files.example/v.mp4" } }] } } }), { status: 200 });
    }
    if (u === "https://files.example/v.mp4") return new Response(new Uint8Array(MP4), { status: 200 });
    throw new Error(`URL inesperada ${u}`);
  }) as typeof fetch;
  try {
    const out = await resolveAnimatedClipForScene({
      supabase: s.client,
      bucket: "videos",
      requestId: "req",
      spec,
      inputImage: { url: "https://signed.example/input.png", sha256: input.sha256 },
      videoProvider: veoVideoProvider,
      maxCostUsd: animationClipCostUsd(),
      signedUrlTtlSeconds: 60,
      ledger: await openStorageLedger(s.client, "videos", "req", { capUsd: 5 }),
    });
    assert.equal(out.status, "generated");
    const body = bodies[0] as { instances: { prompt: string; image: { bytesBase64Encoded: string; mimeType: string } }[]; parameters: Record<string, unknown> };
    assert.equal(body.instances[0].image.bytesBase64Encoded, inputBytes.toString("base64"));
    assert.equal(body.instances[0].image.mimeType, "image/png");
    assert.deepEqual(body.parameters, { aspectRatio: "9:16", resolution: "1080p", durationSeconds: 8 });
    assert.equal(markerOf(s)?.operationName, "models/veo-3.1-fast-generate-preview/operations/abc");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.VEO_API_KEY;
    else process.env.VEO_API_KEY = originalKey;
    delete process.env.VEO_POLL_TIMEOUT_MS;
  }
});

// ---------- Recorrido del pipeline (sin Remotion: render espía) ----------

const FIXTURES = { SCRIPT_PROVIDER: "fixture", VOICE_PROVIDER: "fixture", FOOTAGE_PROVIDER: "fixture", IMAGE_PROVIDER: "fixture", MUSIC_PROVIDER: "fixture", OPENAI_IMAGE_GENERATION_ENABLED: "true" };

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function renderSpy() {
  const received: { scenes: Scene[] }[] = [];
  const render = async (props: { scenes: Scene[] }) => {
    received.push(props);
    const out = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "atomivid-spy-")), "reel.mp4");
    await fs.writeFile(out, MP4);
    return out;
  };
  return { render, received };
}

const directionFor = (motion?: "ai_animation") =>
  resolveDirection({ selection: { version: 1, profile: "comic", ...(motion ? { motion } : {}) }, style: "Curiosidades", topic: "El faro", scenes: SCRIPT.segments });

const ANIM_ENV = { ...FIXTURES, REEL_AI_ANIMATION_ENABLED: "true", MAX_AI_ANIMATION_COST_USD: "5", MAX_VISUAL_COST_USD: "1" };

test("pipeline: «Imágenes» no llama a la animación; el render recibe ilustraciones fijas como siempre", async () => {
  const { generateDirectedVideoFromScript } = await import("./directed-reel");
  const s = memoryStorage();
  const veo = fakeVeo(["ok"]);
  const spy = renderSpy();
  await withEnv(ANIM_ENV, () =>
    generateDirectedVideoFromScript({ supabase: s.client, requestId: "req-img", script: SCRIPT, direction: directionFor(), deps: { animationProvider: veo.provider, renderReel: spy.render as never } }),
  );
  assert.equal(veo.calls.length, 0);
  assert.ok(spy.received[0].scenes.every((sc) => sc.mediaType === "image"));
});

test("pipeline: «Animación IA» envía cada ilustración a Veo y el render recibe los clips (video, sin zoom añadido)", async () => {
  const { generateDirectedVideoFromScript } = await import("./directed-reel");
  const s = memoryStorage();
  const veo = fakeVeo(["ok"]);
  const spy = renderSpy();
  const direction = directionFor("ai_animation");
  assert.equal(direction.selection.motion, "ai_animation", "la selección persiste en la dirección que recibe el worker");
  await withEnv(ANIM_ENV, () =>
    generateDirectedVideoFromScript({ supabase: s.client, requestId: "req-anim", script: SCRIPT, direction, deps: { animationProvider: veo.provider, renderReel: spy.render as never } }),
  );
  assert.equal(veo.calls.length, SCRIPT.segments.length);
  assert.ok(veo.calls.every((c) => c.request.referenceImageUrl?.includes("/anim-input/")));
  const scenes = spy.received[0].scenes;
  assert.equal(scenes.length, SCRIPT.segments.length);
  assert.ok(scenes.every((sc) => sc.mediaType === "video" && sc.motion === "hold" && /scene-\d+-anim-/.test(sc.mediaUrl)));

  // Reintento completo: ilustraciones y clips reutilizados, cero llamadas nuevas.
  const spy2 = renderSpy();
  await withEnv(ANIM_ENV, () =>
    generateDirectedVideoFromScript({ supabase: s.client, requestId: "req-anim", artifactPrefix: "req-anim/attempt-2", script: SCRIPT, direction, deps: { animationProvider: veo.provider, renderReel: spy2.render as never } }),
  );
  assert.equal(veo.calls.length, SCRIPT.segments.length);
});

test("pipeline: si falla una animación, se detiene con motivo claro y nunca se sustituye por una imagen con zoom", async () => {
  const { generateDirectedVideoFromScript, DirectedProductionError } = await import("./directed-reel");
  const s = memoryStorage();
  const veo = fakeVeo(["moderation_after_accept"]);
  const spy = renderSpy();
  await withEnv(ANIM_ENV, async () => {
    await assert.rejects(
      generateDirectedVideoFromScript({ supabase: s.client, requestId: "req-fail", script: SCRIPT, direction: directionFor("ai_animation"), deps: { animationProvider: veo.provider, renderReel: spy.render as never } }),
      (err: unknown) => err instanceof DirectedProductionError && /No se sustituyó por una imagen fija con zoom/.test(err.message),
    );
  });
  assert.equal(spy.received.length, 0, "no se renderiza nada");
});

test("pipeline: el tope de animación bloquea ANTES de gastar (ni imágenes, ni voz, ni video)", async () => {
  const { generateDirectedVideoFromScript } = await import("./directed-reel");
  const s = memoryStorage();
  const veo = fakeVeo(["ok"]);
  const stages: string[] = [];
  await withEnv({ ...ANIM_ENV, MAX_AI_ANIMATION_COST_USD: "1" }, async () => {
    await assert.rejects(
      generateDirectedVideoFromScript({ supabase: s.client, requestId: "req-cap", script: SCRIPT, direction: directionFor("ai_animation"), onProgress: (st) => void stages.push(st), deps: { animationProvider: veo.provider } }),
      /tope de animación/,
    );
  });
  assert.deepEqual(stages, []);
  assert.equal(veo.calls.length, 0);
  assert.equal(s.uploadLog.length, 0);
});

test("pipeline: con el tope EXACTO (3 clips × US$0,96 = US$2,88) el reintento reutiliza los clips sin exigir presupuesto adicional", async () => {
  const { generateDirectedVideoFromScript } = await import("./directed-reel");
  const s = memoryStorage();
  const veo = fakeVeo(["ok"]);
  const direction = directionFor("ai_animation");
  const env = { ...ANIM_ENV, MAX_AI_ANIMATION_COST_USD: "2.88" };
  await withEnv(env, () =>
    generateDirectedVideoFromScript({ supabase: s.client, requestId: "req-exact", script: SCRIPT, direction, deps: { animationProvider: veo.provider, renderReel: renderSpy().render as never } }),
  );
  assert.equal(veo.calls.length, 3);
  const spy2 = renderSpy();
  await withEnv(env, () =>
    generateDirectedVideoFromScript({ supabase: s.client, requestId: "req-exact", artifactPrefix: "req-exact/attempt-2", script: SCRIPT, direction, deps: { animationProvider: veo.provider, renderReel: spy2.render as never } }),
  );
  assert.equal(veo.calls.length, 3, "cero llamadas nuevas");
  assert.equal(spy2.received[0].scenes.filter((sc) => sc.mediaType === "video").length, 3);
});

test("pipeline: sin acción declarada en una escena, o con una escena demasiado corta, se bloquea ANTES de cualquier gasto", async () => {
  const { generateDirectedVideoFromScript, DirectedProductionError } = await import("./directed-reel");
  const noAction = { ...SCRIPT.segments[1], visibleAction: undefined };
  const cases: { name: string; script: GeneratedScript; pattern: RegExp }[] = [
    { name: "sin acción", script: { ...SCRIPT, segments: [SCRIPT.segments[0], noAction, SCRIPT.segments[2]] }, pattern: /no declara la acción visible/ },
    { name: "demasiado corta", script: { ...SCRIPT, segments: [SCRIPT.segments[0], { ...SCRIPT.segments[1], text: "Silencio." }, SCRIPT.segments[2]] }, pattern: /demasiado corta/ },
  ];
  for (const c of cases) {
    const s = memoryStorage();
    const veo = fakeVeo(["ok"]);
    const stages: string[] = [];
    const direction = resolveDirection({ selection: { version: 1, profile: "comic", motion: "ai_animation" }, style: "Curiosidades", topic: "El faro", scenes: c.script.segments });
    await withEnv(ANIM_ENV, async () => {
      await assert.rejects(
        generateDirectedVideoFromScript({ supabase: s.client, requestId: "req-block", script: c.script, direction, onProgress: (st) => void stages.push(st), deps: { animationProvider: veo.provider } }),
        (err: unknown) => err instanceof DirectedProductionError && c.pattern.test(err.message),
        c.name,
      );
    });
    assert.deepEqual(stages, [], `${c.name}: ni imágenes ni voz`);
    assert.equal(veo.calls.length, 0, c.name);
    assert.equal(s.uploadLog.length, 0, c.name);
  }
});

test("pipeline (estructura): con los tiempos reales, todos los planes se validan antes del primer clip; lo que no cabe se bloquea sin llamar a Veo", async () => {
  const src = await fs.readFile(path.join(process.cwd(), "src/lib/video/audiovisual/directed-reel.ts"), "utf8");
  const tooShort = src.indexOf("plan.tooShort.length > 0");
  const specs = src.indexOf("specs.push(");
  const firstClip = src.indexOf("resolveAnimatedClipForScene(");
  assert.ok(tooShort > 0 && specs > tooShort && firstClip > specs, "tooShort → planes de todas las escenas → primer clip");
  assert.match(src, /visibleSeconds: shot\.endSeconds - shot\.startSeconds/);
  assert.match(src, /sceneEnergy: direction\.sceneEnergy,\n\s*\}\);\n\s*if \(plan\.tooLong/);
});
