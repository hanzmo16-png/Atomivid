/**
 * «Imágenes IA con FLUX» (second selectable provider) — Reel side, selection, access, supply and QC. USD 0: provider,
 * Storage and ledger are in memory; no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fluxAllowedFor, fluxAllowedForWorker, fluxReelDemandUsd, parseImageSource, FluxAccessError, FLUX_USD_PER_IMAGE } from "./flux-images";
import { jobSupplyDemands } from "@/lib/supply/job";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { resolveFluxReelScene, GeneratedImageRejectedError } from "@/lib/video/visual-resource-resolver";
import { checkGeneratedImage } from "@/lib/video/long-form/generated-image-qc";
import { FLUX_SIZES } from "@/lib/providers/image/flux";
import { imageUnitUsd, LONG_FORM_IMAGE_PROVIDERS } from "@/lib/video/long-form/production-plan";
import type { ImageProvider } from "@/lib/providers/image";
import type { StoryboardScene } from "@/lib/video/storyboard/types";
import { parseBalance } from "../../../scripts/supply/observe.mjs";

const OWNER = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.test", email_confirmed_at: "2026-01-01T00:00:00Z" };
const OTHER = { id: "22222222-2222-4222-8222-222222222222", email: "other@example.test", email_confirmed_at: "2026-01-01T00:00:00Z" };

test("fuente de imágenes: default/recraft/flux aceptadas; desconocida rechazada (nunca 'default' en silencio)", () => {
  assert.equal(parseImageSource("flux"), "flux");
  assert.equal(parseImageSource(" recraft "), "recraft");
  assert.equal(parseImageSource(undefined), "default");
  assert.deepEqual(parseImageSource("openai"), { error: "Fuente de imágenes no válida." });
});

test("acceso: FLUX solo para la cuenta dueña salvo FLUX_IMAGES_ENABLED=true; nunca desde el navegador", async () => {
  const env = { INTERNAL_PRODUCTION_OWNER_USER_ID: OWNER.id };
  assert.equal(fluxAllowedFor(OWNER as never, env), true);
  assert.equal(fluxAllowedFor(OTHER as never, env), false);
  assert.equal(fluxAllowedFor(OTHER as never, { ...env, FLUX_IMAGES_ENABLED: "true" }), true);
  // RECRAFT_REEL_ENABLED does NOT open FLUX (independent switches).
  assert.equal(fluxAllowedFor(OTHER as never, { ...env, RECRAFT_REEL_ENABLED: "true" }), false);
  // Worker: an owner id configured but different → refused without asking the app.
  let asked = 0;
  assert.equal(await fluxAllowedForWorker(OTHER as never, { RECRAFT_PILOT_OWNER_USER_ID: OWNER.id }, async () => { asked++; return true; }), false);
  assert.equal(asked, 0);
  // Worker without an owner id: asks the app (yes/no), failures refuse.
  assert.equal(await fluxAllowedForWorker(OWNER as never, {}, async () => true), true);
  assert.equal(await fluxAllowedForWorker(OWNER as never, {}, async () => { throw new Error("down"); }), false);
  assert.match(new FluxAccessError().customerMessage, /No se inició la producción ni se cobró nada/);
});

test("presupuesto Reel: USD 0,025 por escena + reserva de regeneración; 0 escenas = 0", () => {
  assert.equal(FLUX_USD_PER_IMAGE, 0.025);
  assert.equal(fluxReelDemandUsd({ segments: Array.from({ length: 6 }, () => ({ text: "x" })) }), 0.175); // 6 + 1 reserve
  assert.equal(fluxReelDemandUsd({ segments: Array.from({ length: 12 }, () => ({ text: "x" })) }), 0.35); // 12 + 2
  assert.equal(fluxReelDemandUsd({ segments: [] }), 0);
  assert.equal(fluxReelDemandUsd(null), 0);
});

test("supply Reel: el sobre FLUX va al proveedor «flux»; Recraft no cambia", () => {
  const row = { mode: "visual", script_json: { segments: [{ text: "hola mundo" }] }, recorded_audio_path: null, long_form_production_plan: null };
  const flags = { ...getFeatureFlags(), imageGenerationEnabled: false, visualDirectorEnabled: false, musicProvider: "fixture" } as ReturnType<typeof getFeatureFlags>;
  const flux = jobSupplyDemands(row, "fixture", flags, { fluxUsd: 0.05 });
  assert.deepEqual(flux.map((d) => [d.provider, d.usd]), [["flux", 0.05]]);
  const recraft = jobSupplyDemands(row, "fixture", flags, { recraftUsd: 0.075 });
  assert.deepEqual(recraft.map((d) => [d.provider, d.usd]), [["recraft", 0.075]]);
});

test("Long Form: 'flux' es un proveedor de plan válido con precio USD 0,025; Recraft y OpenAI conservan su precio", () => {
  assert.ok((LONG_FORM_IMAGE_PROVIDERS as readonly string[]).includes("flux"));
  assert.equal(imageUnitUsd("flux"), 0.025);
  assert.equal(imageUnitUsd("recraft"), 0.04);
  assert.notEqual(imageUnitUsd("openai"), 0.025);
});

test("tamaños FLUX pasan el control automático (encuadre exacto y lado corto ≥ 700 px) en 9:16 y 16:9", async () => {
  const stats = async () => ({ stdev: [40, 40, 40] });
  const v = await checkGeneratedImage({ buffer: Buffer.alloc(1), ...FLUX_SIZES["9:16"] }, "9:16", { stats });
  const h = await checkGeneratedImage({ buffer: Buffer.alloc(1), ...FLUX_SIZES["16:9"] }, "16:9", { stats });
  assert.equal(v.passed, true, JSON.stringify(v.checks));
  assert.equal(h.passed, true, JSON.stringify(h.checks));
  // The enum size "portrait_16_9" (576×1024) would FAIL this check: that is why exact sizes are sent.
  const enumSize = await checkGeneratedImage({ buffer: Buffer.alloc(1), width: 576, height: 1024 }, "9:16", { stats });
  assert.equal(enumSize.passed, false);
});

// ---- Reel scene with the real resolver: QC rejection → ONE regeneration under its own key; a second → stop ----
function jpeg(w: number, h: number, seed: number): Buffer {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19); sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8; sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7); sof[9] = 3;
  return Buffer.concat([head, sof, Buffer.alloc(4096, seed), Buffer.from([0xff, 0xd9])]);
}
function reelHarness(stdevs: number[]) {
  const objects = new Map<string, Buffer>();
  const ledger = memoryLedgerStore();
  let submits = 0;
  const provider = {
    name: "flux",
    capabilities: { id: "flux", models: ["fal-ai/flux/dev"], formats: [], aspectRatios: [], timeoutMs: 1, maxRetries: 0 },
    isAvailable: () => true,
    estimateCostUsd: () => 0.025,
    submitImage: async () => ({ providerJobId: `flux-job-${++submits}` }),
    resumeImage: async (id: string) => ({ buffer: jpeg(720, 1280, Number(id.split("-").pop())), mimeType: "image/jpeg", extension: "jpg", width: 720, height: 1280,
      model: "fal-ai/flux/dev", costUsd: 0.025, costBasis: "estimated", providerJobId: id }),
    generateImage: async () => { throw new Error("unexpected sync path"); },
  } as unknown as ImageProvider;
  const api = {
    list: async (dir: string, { search }: { search: string }) => ({ data: [...objects.keys()].filter((p) => p.startsWith(dir + "/")).map((p) => ({ name: p.slice(dir.length + 1) })).filter((f) => f.name.startsWith(search)), error: null }),
    upload: async (p: string, b: Buffer) => { objects.set(p, b); return { error: null }; },
    createSignedUrl: async (p: string) => ({ data: { signedUrl: `https://example.test/${p}` }, error: null }),
  };
  let call = 0;
  const run = () => resolveFluxReelScene({ ledger, supabase: { storage: { from: () => api } } as never, bucket: "videos", requestId: "reel-flux", sceneIndex: 0,
    scene: { imagePrompt: "fortress at night", negativePrompt: "text" } as StoryboardScene, imageProvider: provider, remainingBudgetUsd: 0.025, signedUrlTtlSeconds: 60,
    qc: (a) => checkGeneratedImage(a, "9:16", { stats: async () => ({ stdev: [stdevs[Math.min(call++, stdevs.length - 1)], 0, 0] }) }) });
  return { run, objects, ledger, get submits() { return submits; } };
}

test("Reel FLUX: imagen aceptada → guardada como scene-N-flux, una fila COMMITTED de USD 0,025", async () => {
  const h = reelHarness([40]);
  const out = await h.run();
  assert.equal(out.status, "generated");
  assert.equal(out.path, "reel-flux/scene-0-flux.jpg");
  const rows = [...h.ledger.ops.values()];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, "flux");
  assert.equal(rows[0].committedUsd, 0.025);
  // A retry reuses it: no new submission.
  assert.equal((await h.run()).status, "reused");
  assert.equal(h.submits, 1);
});

test("Reel FLUX: rechazada por el control → UNA regeneración (otra clave); la segunda se detiene sin sustituto", async () => {
  const ok = reelHarness([0, 40]);
  const out = await ok.run();
  assert.equal(out.path, "reel-flux/scene-0-flux-r1.jpg");
  assert.equal(ok.submits, 2);
  assert.ok([...ok.objects.keys()].some((k) => k.startsWith("reel-flux/qc-rejected/scene-0-flux.")));
  const bad = reelHarness([0, 0]);
  await assert.rejects(bad.run(), GeneratedImageRejectedError);
  assert.equal(bad.submits, 2, "never a third image");
  // The retry of a twice-rejected scene stops immediately (durable markers), paying nothing.
  await assert.rejects(bad.run(), GeneratedImageRejectedError);
  assert.equal(bad.submits, 2);
});

test("observador de saldo: FLUX lee el mismo saldo de fal que Recraft (solo USD)", () => {
  assert.deepEqual(parseBalance("flux", { credits: { current_balance: 9.5, currency: "USD" } }), { available: 9.5, unit: "usd", baseline: null, renewal_date: null, details: {} });
  assert.equal(parseBalance("flux", { credits: { current_balance: 9.5, currency: "EUR" } }), null);
});

test("cableado (fuente): selector, servidor del Reel, clave de intención, worker y confirmación de Long Form", () => {
  const read = (p: string) => fs.readFileSync(p, "utf8");
  const picker = read("src/app/dashboard/new/ReelImageSourcePicker.tsx");
  assert.match(picker, /value="flux"/);
  assert.match(picker, /Imágenes IA con FLUX/);
  // Recraft remains the default when available.
  assert.match(picker, /defaultSource \?\? \(recraftAvailable \? "recraft" : "default"\)/);
  const actions = read("src/app/dashboard/new/actions.ts");
  assert.match(actions, /fluxChosen && !fluxAllowedFor\(user\)/);
  assert.match(actions, /reel_image_source: "flux"/);
  assert.match(read("src/lib/video/submission-key.ts"), /out\.reel_image_source = "flux"/);
  const runJob = read("src/lib/video/run-job.ts");
  assert.match(runJob, /fluxAllowedForWorker/);
  assert.match(runJob, /getFluxImageProvider\(\);\n    \}\n    await reserveJobSupply/);
  // The start route reserves the SAME FLUX envelope the worker asks for (else: "job envelope changed").
  assert.match(read("src/app/api/generate/[id]/render/route.ts"), /fluxUsd: videoRequest\.mode === "visual" && \(await loadFluxChoice\(service, id\)\) \? fluxReelDemandUsd\(videoRequest\.script_json\) : 0/);
  assert.match(runJob, /fluxUsd: mode === "visual" && flux \? fluxReelDemandUsd\(row\.script_json\) : 0/);
  const route = read("src/app/api/generate/[id]/confirm-production/route.ts");
  assert.match(route, /fluxProductionBlocker/);
  assert.match(route, /if \(!fluxAllowedFor\(user\)\)/);
});
