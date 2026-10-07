import { SupplyUnavailableError } from "@/lib/supply/policy";
import { gatedMusicTrack, type PaidCallDeps } from "@/lib/paid-calls/gated-providers";
import { supabaseLedgerStore } from "@/lib/paid-calls/supabase-ledger-store";
import { supabaseResultStore } from "@/lib/paid-calls/result-store";
/**
 * RC Phase 1 — versión "job real" del pipeline de Long Form, para que
 * `runRenderJob()` (src/lib/video/run-job.ts) pueda ejecutarlo exactamente
 * igual que ya ejecuta Reel (generateVideoFromScript) y Avatar
 * (generateAvatarVideo): a partir de una fila `video_requests` ya en
 * "processing", sin depender de que el navegador siga abierto (el worker
 * de GitHub Actions o el inline la disparan igual para las tres
 * modalidades, ver src/lib/worker/).
 *
 * NO sustituye a scripts/produce-long-form-video.ts (ese sigue siendo el
 * CLI para producir VIDEO #001 y correr fixtures/simulation localmente) —
 * es la ruta de PRODUCCIÓN real, sin los atajos específicos de ese CLI
 * (servidor HTTP local sobre un directorio temporal, hacks de VIDEO #001,
 * modo simulation). Reutiliza exactamente los mismos módulos ya probados:
 * mode.ts (nunca resuelve a fixture en silencio en modo real, ver
 * LongFormRealProviderMissingError), timeline.ts, cost.ts,
 * asset-resolver.ts (incluida su rama "ai_video" ya conectada, ver RC
 * Phase 1 anterior), captions.ts, audio-master.ts, render.ts.
 *
 * Durabilidad de cualquier clip de video-IA (Veo/Runway/Kling): el
 * VideoProvider real se envuelve con wrapDurableVideoProvider()
 * (ai-video-durable-provider.ts) — un retry de este mismo requestId
 * (nuevo render_attempts) nunca vuelve a pagar un shot ya generado con
 * éxito, reutiliza el registro STARTED/COMPLETED de ai-video-storage.ts.
 */
import fs from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildCaptions } from "../captions";
import { buildEmphasisSet } from "../caption-emphasis";
import { LOUDNESS_TARGET, masterAudioLoudness } from "../audio-master";

/** Margen de pico real de Long Form: la codificación AAC subía el pico ~0.3 dB sobre −1.5 dBTP (muestra M2: −1.21). */
export const LONG_FORM_TRUE_PEAK_MARGIN_DB = 1.0;
import { VIDEO_TAIL_SECONDS } from "../script-pacing";
import { computeNarrationGaps } from "../../../../remotion/audio-mix";
import { getVideoProvider } from "@/lib/providers/video-gen";
import { getVoiceIdentity } from "@/lib/ai/voice";
import type { MusicResult, ScriptLanguage, VideoProvider } from "@/lib/providers/types";
import { resolveLongFormProviders, type LongFormProviderSet } from "./mode";
import { buildLongFormTimeline, type BeatSynthesizer } from "./timeline";
import { shotsForSpan } from "./shots";
import { assertOpeningValid, CoverValidationError, renderLongFormDoc, renderLongFormThumbnail, type RenderLongFormDocInput } from "./render";
import { canonicalThumbnailPath, toCoverSpec } from "./packaging";
import { provenanceLabel } from "../../../../remotion/long-form-card-fit";
import { defaultDirections, snapSceneBoundaries } from "./montage-direction";
import { captionsWithinScenes } from "./scene-captions";
import type { LongFormShotScene } from "../../../../remotion/LongFormDoc";
import type { SceneDirection } from "../../../../remotion/long-form-direction";
import { wrapDurableVideoProvider } from "./ai-video-durable-provider";
import { emptyAiVideoLedgerState } from "./ai-video-cost-guard";
import { loadProductionCachedBeatNarration, synthesizeBeatNarrationProductionCached } from "./production-tts-cache";
import { personActionIndex, visualsForBeat } from "./visual-intents";
import {
  allocateShotTypes,
  executionAllocation,
  getGenerativeUnitCosts,
  isLongFormAiVideoConfigured,
  limitsWithinAllocation,
  strategyLimits,
  usesAnchoredVisuals,
  usesVisualIdentity,
  type ProductionPlan,
  planShotsFromScript,
  type ProductionPlanBeatInput,
} from "./production-plan";
import { DocumentAssetRegistry, type AssetIdentity } from "./asset-identity";
import { assertVisualQuality, buildVisualReport, LongFormVisualQualityError, type VisualReport } from "./visual-report";
import { planReleaseBlockers } from "./cinematic-director";
import { heroCoverage, VerifiedAssetRegistry } from "./verified-assets";
import { CURATION_FILE_PATH, isAuthorizedCurator, requestedContracts } from "./asset-curation";
import { containsFixtureOnlyMaterial } from "./fixture-only";
import { curatedSvgGraphic } from "./premium-composition";
import type { LongFormCuratedSvgGraphic } from "../../../../remotion/LongFormDoc";
import { PLAN_ESTIMATE_AVAILABILITY, registryAvailability, resolveSequences, usesSequences, validateSequenceIntents, type ExecutableSequence } from "./sequence-intent";
import { directSequenceScenes, planSequenceShots, sequenceShotsForSpan } from "./sequence-direction";
import { ProductionBudget, supabaseBudgetStore, type BudgetStore } from "./production-budget";
import { getPricingConfig } from "@/lib/billing/pricing";
import { getLongFormBudget } from "./cost";
import { conservativeUnits, conservativeWorstCaseUsd, loadObservedMax, productionHardCap, type ObservedMax } from "./spend-cap";
import { supabaseShotAssetStore, type ShotAssetStore } from "./durable-shot-assets";
import { executeShot, type ShotExecution } from "./shot-executor";
import { type LongFormStage } from "./stages";
import {
  finalizeLongFormOutput,
  markOutputCostsRecorded,
  reconcileExistingOutput,
  supabaseOutputDeps,
  type LongFormOutputState,
  type OutputFinalizeDeps,
} from "./output-finalize";
import { recordVideoGeneration } from "@/lib/billing/usage";

