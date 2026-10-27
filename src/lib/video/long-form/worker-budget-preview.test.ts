import { test } from "node:test";
import assert from "node:assert/strict";
import { LONG_FORM_RENDER_JOB_TIMEOUT_MIN as PRODUCE_RENDER_TIMEOUT_MIN } from "./produce";
import { computeProductionPlan, REAL_LONG_FORM_PROVIDER_NAMES, VISUAL_STRATEGIES, type ProductionPlanBeatInput, type VisualStrategy } from "./production-plan";
import { narrationWordBudget } from "./duration-budget";
import {
  LONG_FORM_RENDER_JOB_TIMEOUT_MIN,
  longFormRenderCeilingUsd,
  previewWorkerAuthorization,
} from "./worker-budget-preview";
import type { ProductionPlan } from "./production-plan-types";

const tiny = {
  voiceCharacters: 1000,
  estimatedVoiceCostUsd: 0.1,
  providers: { ...REAL_LONG_FORM_PROVIDER_NAMES },
  allocation: { maxAiImageGenerations: 0, maxAiVideoClips: 0, maxGenerativeUsd: 0 },
  aiImageCount: 0,
  aiVideoClipCount: 0,
} as unknown as ProductionPlan;

test("el timeout de render del preview es el mismo que usa el worker", () => {
  assert.equal(LONG_FORM_RENDER_JOB_TIMEOUT_MIN, PRODUCE_RENDER_TIMEOUT_MIN);
  assert.equal(longFormRenderCeilingUsd(), 5.94);
});

test("guion ya gastado + render rechazan un plan cuyo costo de proveedores cabe en el tope", () => {
  const providerOnly = previewWorkerAuthorization({ plan: tiny, scriptSpentUsd: 0, observed: {}, hardMaxUsd: 12 });
  assert.equal(providerOnly.admits, true);
  assert.ok((providerOnly.subtotalUsd ?? 0) < 12);
  const withScript = previewWorkerAuthorization({ plan: tiny, scriptSpentUsd: 7, observed: {}, hardMaxUsd: 12 });
  assert.equal(withScript.admits, false);
  assert.match(withScript.userMessage, /guion ya gastado \$7\.00/);
  assert.match(withScript.userMessage, /supera el tope/);
  assert.ok((withScript.subtotalUsd ?? 0) > 12);
});

test("solo se recorta la contingencia; un subtotal que cabe se autoriza al tope", () => {
  const fit = previewWorkerAuthorization({ plan: tiny, scriptSpentUsd: 0, observed: {}, hardMaxUsd: 7, contingencyPct: 20 });
  assert.equal(fit.admits, true);
  assert.equal(fit.contingencyClipped, true);
  assert.equal(fit.authorizedCeilingUsd, 7);
  assert.ok((fit.proposedCeilingUsd ?? 0) > 7);
  const over = previewWorkerAuthorization({ plan: tiny, scriptSpentUsd: 0, observed: {}, hardMaxUsd: 6, contingencyPct: 20 });
  assert.equal(over.admits, false);
  assert.equal(over.authorizedCeilingUsd, null);
});

test("Beatoven sin precio verificado no se autoriza", () => {
  const plan = { ...tiny, providers: { ...tiny.providers, music: "beatoven" } } as ProductionPlan;
  const blocked = previewWorkerAuthorization({ plan, scriptSpentUsd: 0, observed: {}, hardMaxUsd: 100, musicCeilingUsd: null });
  assert.equal(blocked.admits, false);
  assert.match(blocked.userMessage, /Beatoven/);
  const priced = previewWorkerAuthorization({ plan, scriptSpentUsd: 0, observed: {}, hardMaxUsd: 100, musicCeilingUsd: 0.4 });
  assert.equal(priced.admits, true);
  assert.equal(priced.musicUsd, 0.4);
});

test("un precio de imagen ya facturado más alto entra en el subtotal conservador", () => {
  const plan = { ...tiny, allocation: { maxAiImageGenerations: 10, maxAiVideoClips: 0, maxGenerativeUsd: 1 } } as ProductionPlan;
  const list = previewWorkerAuthorization({ plan, scriptSpentUsd: 0, observed: {}, hardMaxUsd: 100 });
  const billed = previewWorkerAuthorization({ plan, scriptSpentUsd: 0, observed: { imageUsd: 0.2 }, hardMaxUsd: 100 });
  assert.ok((billed.imageUsd ?? 0) > (list.imageUsd ?? 0));
  assert.equal(billed.imageUsd, 2);
});

function scriptMinutes(minutes: number) {
  const budget = narrationWordBudget(minutes * 60);
  const token = "claro";
  return {
    topic: `matriz ${minutes} min`,
    beats: Array.from({ length: budget.beats }, (_, i): ProductionPlanBeatInput => ({
      id: `b${i}`,
      type: i === 0 ? "hook" : i === budget.beats - 1 ? "payoff" : "discovery",
      narration: Array.from({ length: budget.wordsPerBeat }, () => token).join(" "),
      visuals: [{ description: "archivo del tema, sin persona identificada", motion: false }],
    })),
  };
}

test("matriz offline 10/15/20/30 min con tope 12, guion 0, música 0 (USD 0)", () => {
  const rows: Array<Record<string, unknown>> = [];
  for (const minutes of [10, 15, 20, 30]) {
    const script = scriptMinutes(minutes);
    for (const strategy of VISUAL_STRATEGIES) {
      for (const aiVideo of [false, true]) {
        const previous = process.env.LONG_FORM_AI_VIDEO_ENABLED;
        process.env.LONG_FORM_AI_VIDEO_ENABLED = aiVideo ? "true" : "false";
        let plan: ProductionPlan;
        try {
          plan = computeProductionPlan({
            beats: script.beats, topic: script.topic, strategy: strategy as VisualStrategy,
            providers: REAL_LONG_FORM_PROVIDER_NAMES, aiVideoEnabled: aiVideo,
            requestedDurationSeconds: minutes * 60,
          });
        } finally {
          if (previous === undefined) delete process.env.LONG_FORM_AI_VIDEO_ENABLED;
          else process.env.LONG_FORM_AI_VIDEO_ENABLED = previous;
        }
        const auth = previewWorkerAuthorization({ plan, scriptSpentUsd: 0, observed: {}, hardMaxUsd: 12 });
        rows.push({
          minutes, strategy, aiVideo, providerUsd: plan.estimatedProviderCostUsd,
          voice: auth.voiceUsd, images: auth.imageUsd, video: auth.videoUsd, render: auth.renderUsd,
          subtotal: auth.subtotalUsd, proposed: auth.proposedCeilingUsd, authorized: auth.authorizedCeilingUsd,
          admits: auth.admits, contingencyClipped: auth.contingencyClipped,
        });
      }
    }
  }
  console.log(JSON.stringify(rows));
  assert.equal(rows.length, 24);
  assert.ok(rows.every((r) => r.render === 5.94));
  const economical = rows.filter((r) => r.strategy === "economical" && r.aiVideo === false);
  assert.ok(economical.every((r) => r.admits === true), JSON.stringify(economical));
});
