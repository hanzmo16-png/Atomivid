/**
 * Anexo C1 (2026-10-18) — material nuevo del Director dentro del tope que el propietario aprueba por producción.
 * ROJO = main/PR148: the Reel's Director had `remainingUsd: 0` hard-coded (from-reel.ts), so any shot without material
 * blocked the video (case f404ec4f: USD 0.04 > 0) — even when the owner was ready to pay a few cents for quality.
 * VERDE = only the owner can approve a ceiling; the worker generates exactly the missing shots (one gated call each,
 * counted here), re-plans once, and stops BEFORE any paid call when the ceiling is not enough, with the delta.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { directReel, type ResolvedBeat } from "@/lib/video/director/reel-render";
import { approvedDirectorMaterialUsd, DirectorMaterialBudgetError, fillBeats, fillDirectorMaterial, fillPlan, MAX_DIRECTOR_MATERIAL_USD, productionProfile } from "@/lib/video/director/material-fill";
import { jobSupplyDemands } from "./job";
import { directorImageUnitCostUsd, imageVariant, openaiImageEstimatedCostUsd } from "@/lib/video/image-pricing";
import { fillObjectKey } from "@/lib/video/director/material-fill";
import { resolveGeneratedImageForScene } from "@/lib/video/visual-resource-resolver";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import type { ImageProvider } from "@/lib/providers/image";
import type { StoryboardScene } from "@/lib/video/storyboard/types";

const UNIT = directorImageUnitCostUsd();
import { getFeatureFlags, type FeatureFlags } from "@/lib/video/feature-flags";

const ROOT = path.resolve(__dirname, "../../..");
const src = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

// A 26 s Reel with ONE resolved image per scene, the material the pipeline really produces: the Director plans more
// cuts than images for every scene longer than its 6 s shot cap (the f404ec4f pattern).
const SEGMENTS = ["¿Tienes buenas ideas, pero grabar y editar un video te toma toda la tarde?",
  "Empieza por lo más simple: escribe tu idea en una sola frase clara, como si se la contaras a un amigo.",
  "Un buen video corto tiene un solo mensaje. Si intentas decir cinco cosas, nadie recuerda ninguna.",
  "La constancia vale más que la perfección. Publica, mira qué funciona y vuelve a empezar mañana."];
const SCRIPT = { title: "t", segments: SEGMENTS.map((text, i) => ({ text, visualQuery: ["tired creator laptop", "hands writing notebook", "person thinking window", "person smiling at camera"][i] })) };
let clock = 0;
const TIMINGS = SEGMENTS.map(s => { const d = s.split(" ").length / 2.6; const r = { start: clock, end: clock + d }; clock += d; return r; });
const CAPTIONS = SEGMENTS.map((s, i) => ({ text: s, startSeconds: TIMINGS[i].start, endSeconds: TIMINGS[i].end }));
const BEATS: ResolvedBeat[][] = TIMINGS.map((t, i) => [{ url: `https://fixture.local/s${i}`, mediaType: "image", source: "stock", license: "CLEARED", start: t.start, end: t.end }]);
const direct = (beatsBySegment: ResolvedBeat[][]) => directReel({ script: SCRIPT, beatsBySegment, sceneTimings: TIMINGS, audioUrl: "https://fixture.local/a.mp3", captions: CAPTIONS, narrationGaps: [], durationSeconds: clock + 0.4 });

test("perfil del servidor: solo el propietario aprueba material nuevo; el cliente comercial no puede escalar su tope", () => {
  assert.equal(productionProfile(true), "owner_test");
  assert.equal(productionProfile(false), "commercial");
  assert.deepEqual(approvedDirectorMaterialUsd("commercial", undefined), { ok: true, usd: 0 });
  assert.deepEqual(approvedDirectorMaterialUsd("commercial", 0), { ok: true, usd: 0 });
  assert.equal(approvedDirectorMaterialUsd("commercial", 0.5).ok, false, "a customer cannot raise the cap from the browser");
  assert.deepEqual(approvedDirectorMaterialUsd("owner_test", "0.129"), { ok: true, usd: 0.12 }, "rounded DOWN to cents: never more than approved");
  assert.equal(approvedDirectorMaterialUsd("owner_test", MAX_DIRECTOR_MATERIAL_USD + 0.01).ok, false, "hard last line of defence");
  for (const bad of [-1, "abc", Number.NaN, Infinity]) assert.equal(approvedDirectorMaterialUsd("owner_test", bad).ok, false, `${String(bad)} is not «unlimited» nor 0`);
  const route = src("src/app/api/generate/[id]/render/route.ts");
  assert.match(route, /approvedDirectorMaterialUsd\(productionProfile\(isInternalProductionOwner\(user\)\), materialRequest\)/, "profile from the verified user");
  assert.match(route, /directorRenderAllowed\(user, videoRequest\) \? material\.usd : 0/, "only when the Director really mounts this Reel");
});

test("ROJO/VERDE f404ec4f: con una imagen por escena el Director pide planos nuevos; con material generado para ESOS planos, monta", () => {
  const before = direct(BEATS);
  assert.equal(before.ok, false);
  const codes = !before.ok ? [...new Set(before.blockers.map(b => b.code))].sort() : [];
  assert.deepEqual(codes, ["AUDIT_BUDGET_EXCEEDED", "MATERIAL_NOT_AUTHORISED", "TIMELINE_GAP"], "ROJO: the only reason is missing material under a zero budget");
  const plan = fillPlan(before);
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.equal(plan.shots.length, 3);
  assert.equal(plan.totalUsd, Math.round(3 * UNIT * 10000) / 10000, "3 images × the Director's unit cost, not the ceiling");
  const filled = fillBeats(BEATS, TIMINGS, before.input!.segments.map(s => s.id), plan.shots.map(shot => ({ shot, url: `https://fixture.local/gen-${shot.shotId}` })));
  const after = direct(filled);
  assert.ok(after.ok, after.ok ? "" : JSON.stringify(after.blockers.map(b => b.code)));
  if (!after.ok) return;
  for (const s of plan.shots) assert.ok(after.props.scenes.some(sc => sc.mediaUrl.endsWith(`gen-${s.shotId}`)), `${s.shotId} uses its generated image`);
  const ai = after.applied.filter(a => plan.shots.some(s => s.shotId === a.shotId));
  assert.ok(ai.length === 3 && ai.every(a => a.applied.label === "recreacion_ia"), "every new image is labelled «Recreación IA» (no invented evidence)");
  assert.ok(after.applied.filter(a => !plan.shots.some(s => s.shotId === a.shotId)).every(a => a.applied.label === "ilustrativa"), "existing stock keeps its own label");
});

test("contadores: tope suficiente → exactamente una llamada por plano y un solo re-plan; gasta lo necesario, no el tope", async () => {
  let calls = 0; const maxPerCall: number[] = [];
  const out = await fillDirectorMaterial({ directed: direct(BEATS), approvedUsd: 2, beatsBySegment: BEATS, sceneTimings: TIMINGS,
    generate: async (shot, _i, maxUsd) => { calls++; maxPerCall.push(maxUsd); return { url: `https://fixture.local/gen-${shot.shotId}`, costUsd: 0.05 }; } });
  assert.ok(!("skipped" in out));
  if ("skipped" in out) return;
  assert.equal(calls, 3);
  assert.deepEqual(maxPerCall, [UNIT, UNIT, UNIT], "each call is capped at ITS unit cost, never at the whole ceiling");
  assert.equal(out.spentUsd, 0.15, "a USD 2 ceiling spends what the 3 images really cost: the ceiling is not a target");
  assert.ok(direct(out.beatsBySegment).ok);
});

test("ROJO/VERDE: tope insuficiente → se detiene ANTES de cualquier llamada de pago, con el faltante; la voz se conserva", async () => {
  let calls = 0;
  const run = (approvedUsd: number, spentUsd = 0) => fillDirectorMaterial({ directed: direct(BEATS), approvedUsd, spentUsd, beatsBySegment: BEATS, sceneTimings: TIMINGS,
    generate: async () => { calls++; return { url: "x", costUsd: 0.04 }; } });
  const need = Math.round(3 * UNIT * 10000) / 10000;
  const short = Math.round((need - 0.02) * 100) / 100;
  await assert.rejects(run(short), (e: unknown) => e instanceof DirectorMaterialBudgetError && e.neededUsd === need && e.approvedRemainingUsd === short
    && /antes de cualquier llamada de pago nueva/.test(e.customerMessage) && /la voz y el material ya obtenidos se conservan/.test(e.customerMessage)
    && /al menos USD 0\.02 más/.test(e.customerMessage));
  // What was already spent in this production counts against the ceiling.
  await assert.rejects(run(need, 0.05), (e: unknown) => e instanceof DirectorMaterialBudgetError && Math.abs(e.approvedRemainingUsd - (need - 0.05)) < 1e-9);
  assert.equal(calls, 0, "zero paid calls in both refusals");
  assert.doesNotMatch(new DirectorMaterialBudgetError(0.12, 0.1).customerMessage, /no se cobró nada|ningún cargo/i, "the voice was paid: never claim zero charge");
});

test("un bloqueo que no es falta de material (licencia, política, tiempos) nunca gasta", async () => {
  const pending = BEATS.map(b => b.map(x => ({ ...x, license: "NEEDS_REVIEW" as const })));
  const r = direct(pending);
  assert.equal(r.ok, false);
  const plan = fillPlan(r);
  assert.equal(plan.ok, false);
  let calls = 0;
  const out = await fillDirectorMaterial({ directed: r, approvedUsd: 2, beatsBySegment: pending, sceneTimings: TIMINGS, generate: async () => { calls++; return { url: "x", costUsd: 0.04 }; } });
  assert.ok("skipped" in out && /no resuelve/.test(out.skipped));
  assert.equal(calls, 0);
  assert.equal(fillPlan(direct(BEATS.map(() => []))).ok, false, "no material at all is not a «fill a few shots» case");
});

test("reserva: el tope aprobado se suma al sobre del proveedor de imagen; recalcular sin él pide menos (la reserva lo acepta)", () => {
  const flags: FeatureFlags = { ...getFeatureFlags(), imageGenerationEnabled: false, visualDirectorEnabled: false, musicProvider: "curated-library", imageProvider: "openai" } as FeatureFlags;
  const row = { mode: "visual", script_json: SCRIPT, recorded_audio_path: null, long_form_production_plan: null };
  const without = jobSupplyDemands(row, "elevenlabs", flags);
  const withFill = jobSupplyDemands(row, "elevenlabs", flags, { directorMaterialUsd: 0.5 });
  assert.equal(without.find(d => d.provider === "openai"), undefined, "no image envelope when nothing generates images");
  assert.equal(withFill.find(d => d.provider === "openai")?.usd, 0.5);
  // pi_reserve_job_supply only refuses a LARGER envelope than the one reserved: the worker/resume recomputing
  // without the fill asks for less and is accepted.
  assert.match(src("supabase/migrations/20261005150229_provider_supply_job_reservations.sql"), /r\.reserved_units<units or r\.reserved_usd<usd/);
});

test("el worker solo usa el tope que el servidor reservó en el sobre de ESTE intento; nada viaja en el despacho", () => {
  const job = src("src/lib/video/run-job.ts");
  assert.match(job, /if \(!supplyGuardRequired\(\)\) return 0;/, "no guard = no new material");
  assert.match(job, /if \(error \|\| !data \|\| data\.status !== "OPEN"\) return 0;/, "unreadable or closed = 0, never unlimited");
  assert.match(job, /const approved = reserved - \(flags\.imageGenerationEnabled \? flags\.maxVisualCostUsd : 0\);\n\s+return Math\.max\(0, Math\.min\(approved, reserved - consumed, MAX_DIRECTOR_MATERIAL_USD\)\);/,
    "only the surplus the owner approved, bounded by what is still free and by the hard cap");
  assert.match(job, /const ownerTest = directorRender && requestOwner !== null && isInternalProductionOwner\(requestOwner\);/, "owner only, decided from the row's account");
  assert.match(job, /\.\.\.\(ownerTest \? \{ directorMaterialBudgetUsd: \(\) => directorMaterialBudgetUsd\(service, requestId, row\.render_attempts\) \} : \{\}\)/);
  assert.doesNotMatch(src("src/lib/worker/github-actions.ts"), /director|material/i, "the dispatch payload carries nothing about it");
  assert.match(src("src/app/api/generate/[id]/render/route.ts"), /await worker\.trigger\(\{ requestId: id, renderAttempt: videoRequest\.render_attempts \+ 1, mode: videoRequest\.mode \}\);/);
  const gv = src("src/lib/video/generate-video.ts");
  assert.match(gv, /objectKey: fillObjectKey\(/, "own ledger row and object per shot and content: reused on retry, never paid twice");
  assert.match(src("src/lib/video/visual-resource-resolver.ts"), /shotId: `image:\$\{objectKey \?\? `scene-\$\{sceneIndex\}`\}`/);
  // The Reel's image key is switched on by an OWNER repository variable, never by the payload.
  const yml = src(".github/workflows/render.yml");
  assert.doesNotMatch(yml, /client_payload\.(director|material)/i);
  assert.match(yml, /OPENAI_API_KEY: \$\{\{ \(\(github\.event\.client_payload\.mode == 'long_form' \|\| inputs\.mode == 'long_form'\) \|\| vars\.DIRECTOR_MATERIAL_ENABLED == 'true'\) && secrets\.OPENAI_API_KEY \|\| '' \}\}/);
  // A ceiling that cannot be reserved in a real image provider is refused at start, not silently dropped.
  assert.match(src("src/app/api/generate/[id]/render/route.ts"), /directorMaterialUsd > 0 && \["fixture", "curated-library"\]\.includes\(getFeatureFlags\(\)\.imageProvider\)/);
});

test("interfaz del propietario: distingue costo previsto, tope aprobado y cuota comercial; el cliente no ve el campo", () => {
  const ui = src("src/app/dashboard/review/[id]/ScriptReview.tsx");
  assert.match(ui, /Tope aprobado para material nuevo del Director en este video/);
  assert.match(ui, /Costo previsto \(simulación, antes de la voz\)/);
  assert.match(ui, /Es un tope, no un objetivo/);
  assert.match(ui, /no es la cuota de un plan comercial/);
  assert.match(src("src/app/dashboard/review/[id]/page.tsx"), /directorMaterialOffer=\{isInternalProductionOwner\(user\) && data\.mode === "visual"/);
});

// ---------------------------------------------------------------- Corrección 2

test("C2 P0 ROJO/VERDE con OpenAI simulado (sin red): el antiguo 0.04 era rechazado antes de llamar; el costo unitario del Director pasa", async () => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-not-real";
  const { openaiImageProvider } = await import("@/lib/providers/image/openai");
  const realFetch = globalThis.fetch;
  let calls = 0;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)]);
  globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }],
    usage: { input_tokens: 60, output_tokens: 1300, input_tokens_details: { text_tokens: 60, image_tokens: 0 } } }), { status: 200, headers: { "Content-Type": "application/json" } }); }) as typeof fetch;
  try {
    const req = (maxCostUsd: number) => ({ prompt: "a cinematic photo", aspectRatio: "9:16" as const, maxCostUsd, disableRetries: true });
    await assert.rejects(openaiImageProvider.generateImage(req(0.04)), (e: unknown) => (e as { reason?: string }).reason === "budget_exceeded", "ROJO: the fixed 0.04 is below the provider's own estimate");
    assert.equal(calls, 0, "refused before any HTTP call");
    assert.equal(openaiImageEstimatedCostUsd(), 0.05);
    assert.equal(UNIT, 0.07, "estimate 0.05 × margin 1.25, rounded up to cents");
    const asset = await openaiImageProvider.generateImage(req(UNIT));
    assert.equal(calls, 1, "VERDE: exactly one call");
    // The final cost comes from the reported tokens and can differ from the static estimate: the provider has no
    // exact ceiling, which is why the Director plans with a margin and the ledger records the real cost.
    assert.ok(asset.costUsd > 0 && asset.costUsd !== openaiImageEstimatedCostUsd(), `real cost from tokens: ${asset.costUsd}`);
  } finally { globalThis.fetch = realFetch; }
  // One source: the unit cost follows the provider's estimate.
  assert.equal(directorImageUnitCostUsd({ OPENAI_IMAGE_ESTIMATED_COST_USD: "0.08" }), 0.1);
  assert.match(src("src/lib/providers/image/openai.ts"), /export const ESTIMATED_COST_USD = openaiImageEstimatedCostUsd\(\);/);
  assert.match(src("src/lib/video/director/from-reel.ts"), /ai_image: directorImageUnitCostUsd\(\)/);
});

function scene(over: Partial<StoryboardScene> = {}): StoryboardScene {
  return { id: "scene-0", order: 0, narrationText: "x", estimatedDurationSeconds: 3, literalMeaning: "x", emotionalSubtext: "x", narrativeGoal: "x", dominantEmotion: "x",
    energy: "low", subject: "x", visibleAction: "x", environment: "x", timeOfDay: "x", shotType: "x", cameraMovement: "x", lighting: "x", colorPalette: "x", visualStyle: "x",
    imagePrompt: "a cinematic photo", negativePrompt: "text", stockQueries: ["a", "b"], resourceType: "generated_image", priority: 1, confidence: 0.8, selectionRationale: "x",
    continuityWithPrevious: "none", continuityWithNext: "none", maxCostUsd: 0.1, fallbackStrategy: ["retry_prompt"], ...over } as StoryboardScene;
}
function storage(existing: string[] = []) {
  const files = new Set(existing), uploads: string[] = [];
  const supabase = { storage: { from() { return {
    async list(dir: string, o?: { search?: string }) { return { data: [...files].filter(f => f.startsWith(`${dir}/`)).map(f => ({ name: f.slice(dir.length + 1) })).filter(f => !o?.search || f.name.startsWith(o.search)), error: null }; },
    async upload(p: string) { uploads.push(p); files.add(p); return { error: null }; },
    async createSignedUrl(p: string) { return { data: { signedUrl: `https://signed.test/${p}` }, error: null }; },
  }; } } } as never;
  return { supabase, uploads, files };
}
function provider(behaviour: "ok" | "throw" = "ok") {
  let calls = 0;
  const p: ImageProvider = { name: "openai", capabilities: { id: "openai", models: ["m"], formats: ["image/png"], aspectRatios: ["9:16"], timeoutMs: 0, maxRetries: 0 }, isAvailable: () => true,
    async generateImage() { calls++; if (behaviour === "throw") throw new Error("socket hang up after send");
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x48, 0x44, 0x52]), Buffer.from([0, 0, 4, 0, 0, 0, 6, 0]), Buffer.alloc(200, 0x20)]);
      return { buffer: png, mimeType: "image/png", extension: "png", width: 1024, height: 1536, model: "m", costUsd: 0.05 }; } };
  return { p, calls: () => calls };
}

test("C2 P1 ROJO/VERDE: la clave del relleno sigue al contenido; un texto o modelo cambiado nunca hereda una imagen vieja", async () => {
  const shot = { shotId: "scene-3-s2", segmentId: "scene-3", kind: "ai_image" as const, estimatedMaxUsd: UNIT, start: 0, end: 2, reason: "", anchorText: "Publica y vuelve a empezar.", visualTheme: "persona publicando" };
  const k1 = fillObjectKey(shot, "prompt A", "text", imageVariant("openai", {}));
  assert.equal(fillObjectKey(shot, "prompt A", "text", imageVariant("openai", {})), k1, "same content → same key (idempotent)");
  assert.notEqual(fillObjectKey(shot, "prompt B", "text", imageVariant("openai", {})), k1, "changed prompt");
  assert.notEqual(fillObjectKey({ ...shot, anchorText: "Otra frase distinta." }, "prompt A", "text", imageVariant("openai", {})), k1, "changed sentence");
  assert.notEqual(fillObjectKey(shot, "prompt A", "text", imageVariant("openai", { OPENAI_IMAGE_MODEL: "otro-modelo" })), k1, "changed model");
  // ROJO (7ba9e27): the key was only the shot id, so a stored image for the old sentence was reused at zero cost.
  const old = `req/director-fill-scene-3-s2.png`;
  const { supabase, uploads } = storage([old]);
  const gen = provider();
  const changed = fillObjectKey({ ...shot, anchorText: "Otra frase distinta." }, "prompt B", "text", imageVariant("openai", {}));
  const r = await resolveGeneratedImageForScene({ supabase, bucket: "videos", requestId: "req", sceneIndex: 3, scene: scene({ imagePrompt: "prompt B" }), imageProvider: gen.p,
    remainingBudgetUsd: UNIT, signedUrlTtlSeconds: 60, ledger: memoryLedgerStore(), objectKey: changed });
  assert.equal(r.status, "generated", "VERDE: new content generates new material");
  assert.equal(gen.calls(), 1);
  assert.deepEqual(uploads, [`req/${changed}.png`]);
  // Same content again (retry): reused, no call.
  const again = await resolveGeneratedImageForScene({ supabase, bucket: "videos", requestId: "req", sceneIndex: 3, scene: scene({ imagePrompt: "prompt B" }), imageProvider: gen.p,
    remainingBudgetUsd: UNIT, signedUrlTtlSeconds: 60, ledger: memoryLedgerStore(), objectKey: changed });
  assert.equal(again.status, "reused");
  assert.equal(gen.calls(), 1, "never paid twice");
  assert.match(src("src/lib/video/generate-video.ts"), /objectKey: fillObjectKey\(shot, prompt, base\.negativePrompt, imageVariant\(fillProvider\.name\)\)/);
});

test("C2: una llamada de imagen con resultado incierto no se repite a ciegas en el reintento", async () => {
  const ledger = memoryLedgerStore();
  const { supabase } = storage();
  const bad = provider("throw");
  const args = { supabase, bucket: "videos", requestId: "req-u", sceneIndex: 1, scene: scene(), remainingBudgetUsd: UNIT, signedUrlTtlSeconds: 60, ledger, objectKey: "director-fill-x-abc" };
  await assert.rejects(resolveGeneratedImageForScene({ ...args, imageProvider: bad.p }));
  const good = provider();
  await assert.rejects(resolveGeneratedImageForScene({ ...args, imageProvider: good.p }), "the second attempt refuses: the first outcome is unknown");
  assert.equal(good.calls(), 0, "no blind regeneration while the first call is unreconciled");
});

test("D-RETRY-CEILING (T-20261019-1602): reintento con TODO el material ya guardado y tope 0 → completa sin gasto, cada llamada con USD 0 de margen", async () => {
  const maxPerCall: number[] = [];
  const out = await fillDirectorMaterial({ directed: direct(BEATS), approvedUsd: 0, beatsBySegment: BEATS, sceneTimings: TIMINGS,
    isStored: async () => true,
    generate: async (shot, _i, maxUsd) => { maxPerCall.push(maxUsd); return { url: `https://fixture.local/stored-${shot.shotId}`, costUsd: 0 }; } });
  assert.ok(!("skipped" in out));
  if ("skipped" in out) return;
  assert.equal(out.spentUsd, 0);
  assert.deepEqual(maxPerCall, [0, 0, 0], "material guardado: margen 0, imposible gastar fuera del tope");
  assert.equal(out.reusedShots.length, 3);
});

test("D-RETRY-CEILING: sólo el material NUEVO cuenta contra el tope; con tope 0 y 1 plano nuevo se detiene ANTES de llamar con el faltante exacto", async () => {
  let calls: number = 0; let n = 0;
  const run = (approvedUsd: number) => fillDirectorMaterial({ directed: direct(BEATS), approvedUsd, beatsBySegment: BEATS, sceneTimings: TIMINGS,
    isStored: async () => n++ % 3 !== 2, // 2 guardados, 1 nuevo
    generate: async (_s, _i, maxUsd) => { calls++; return { url: "x", costUsd: maxUsd > 0 ? 0.05 : 0 }; } });
  await assert.rejects(run(0), (e: unknown) => e instanceof DirectorMaterialBudgetError && Math.abs(e.neededUsd - UNIT) < 1e-9 && e.approvedRemainingUsd === 0);
  assert.equal(calls, 0, "0 llamadas: el tope nunca se expande por una estimación nueva");
  n = 0;
  const ok = await run(UNIT);
  assert.ok(!("skipped" in ok) && ok.spentUsd === 0.05);
  assert.equal(calls as number, 3);
});

test("D-RETRY-CEILING: un plano «guardado» que intenta cobrar se detiene (nunca se paga dos veces en silencio)", async () => {
  await assert.rejects(fillDirectorMaterial({ directed: direct(BEATS), approvedUsd: 0, beatsBySegment: BEATS, sceneTimings: TIMINGS,
    isStored: async () => true, generate: async () => ({ url: "x", costUsd: 0.04 }) }), /cobro inesperado/);
});