const STORAGE_BUCKET = "videos";
const ASSET_SIGNED_URL_TTL_SECONDS = 60 * 60;
/** Por encima de esta fracción de shots degradados a tarjeta de texto, el documental no se entrega (calidad insuficiente). */
export const MAX_TEXT_FALLBACK_RATIO = 0.25;

/**
 * `units` lleva progreso REAL por unidad de trabajo dentro de la etapa:
 * narraciones sintetizadas (storyboard), escenas resueltas (assets),
 * fotogramas renderizados (rendering). Nunca inventado — ver progress.ts.
 */
export type LongFormProgressUnits = { completed: number; total: number; label: string };
type OnProgress = (stage: LongFormStage, units?: LongFormProgressUnits) => void | Promise<void>;

/** Dependencias inyectables (pruebas / inyección de fallos). En producción se omiten todas. */
export type LongFormRuntime = {
  /**
   * v4: registro de recursos verificados del SERVIDOR (ya rehidratado). Ausente = se rehidrata
   * desde `{requestId}/state/curation.json` (decisiones del curador; datos, no autoridad), o vacío.
   */
  verifiedAssets?: VerifiedAssetRegistry;
  paidCalls?: Pick<PaidCallDeps, "ledger" | "results">;
  store?: ShotAssetStore;
  budgetStore?: BudgetStore;
  /** `null` fuerza "sin proveedor de video IA"; ausente = el real (envuelto durable) solo si el plan lo permite. */
  videoProvider?: VideoProvider | null;
  synthesizeBeat?: BeatSynthesizer;
  uploadArtifact?: (objectPath: string, buffer: Buffer, contentType: string) => Promise<{ path: string; url: string }>;
  render?: (input: RenderLongFormDocInput) => Promise<string>;
  /** Render de la miniatura (por defecto renderLongFormThumbnail); inyectable en pruebas. */
  renderThumbnail?: (input: import("../../../../remotion/LongFormThumbnail").LongFormThumbnailProps) => Promise<string>;
  aiVideoEnabled?: boolean;
  recordCosts?: boolean;
  resumeBackoffMs?: number;
  /** Entrega del MP4 final (output-finalize.ts). Por defecto: Supabase + ffprobe/ffmpeg reales. */
  output?: OutputFinalizeDeps;
  /**
   * Recuperación (P0 2026-09-25): CERO llamadas a proveedores. Narración
   * solo desde el caché TTS durable y escenas solo desde registros
   * COMPLETED; cualquier faltante o desviación respecto de lo ya ejecutado
   * aborta (LongFormReplayError) antes de renderizar.
   */
  replayOnly?: boolean;
  /** Tests: highest billed cost per call, instead of reading the ledger. */
  observedUnitMax?: ObservedMax;
  /** Perfil de codificación del render (ver render.ts). */
  encoding?: RenderLongFormDocInput["encoding"];
  /** Intento (render_attempts) — solo para el estado durable de la salida. */
  attempt?: number | null;
  /** Destino del informe visual previo al render (por defecto `${requestId}/state/visual-report.json`). */
  saveVisualReport?: (report: VisualReport) => Promise<void>;
  /**
   * v5 GEOGRAPHY: lee el SVG CURADO ya persistido por el ejecutor (ruta del objeto) para revelar su trazo.
   * Ausente (producción hoy) = el esquema se muestra completo, quieto, sin revelado.
   */
  curatedSvgMarkup?: (objectPath: string) => Promise<string | null>;
  /** Inyectable en pruebas: identidad de contenido sin ffmpeg/sharp. */
  identify?: (buffer: Buffer, mediaType: "image" | "video") => Promise<Pick<AssetIdentity, "sha256" | "dhash" | "dhashUnavailable">>;
  /**
   * Hoja de sonido explícita (contrato de Work, remotion/long-form-direction.ts).
   * Si se pasa, REEMPLAZA la música de fondo única (nunca se suman: música doble).
   */
  soundCues?: RenderLongFormDocInput["soundCues"];
};

export class LongFormReplayError extends Error {
  constructor(reason: string) {
    super(`Recuperación abortada sin llamar a ningún proveedor: ${reason}`);
    this.name = "LongFormReplayError";
  }
}

export class LongFormScriptChangedError extends Error {
  constructor() {
    super("El guion cambió después de confirmar el plan de producción — no se ejecuta un plan distinto al confirmado.");
    this.name = "LongFormScriptChangedError";
  }
}

export class LongFormQualityError extends Error {
  constructor(degraded: number, total: number) {
    super(
      `Demasiadas escenas sin material real (${degraded}/${total} degradadas a tarjeta de texto) — no se entrega un documental de baja calidad. ` +
        "Los recursos ya obtenidos quedan guardados; un reintento no los vuelve a pagar.",
    );
    this.name = "LongFormQualityError";
  }
}

export { isLongFormScriptJson, type LongFormScriptBeatInput, type LongFormScriptJson } from "./script-json";
import type { LongFormScriptBeatInput } from "./script-json";

export async function generateLongFormVideoFromScript({
  supabase,
  requestId,
  artifactPrefix = requestId,
  topic,
  beats,
  language = "es",
  onProgress,
  providers,
  plan,
  runtime = {},
}: {
  supabase: SupabaseClient;
  requestId: string;
  artifactPrefix?: string;
  topic: string;
  beats: LongFormScriptBeatInput[];
  language?: ScriptLanguage;
  onProgress?: OnProgress;
  /** Inyección para pruebas — en producción siempre se omite (nunca fixture en silencio, ver mode.ts). */
  providers?: LongFormProviderSet;
  /** Snapshot CONFIRMADO (long_form_production_plan) — el worker ejecuta exactamente su estrategia y nunca excede su allocation. */
  plan: ProductionPlan;
  runtime?: LongFormRuntime;
}): Promise<{ videoPath: string; deviations: number; spentUsd: number; reconciled: boolean; output: LongFormOutputState | null; thumbnailPath?: string }> {
  const voiceCharacters = beats.reduce((sum, b) => sum + b.narration.length, 0);
  if (voiceCharacters !== plan.voiceCharacters) throw new LongFormScriptChangedError();

  // Reconciliación ANTES de cualquier trabajo: si un intento anterior ya
  // entregó la salida canónica (p. ej. la subida funcionó y falló la
  // actualización de la fila), se reutiliza — 0 render, 0 proveedores.
  const paidCalls: PaidCallDeps = { ledger: runtime.paidCalls?.ledger ?? supabaseLedgerStore(supabase),
    results: runtime.paidCalls?.results ?? supabaseResultStore(supabase, STORAGE_BUCKET), requestId };
  const outputDeps = runtime.output ?? supabaseOutputDeps(supabase);
  const existingOutput = await reconcileExistingOutput(requestId, outputDeps);
  if (existingOutput) {
    return { videoPath: existingOutput.videoPath, deviations: 0, spentUsd: 0, reconciled: true, output: existingOutput.state };
  }
  const replayOnly = runtime.replayOnly === true;
  // v4: lo que el PLAN ya revela como no entregable (clasificación incierta en HERO, apertura de
  // tarjetas seguras) se detiene ANTES de cualquier llamada pagada: voz, imágenes, video o render.
  // Además, la cobertura HERO con material verificado: si las reglas existentes (3 tarjetas en los primeros
  // 30 s, proporción máxima de tarjetas) hacen el fallo inevitable, no se gasta nada.
  let verifiedAssets: VerifiedAssetRegistry | undefined;
  // v5: la intención por secuencia existe ANTES de elegir recursos; aquí se resuelve contra el registro real.
  let sequences: ExecutableSequence[] | undefined;
  if (usesVisualIdentity(plan)) {
    const v5 = usesSequences(plan);
    if (v5) {
      const check = validateSequenceIntents(plan.sequences, beats as ProductionPlanBeatInput[]);
      if (check.errors.length > 0) throw new LongFormVisualQualityError(check.errors.map((e) => `SEQUENCE_CONTRACT: ${e}`));
    }
    const estimate = v5
      ? planSequenceShots(beats as ProductionPlanBeatInput[], resolveSequences(plan.sequences!, PLAN_ESTIMATE_AVAILABILITY)).shots
      : planShotsFromScript(beats as ProductionPlanBeatInput[], topic, plan.strategy).shots;
    verifiedAssets = runtime.verifiedAssets ?? (await loadVerifiedAssets(supabase, requestId, new Set(requestedContracts(estimate).keys())));
    if (v5) sequences = resolveSequences(plan.sequences!, registryAvailability(verifiedAssets));
    const plannedShots = sequences ? planSequenceShots(beats as ProductionPlanBeatInput[], sequences).shots : estimate;
    const blockers = planReleaseBlockers(plannedShots).map((f) => `${f.code}: ${f.detail} (${f.shots.join(", ")})`);
    const coverage = heroCoverage(plannedShots, verifiedAssets, MAX_TEXT_FALLBACK_RATIO);
    const missing = [...coverage.heroMissingRequiredIdentities, ...coverage.heroMissingRequiredEvidence, ...coverage.missingIdentities, ...coverage.missingEvidence];
    blockers.push(...coverage.blockers.map((b) => `HERO_COVERAGE ${b} (faltan: ${[...new Set(missing)].join(", ") || "—"})`));
    if (blockers.length > 0) throw new LongFormVisualQualityError(blockers);
  }

  const resolvedProviders = providers ?? resolveLongFormProviders("real");
  const requireReal = !providers;
  const store = runtime.store ?? supabaseShotAssetStore(supabase, requestId, STORAGE_BUCKET);
  const allocation = executionAllocation(plan);
  // Abrir el presupuesto (gratis) ANTES de cualquier llamada pagada: si el
  // storage no responde, el trabajo falla aquí con $0 gastado.
  const units = getGenerativeUnitCosts(plan.providers.aiVideo);
  // Hard cap BEFORE any paid call: conservative prices (never below the highest
  // cost already billed for the same call) applied to the confirmed allocation.
  const conservative = conservativeUnits({ imageUsd: units.imageUsd, clipUsd: units.veoClipUsd, voiceUsdPer1kChars: getPricingConfig().elevenLabsUsdPer1kChars },
    runtime.observedUnitMax ?? (replayOnly ? {} : await loadObservedMax(supabase, plan.providers)));
  const narrationUsd = (plan.voiceCharacters / 1000) * conservative.voiceUsdPer1kChars;
  const hardCapUsd = productionHardCap(conservativeWorstCaseUsd({ voiceCharacters: plan.voiceCharacters, allocation }, conservative), getLongFormBudget().maxTotalUsd);
  const budget = await ProductionBudget.open(runtime.budgetStore ?? supabaseBudgetStore(supabase, requestId, STORAGE_BUCKET), allocation,
    { capUsd: hardCapUsd, fixedUsd: narrationUsd });
  // Fail before speech/image spend if a Runway plan cannot actually animate.
  if (!replayOnly && allocation.maxAiVideoClips > 0 && plan.providers.aiVideo === "runway") {
    const candidate = runtime.videoProvider !== undefined ? runtime.videoProvider : getVideoProvider("runway");
    if (!candidate || candidate.name !== "runway" || !candidate.isAvailable() || !(runtime.aiVideoEnabled ?? isLongFormAiVideoConfigured())) {
      throw new Error("El plan confirmado requiere Runway, pero su conexión no está disponible. No se ha iniciado la generación.");
    }
  }
  const uploadArtifact = runtime.uploadArtifact ?? ((path: string, buffer: Buffer, ct: string) => uploadToStorage(supabase, path, buffer, ct));

  await onProgress?.("scripting");
  await onProgress?.("storyboard", { completed: 0, total: beats.length, label: "narraciones" });

  const baseSynth: BeatSynthesizer =
    runtime.synthesizeBeat ??
    (replayOnly
      ? (voiceProvider, beat, lang) =>
          loadProductionCachedBeatNarration(supabase, voiceProvider.name, beat, lang, {
            videoId: requestId,
            voiceIdentity: getVoiceIdentity(lang === "en" ? "en" : "es"),
          })
      : null) ??
    ((voiceProvider, beat, lang) =>
      synthesizeBeatNarrationProductionCached(supabase, voiceProvider, beat, lang, {
        ledger: paidCalls.ledger,
        videoId: requestId,
        voiceIdentity: getVoiceIdentity(lang === "en" ? "en" : "es"),
      }));
  let synthesized = 0;
  const synthesizeWithProgress: BeatSynthesizer = async (voiceProvider, beat, lang) => {
    const result = await baseSynth(voiceProvider, beat, lang);
    synthesized += 1;
    await onProgress?.("storyboard", { completed: synthesized, total: beats.length, label: "narraciones" });
    return result;
  };
  // Plan = contrato de ejecución también en número de escenas: cada beat se
  // reparte en las escenas que se mostraron al confirmar (si la duración
  // real narrada lo permite). Planes sin beatShotCounts (anteriores) usan
  // el reparto por defecto, idéntico al de su ejecución original.
  const plannedShotCounts = plan.beatShotCounts;
  // Planes v3+: cada escena se ancla al pasaje narrado DURANTE ella con los
  // tiempos reales por palabra (scene-anchoring.ts). v1/v2: sin cambios.
  const anchored = usesAnchoredVisuals(plan);
  const shotsForPlannedSpan = (spanInput: Parameters<typeof shotsForSpan>[0] & { words?: import("@/lib/providers/types").WordTiming[] }) =>
    sequences
      ? // v5: los planos salen de los ROLES resueltos (no del reparto de 3–8 s por duración).
        sequenceShotsForSpan({ beatId: spanInput.beatId, startSec: spanInput.startSec, endSec: spanInput.endSec, narration: spanInput.narration, words: spanInput.words, sequences })
      : shotsForSpan({
          ...spanInput,
          targetCount: plannedShotCounts?.[spanInput.beatId],
          anchoring: anchored ? { words: spanInput.words } : undefined,
        });
  const personActions = usesVisualIdentity(plan) ? personActionIndex(beats as { visuals?: unknown }[]) : undefined;
  const timeline = await buildLongFormTimeline(
    resolvedProviders.voiceProvider,
    beats,
    language,
    shotsForPlannedSpan,
    synthesizeWithProgress,
    plan.strategy,
    // Las escenas se re-derivan del guion: solo un plan v4 lee clase e identidad.
    (beat) => visualsForBeat(beat as { narration: string; visuals?: unknown }, topic, { identity: usesVisualIdentity(plan), personActions }),
  );

  // Proveedor de video IA real (solo si el plan confirmado tiene clips). Si
  // en este entorno resuelve a fixture (p. ej. falta VEO_API_KEY), el video
  // IA se desactiva ANTES de asignar: esas ranuras se degradan a imagen IA
  // dentro de la allocation, nunca a un clip de fixture en producción.
  let baseVideoProvider: VideoProvider | null = null;
  if (replayOnly) {
    baseVideoProvider = null;
  } else if (runtime.videoProvider !== undefined) {
    baseVideoProvider = runtime.videoProvider;
  } else if (allocation.maxAiVideoClips > 0 && (runtime.aiVideoEnabled ?? isLongFormAiVideoConfigured())) {
    const candidate = getVideoProvider(plan.providers.aiVideo);
    baseVideoProvider = candidate.name === "fixture" && requireReal ? null : candidate;
  }
  const aiVideoEnabled = baseVideoProvider !== null && (runtime.aiVideoEnabled ?? true);
  const limits = {
    ...limitsWithinAllocation(strategyLimits(plan.strategy, plan.estimatedVoiceCostUsd ?? 0, { aiVideoEnabled, units }), allocation),
    // v4: el asignador no pide lo que el Director prohíbe (mismas reglas que al calcular el plan).
    cinematic: usesVisualIdentity(plan),
  };
  const allShots = timeline.beats.flatMap((b) => b.shots);
  const allocated = allocateShotTypes(allShots, timeline.durationSeconds, limits);
  if (plannedShotCounts && allShots.length !== plan.shotCount && !replayOnly) {
    // Nunca en silencio: la duración real narrada no permitió respetar el
    // número de escenas confirmado (queda registrado en el presupuesto).
    await budget.recordDeviation({
      shotId: "*",
      planned: `${plan.shotCount} escenas`,
      executed: `${allShots.length} escenas`,
      reason: `duración real narrada ${Math.round(timeline.durationSeconds)} s vs ${plan.durationSeconds} s estimados — fuera del rango de 3-8 s por escena`,
    });
  }
  if (allocated.aiImageCount !== plan.aiImageCount || allocated.aiVideoClipCount !== plan.aiVideoClipCount) {
    if (replayOnly) {
      throw new LongFormReplayError(
        `la asignación reconstruida (${allocated.aiImageCount} imágenes IA, ${allocated.aiVideoClipCount} clips) difiere del plan (${plan.aiImageCount}, ${plan.aiVideoClipCount})`,
      );
    }
    await budget.recordDeviation({
      shotId: "*",
      planned: `${plan.aiImageCount} imágenes IA, ${plan.aiVideoClipCount} clips de video IA`,
      executed: `${allocated.aiImageCount} imágenes IA, ${allocated.aiVideoClipCount} clips de video IA`,
      reason: "duración real narrada distinta de la estimada — siempre dentro de la allocation confirmada",
    });
  }

  const videoProvider: VideoProvider | undefined =
    baseVideoProvider && limits.aiVideoEnabled && allocated.aiVideoClipCount > 0
      ? wrapDurableVideoProvider(baseVideoProvider, {
          ledger: paidCalls.ledger,
          supabase,
          scopeId: requestId,
          executionMode: "real",
          beforeSubmit: () => budget.reserveAiVideoSubmit(units.veoClipUsd, conservative.clipUsd),
          maxInAttemptResumes: 2,
          resumeBackoffMs: runtime.resumeBackoffMs,
        })
      : undefined;

  // Registro de identidad del documental (v3): se siembra con TODO lo ya
  // resuelto en intentos anteriores ANTES de elegir nada nuevo, para que un
  // reintento nunca reutilice en otra escena un recurso ya usado.
  const priorTextDeviations = new Set(budget.snapshot().deviations.filter((d) => d.executed === "text").map((d) => d.shotId));
  const registry = anchored ? new DocumentAssetRegistry() : undefined;
  if (registry) {
    for (let i = 0; i < allocated.shots.length; i += 10) {
      await Promise.all(
        allocated.shots.slice(i, i + 10).map(async (shot) => {
          for (const kind of ["stock", "ai_image", "ai_video"] as const) {
            const record = await store.read(shot.id, kind);
            if (record?.status === "COMPLETED" && record.identity) registry.register(shot.id, record.identity);
          }
        }),
      );
    }
  }

  await onProgress?.("assets", { completed: 0, total: allocated.shots.length, label: "escenas" });
  let aiVideoLedger = emptyAiVideoLedgerState();
  let spentUsd = 0;
  let storageBytes = 0;
  let footageCount = 0;
  let aiImageCostUsd = 0;
  let aiVideoCostUsd = 0;
  let aiVideoClipsUsed = 0;
  let deviations = 0;
  let degradedToText = 0;
  const executions: ShotExecution[] = [];
  for (const [index, shot] of allocated.shots.entries()) {
    const execution = await executeShot(
      shot,
      {
        ledger: paidCalls.ledger,
        topic,
        footageProvider: resolvedProviders.footageProvider,
        imageProvider: resolvedProviders.imageProvider,
        videoProvider,
        store,
        budget,
        units,
        conservativeImageUsd: conservative.imageUsd,
        aiVideoCostConfig: limits.aiVideoCostConfig,
        totalDurationSec: timeline.durationSeconds,
        requireReal,
        metadata: { requestId },
        replayOnly,
        visualPipeline: anchored ? "anchored_v1" : undefined,
        registry,
        identify: runtime.identify,
        verifiedAssets,
      },
      aiVideoLedger,
    );
    // Una escena que ya fue tarjeta (carencia/degradación) en la ejecución
    // original — registrada en el presupuesto durable — se reproduce igual.
    const priorTextFallback = execution.executedType === "text" && priorTextDeviations.has(shot.id);
    if (replayOnly && !priorTextFallback && (execution.deviation || !(execution.reused || execution.executedType === "text"))) {
      throw new LongFormReplayError(
        `la escena ${shot.id} no se reproduce igual que en la ejecución original (${execution.deviation ? `${execution.deviation.planned} → ${execution.deviation.executed}: ${execution.deviation.reason}` : "asset no reutilizado"})`,
      );
    }
    aiVideoLedger = execution.aiVideoLedger;
    executions.push(execution);
    storageBytes += execution.bufferBytes;
    if (!execution.reused) spentUsd += execution.costUsd;
    if (execution.executedType === "stock_video" || execution.executedType === "ken_burns_image") footageCount += 1;
    if (execution.executedType === "generated_placeholder") {
      aiImageCostUsd += execution.attributedCostUsd;
    }
    if (execution.executedType === "ai_video") {
      aiVideoClipsUsed += 1;
      aiVideoCostUsd += execution.attributedCostUsd;
    }
    if (execution.deviation) {
      deviations += 1;
      if (execution.deviation.executed === "text") degradedToText += 1;
      await budget.recordDeviation({ shotId: shot.id, ...execution.deviation });
    }
    await onProgress?.("assets", { completed: index + 1, total: allocated.shots.length, label: "escenas" });
  }
  // Informe visual PREVIO al render (se guarda siempre, antes de cualquier
  // control que pueda detener la producción: las carencias quedan visibles).
  const visualReport = buildVisualReport({ requestId, planVersion: plan.version, topic, shots: allocated.shots, executions });
  const saveReport =
    runtime.saveVisualReport ??
    (async (report: VisualReport) => {
      await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(`${requestId}/state/visual-report.json`, Buffer.from(JSON.stringify(report, null, 2)), { contentType: "application/json", upsert: true });
    });
  await saveReport(visualReport).catch((err) => {
    console.warn(`[atomivid:long-form:produce] ${requestId} — no se pudo guardar el informe visual:`, err instanceof Error ? err.message : err);
  });
  assertVisualQuality(visualReport);

  if (allocated.shots.length > 0 && degradedToText / allocated.shots.length > MAX_TEXT_FALLBACK_RATIO) {
    throw new LongFormQualityError(degradedToText, allocated.shots.length);
  }

  const baseScenes = allocated.shots.map((shot, i) => ({
    id: shot.id,
    startSeconds: shot.startSec,
    endSeconds: shot.endSec,
    asset: executions[i].asset,
    motion: shot.motion,
  }));
  // v3: cortes alineados a la voz real, dirección de montaje editorial,
  // procedencia visible y carencias marcadas (nunca pasan por terminadas).
  // v1/v2 y la recuperación de planes anteriores: sin cambios.
  const anchoredScenes = anchored ? directAnchoredScenes(baseScenes, executions, timeline.words, visualReport.cinematic?.scenes) : baseScenes;
  // v5: escala y encuadre por ROL sobre escenas que ya pasaron por la verdad (mismo recurso, procedencia y crédito).
  const geography = new Map<number, LongFormCuratedSvgGraphic>();
  if (sequences && verifiedAssets && runtime.curatedSvgMarkup) {
    for (let i = 0; i < allocated.shots.length; i++) {
      const shot = allocated.shots[i];
      const meta = executions[i]?.assetMeta;
      if (shot.sequenceSlot?.role !== "GEOGRAPHY" || !shot.anchoredVisual || !meta?.objectPath) continue;
      // Solo el registro de CONFIANZA que el ejecutor usó (misma página de origen) y su SVG intacto.
      const record = verifiedAssets.recordsFor(shot.anchoredVisual).find((r) => r.sourceUrl === meta.provenance?.pageUrl);
      const markup = await runtime.curatedSvgMarkup(meta.objectPath);
      const graphic = markup ? curatedSvgGraphic(record, markup) : null;
      if (graphic) geography.set(i, graphic);
    }
  }
  const shotScenes = sequences ? directSequenceScenes(anchoredScenes, allocated.shots, executions, { geography: (i) => geography.get(i) ?? null }) : anchoredScenes;

  const emphasisSet = buildEmphasisSet([]);
  // v3: ningún subtítulo cruza un corte de escena; v1/v2 sin cambios.
  const captions = anchored
    ? captionsWithinScenes(timeline.words, shotScenes, (w) => buildCaptions(w, emphasisSet))
    : buildCaptions(timeline.words, emphasisSet);
  const narrationGaps = computeNarrationGaps(timeline.words);

  const fullNarrationText = beats.map((b) => b.narration).join(" ");
  const finalDurationSeconds = timeline.durationSeconds + VIDEO_TAIL_SECONDS;
  let music: MusicResult | null = null;
  let musicFallbackReason: string | null = null;
  try {
    music = await gatedMusicTrack({ ...paidCalls, musicProvider: resolvedProviders.musicProvider, estimatedCostUsd: Number(process.env.BEATOVEN_ESTIMATED_COST_USD || "0") }, {
      durationSeconds: finalDurationSeconds,
      style: "documental",
      topic,
      scriptText: fullNarrationText,
      language,
      seed: requestId,
    });
  } catch (err) {
    if (err instanceof SupplyUnavailableError) throw err;
    musicFallbackReason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.warn(`[atomivid:long-form:produce] ${requestId} — no se pudo obtener música, el documental se genera sin ella:`, musicFallbackReason);
  }
  let musicUrl: string | undefined;
  if (music) {
    storageBytes += music.audioBuffer.byteLength;
    musicUrl = (await uploadArtifact(`${artifactPrefix}/music.${music.extension}`, music.audioBuffer, music.mimeType)).url;
  }

  storageBytes += timeline.audioBuffer.byteLength;
  const audioUpload = await uploadArtifact(`${artifactPrefix}/voice.${timeline.extension}`, timeline.audioBuffer, timeline.mimeType);

  await onProgress?.("rendering");
  // renderMedia() reporta fotogramas de forma síncrona: se encadenan las
  // escrituras de progreso (con throttle) y cualquier fallo (p. ej. el
  // intento perdió su reserva) se relanza al terminar el render.
  let progressChain: Promise<void> = Promise.resolve();
  let progressError: unknown = null;
  let lastReportedFrames = -1;
  let lastReportedAt = 0;
  const renderStartedAt = Date.now();
  // Presentación para YouTube (portada/miniatura): SOLO planes v3 y solo si se eligió al confirmar.
  // Un problema de la portada nunca tumba una producción ya pagada: se renderiza sin ella y se registra.
  const packaging = anchored ? plan.packaging : undefined;
  let opening = packaging?.cover.enabled ? toCoverSpec(packaging.cover) : undefined;
  if (opening) {
    try {
      assertOpeningValid(opening, shotScenes[0]);
    } catch (err) {
      if (!(err instanceof CoverValidationError)) throw err;
      console.warn(`[atomivid:long-form:produce] ${requestId} — portada omitida: ${err.message}`);
      opening = undefined;
    }
  }
  const rawOutputPath = await (runtime.render ?? renderLongFormDoc)({
    ...(opening ? { opening } : {}),
    audioUrl: audioUpload.url,
    musicUrl: runtime.soundCues ? undefined : musicUrl,
    soundCues: runtime.soundCues,
    scenes: shotScenes,
    captions,
    narrationGaps,
    durationSeconds: finalDurationSeconds,
    encoding: runtime.encoding,
    onFrameProgress: ({ renderedFrames, totalFrames }) => {
      const now = Date.now();
      const step = Math.max(1, Math.floor(totalFrames / 50));
      if (renderedFrames < totalFrames && renderedFrames - lastReportedFrames < step && now - lastReportedAt < 20_000) return;
      lastReportedFrames = renderedFrames;
      lastReportedAt = now;
      progressChain = progressChain
        .then(() => onProgress?.("rendering", { completed: renderedFrames, total: totalFrames, label: "fotogramas" }))
        .catch((err) => {
          progressError = progressError ?? err;
        });
    },
  });
  await progressChain;
  if (progressError) throw progressError;
  const renderMs = Date.now() - renderStartedAt;

  let outputPath = rawOutputPath;
  try {
    const masteredPath = rawOutputPath.replace(/\.mp4$/, ".mastered.mp4");
    const mastering = await masterAudioLoudness(rawOutputPath, masteredPath, { faststart: true, truePeakMarginDb: LONG_FORM_TRUE_PEAK_MARGIN_DB });
    outputPath = masteredPath;
    console.log("[atomivid:long-form:produce] masterización de loudness", JSON.stringify({ requestId, target: LOUDNESS_TARGET, ...mastering }));
  } catch (err) {
    console.warn(
      `[atomivid:long-form:produce] ${requestId} — no se pudo masterizar el loudness (¿falta ffmpeg?), se sube sin normalizar:`,
      err instanceof Error ? err.message : err,
    );
  }

  // Entrega idempotente (output-finalize.ts): preflight de tamaño con el
  // archivo YA renderizado, subida reanudable con reintentos del MISMO
  // archivo, salida canónica por solicitud y estado durable. Un fallo aquí
  // nunca vuelve a renderizar ni llama a proveedores; el archivo se
  // conserva (LONG_FORM_OUTPUT_KEEP_DIR) y el cliente ve un mensaje seguro.
  if (outputPath !== rawOutputPath) await fs.unlink(rawOutputPath).catch(() => {});
  const { videoPath, state: outputState } = await finalizeLongFormOutput(
    { requestId, attempt: runtime.attempt ?? null, filePath: outputPath, profile: runtime.encoding },
    outputDeps,
  );
  storageBytes += outputState.delivered?.bytes ?? 0;
  await fs.unlink(outputPath).catch(() => {});

  // Miniatura de YouTube (opcional, independiente de la portada): la imagen de la primera escena con su
  // reencuadre + el título. Un fallo aquí nunca afecta al video ya entregado.
  let thumbnailPath: string | undefined;
  const first = shotScenes[0] as import("../../../../remotion/LongFormDoc").LongFormShotScene | undefined;
  if (packaging?.thumbnail.enabled && first?.asset.kind === "media") {
    try {
      const jpg = await (runtime.renderThumbnail ?? renderLongFormThumbnail)({
        background: { mediaType: first.asset.mediaType, url: first.asset.url, look: first.direction?.look, mediaStartSeconds: first.direction?.mediaStartSeconds },
        cover: toCoverSpec(packaging.thumbnail),
        provenanceLabel: provenanceLabel(first.provenance),
      });
      const buffer = await fs.readFile(jpg);
      thumbnailPath = (await uploadArtifact(canonicalThumbnailPath(requestId), buffer, "image/jpeg")).path;
      storageBytes += buffer.byteLength;
      await fs.unlink(jpg).catch(() => {});
    } catch (err) {
      console.warn(`[atomivid:long-form:produce] ${requestId} — no se pudo generar la miniatura:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(
    "[atomivid:long-form:produce] terminado",
    JSON.stringify({ requestId, strategy: plan.strategy, shotCount: shotScenes.length, durationSeconds: finalDurationSeconds, spentUsd, deviations, budget: budget.snapshot().used }),
  );

  if (runtime.recordCosts !== false) {
    // Mismo registro de costos que Reel/Avatar (generation_costs) — un
    // fallo aquí nunca tumba un video que sí se generó.
    await recordVideoGeneration(supabase, requestId, {
      voiceProvider: resolvedProviders.voiceProvider.name,
      voiceCharacters: fullNarrationText.length,
      footageProvider: resolvedProviders.footageProvider.name,
      footageCount,
      musicProvider: music ? resolvedProviders.musicProvider.name : "none",
      musicTrack: music?.track
        ? { id: music.track.trackId, title: music.track.title, author: music.track.author, license: music.track.license, sourceUrl: music.track.sourceUrl }
        : null,
      musicFallbackReason,
      videoDurationSeconds: finalDurationSeconds,
      renderMs,
      storageBytes,
      // Costo REAL del video: incluye lo pagado en un intento anterior y
      // reutilizado aquí (antes solo contaba el gasto nuevo de este intento).
      creativeLayer: {
        imageProvider: aiImageCostUsd > 0 ? resolvedProviders.imageProvider.name : undefined,
        imageCostUsd: aiImageCostUsd,
        premiumVideoProvider: aiVideoClipsUsed > 0 ? (videoProvider?.name ?? "veo") : undefined,
        premiumVideoClipCount: aiVideoClipsUsed,
        premiumVideoCostUsd: aiVideoCostUsd,
      },
    })
      .then(() => markOutputCostsRecorded(outputState, outputDeps))
      .catch((err) => {
        console.warn(`[atomivid:long-form:produce] No se pudo registrar el costo de ${requestId}:`, err);
      });
  }

  return { videoPath, deviations, spentUsd, reconciled: false, output: outputState, thumbnailPath };
}

/** Mismo patrón que generate-video.ts (Shorts): sube al bucket privado y firma una URL de corta duración para que este mismo proceso (Remotion) pueda leerla. */
async function uploadToStorage(
  supabase: SupabaseClient,
  objectPath: string,
  buffer: Buffer,
  contentType: string,
): Promise<{ path: string; url: string }> {
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(objectPath, buffer, { contentType, upsert: true });
  if (error) throw new Error(`No se pudo subir ${objectPath}: ${error.message}`);

  const { data, error: signError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(objectPath, ASSET_SIGNED_URL_TTL_SECONDS);
  if (signError || !data) throw new Error(`No se pudo firmar la URL de ${objectPath}: ${signError?.message ?? "desconocido"}`);

  return { path: objectPath, url: data.signedUrl };
}

/** Escenas v3 listas para renderizar: límites alineados a la voz, dirección, procedencia y carencias visibles. */
export function directAnchoredScenes(
  scenes: LongFormShotScene[],
  executions: Pick<ShotExecution, "assetMeta">[],
  words: { startSeconds: number; endSeconds: number }[],
  /** v4: cámara y tratamiento decididos por el Cinematic Director (los mismos que mide el QA). */
  cinematic?: { camera: SceneDirection["camera"]; look?: SceneDirection["look"]; document?: SceneDirection["document"]; provenance?: string }[],
): LongFormShotScene[] {
  if (scenes.length === 0) return scenes;
  const bounds = snapSceneBoundaries([...scenes.map((s) => s.startSeconds), scenes[scenes.length - 1].endSeconds], words);
  const directions = defaultDirections(
    scenes.map((s, i) => ({
      kind: s.asset.kind === "media" ? s.asset.mediaType : "graphic",
      provenance: executions[i]?.assetMeta?.provenance?.kind,
    })),
  );
  return scenes.map((scene, i) => {
    const gap = executions[i]?.assetMeta?.gap;
    return {
      ...scene,
      startSeconds: bounds[i],
      endSeconds: bounds[i + 1],
      direction: cinematic?.[i] ? { ...directions[i], camera: cinematic[i].camera, ...(cinematic[i].look ? { look: cinematic[i].look } : {}), ...(cinematic[i].document ? { document: cinematic[i].document } : {}) } : directions[i],
      // v4: un video IA sin metadatos también se rotula "Recreación IA" (la decisión del Director lo sabe).
      provenance: executions[i]?.assetMeta?.provenance?.kind ?? (cinematic?.[i]?.provenance === "ai_recreation" ? "ai_recreation" : undefined),
      // v4: crédito visible del recurso verificado (CC BY lo exige) → SceneLabels.
      ...(cinematic && executions[i]?.assetMeta?.provenance?.credit ? { creditText: executions[i].assetMeta!.provenance!.credit } : {}),
      pending: gap ? `carencia de material pertinente: ${gap.reason}` : undefined,
    };
  });
}

/**
 * Registro verificado de esta solicitud: el archivo de curaduría
 * (`{requestId}/state/curation.json`, escrito solo por las acciones del curador)
 * es un dato NO confiable; la confianza la recalcula aquí el servidor
 * (licencia, calidad, crédito, huella, curador autorizado HOY, estado, contrato
 * exacto que el plan pide). Ausente o ilegible = vacío.
 */
async function loadVerifiedAssets(supabase: SupabaseClient, requestId: string, contracts: ReadonlySet<string>): Promise<VerifiedAssetRegistry> {
  let raw: unknown;
  try {
    const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(CURATION_FILE_PATH(requestId));
    if (error || !data) return VerifiedAssetRegistry.empty();
    raw = JSON.parse(await data.text());
  } catch {
    return VerifiedAssetRegistry.empty();
  }
  // Material de benchmark (FIXTURE_ONLY / TEST_ONLY) nunca entra en una solicitud real, aunque lo apruebe un curador.
  if (containsFixtureOnlyMaterial(raw)) throw new LongFormVisualQualityError(["FIXTURE_ONLY_MATERIAL: el archivo de curaduría contiene material de prueba; una solicitud real nunca lo usa"]);
  return VerifiedAssetRegistry.rehydrate(raw, { requestId, isAuthorizedCurator: (by) => isAuthorizedCurator(by), requestedContracts: contracts });
}
