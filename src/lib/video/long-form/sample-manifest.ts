/**
 * Manifiesto de una MUESTRA de calidad (M2): escenas con su recurso
 * elegido, procedencia, revisión visual, dirección de montaje y pistas de
 * sonido. Genérico (no específico de Panamá): la herramienta
 * scripts/long-form-quality-sample.ts lo resuelve y renderiza.
 *
 * Aquí solo validación PURA (sin red): continuidad, cortes que no parten
 * palabras, unicidad de recursos, revisión pendiente y duración de clips.
 *
 * M3: una escena puede pedir un clip de video IA (`veo-clip`, image-to-video
 * a partir de una fotografía de archivo o de una imagen IA nueva). Es
 * SELECTIVO (solo las escenas que lo declaran) y de pago: el plan de gasto
 * y el libro de reservas son puros aquí; la herramienta solo genera con
 * autorización explícita y presupuesto aprobado. Sin autorización se monta
 * el `placeholder` gratuito, marcado como pendiente.
 */
import type { SceneDirection } from "../../../../remotion/long-form-direction";
import type { SceneProvenance } from "../../../../remotion/long-form-card-fit";
import { cutsThroughWord } from "./scene-anchoring";

export type SampleCrop = { x0: number; y0: number; x1: number; y1: number };

export type FreeSampleSource =
  | { kind: "pexels-video"; id: number }
  | { kind: "pexels-photo"; id: number }
  | { kind: "commons"; title: string; crop?: SampleCrop }
  | { kind: "data-map"; spec: string; geo: string }
  | { kind: "existing"; path: string };

/** Imagen de partida del clip IA: una fotografía de archivo (gratis) o una imagen IA nueva (de pago). */
export type VeoReference =
  | { kind: "commons"; title: string; crop?: SampleCrop }
  | { kind: "ai-still"; prompt: string; negativePrompt?: string };

export type VeoClipSource = {
  kind: "veo-clip";
  /** Clave de idempotencia: nunca se reenvía la misma clave; un reintento deliberado usa una clave nueva. */
  key: string;
  reference: VeoReference;
  prompt: string;
  negativePrompt?: string;
  /** Lo que se monta mientras el clip no exista (sin gasto aprobado): recurso gratuito con su procedencia REAL. */
  placeholder: { source: FreeSampleSource; provenance: SceneProvenance; creditText?: string; camera?: SceneDirection["camera"] };
};

export type SampleSource = FreeSampleSource | VeoClipSource;

export type SampleScene = {
  id: string;
  startSeconds: number;
  endSeconds: number;
  /** Fragmento narrado durante la escena (comprobado contra los tiempos reales). */
  narration: string;
  source: SampleSource;
  provenance: SceneProvenance;
  creditText?: string;
  fit?: "cover" | "contain";
  direction: SceneDirection;
  /** Repetición DELIBERADA del recurso de la escena inmediatamente anterior (p. ej. la foto que el clip IA animó). */
  repeatOf?: string;
  review: {
    status: "approved" | "pending";
    relevance: "directa" | "indirecta";
    note: string;
  };
};

export type SampleSoundCue = {
  id: string;
  /** id de la pista en src/lib/providers/music/manifest.ts (procedencia y licencia registradas). */
  track: string;
  role: "music" | "ambience" | "effect";
  startSeconds: number;
  endSeconds: number;
  sourceStartSeconds?: number;
  gain?: number;
  fadeInSeconds?: number;
  fadeOutSeconds?: number;
  loop?: boolean;
};

export type SampleManifest = {
  requestId: string;
  beats: string[];
  tailSeconds: number;
  outputPrefix: string;
  scenes: SampleScene[];
  soundCues: SampleSoundCue[];
  /** Recursos sonoros que faltan (se reportan; nunca se sustituyen por tonos de prueba). */
  missingSound: string[];
};

export type ManifestIssue = { sceneId: string; code: string; message: string };

const freeKey = (s: FreeSampleSource): string =>
  s.kind === "pexels-video" || s.kind === "pexels-photo" ? `${s.kind}:${s.id}` : s.kind === "commons" ? `commons:${s.title}` : s.kind === "data-map" ? `map:${s.spec}` : `existing:${s.path}`;

/** Recursos que una escena pone en pantalla (un clip IA cuenta también la foto de archivo que anima). */
const sourceKeys = (s: SampleSource): string[] =>
  s.kind === "veo-clip" ? [`veo:${s.key}`, ...(s.reference.kind === "commons" ? [`commons:${s.reference.title}`] : [])] : [freeKey(s)];

/** Duración fija de un clip de Veo a 1080p (ver src/lib/providers/video-gen/veo.ts). */
export const VEO_CLIP_SECONDS = 8;

/** Duración que debe cubrir un clip: offset + escena + cola del fundido de la escena SIGUIENTE. */
export function requiredClipSeconds(scenes: SampleScene[], index: number): number {
  const scene = scenes[index];
  const next = scenes[index + 1];
  const tail = next?.direction.transition?.type === "dissolve" ? (next.direction.transition.seconds ?? 0.3) : 0;
  return (scene.direction.mediaStartSeconds ?? 0) + (scene.endSeconds - scene.startSeconds) + tail;
}

export function validateSampleManifest(
  manifest: SampleManifest,
  words: { text: string; startSeconds: number; endSeconds: number }[],
  narrationEndSeconds: number,
): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  const scenes = manifest.scenes;
  if (scenes.length === 0) return [{ sceneId: "*", code: "empty", message: "sin escenas" }];
  if (Math.abs(scenes[0].startSeconds) > 1e-6) issues.push({ sceneId: scenes[0].id, code: "start", message: "la primera escena no empieza en 0" });
  const expectedEnd = narrationEndSeconds + manifest.tailSeconds;
  const last = scenes[scenes.length - 1];
  if (Math.abs(last.endSeconds - expectedEnd) > 0.05) {
    issues.push({ sceneId: last.id, code: "end", message: `termina en ${last.endSeconds} s; la narración + cola termina en ${expectedEnd.toFixed(3)} s` });
  }
  const seen = new Map<string, string>();
  for (const [i, scene] of scenes.entries()) {
    if (scene.endSeconds <= scene.startSeconds) issues.push({ sceneId: scene.id, code: "duration", message: "duración no positiva" });
    if (i > 0 && Math.abs(scenes[i - 1].endSeconds - scene.startSeconds) > 1e-6) {
      issues.push({ sceneId: scene.id, code: "contiguity", message: `hueco o solape con ${scenes[i - 1].id}` });
    }
    if (i > 0 && cutsThroughWord(scene.startSeconds, words)) {
      issues.push({ sceneId: scene.id, code: "cut_in_word", message: `el corte en ${scene.startSeconds} s parte una palabra` });
    }
    if (scene.repeatOf !== undefined && scenes[i - 1]?.id !== scene.repeatOf) {
      issues.push({ sceneId: scene.id, code: "repeat_not_adjacent", message: `repeatOf «${scene.repeatOf}» debe ser la escena inmediatamente anterior` });
    }
    for (const key of sourceKeys(scene.source)) {
      const prior = seen.get(key);
      if (prior && !(prior === scene.repeatOf && scenes[i - 1]?.id === prior)) {
        issues.push({ sceneId: scene.id, code: "duplicate", message: `mismo recurso que ${prior} (${key})` });
      } else if (!prior) seen.set(key, scene.id);
    }
    if (scene.review.status !== "approved") issues.push({ sceneId: scene.id, code: "pending_review", message: scene.review.note || "revisión pendiente" });
    if (scene.provenance === "ai_recreation" && scene.source.kind !== "existing" && scene.source.kind !== "veo-clip") {
      issues.push({ sceneId: scene.id, code: "ai_source", message: "una recreación IA debe venir de un recurso ya generado y registrado, o de un clip IA declarado" });
    }
    if (scene.source.kind === "veo-clip") {
      const src = scene.source;
      if (scene.provenance !== "ai_recreation") {
        issues.push({ sceneId: scene.id, code: "ai_unlabeled", message: "un clip IA siempre se rotula «Recreación IA» (procedencia ai_recreation)" });
      }
      if (!src.prompt.trim() || (src.reference.kind === "ai-still" && !src.reference.prompt.trim())) {
        issues.push({ sceneId: scene.id, code: "ai_prompt", message: "prompt vacío" });
      }
      if (src.placeholder.provenance === "ai_recreation") {
        issues.push({ sceneId: scene.id, code: "placeholder_ai", message: "el sustituto gratuito no puede ser otra recreación IA" });
      }
      const needed = requiredClipSeconds(scenes, i);
      if (needed > VEO_CLIP_SECONDS + 1e-6) {
        issues.push({ sceneId: scene.id, code: "clip_too_short", message: `el clip IA dura ${VEO_CLIP_SECONDS} s y la escena necesita ${needed.toFixed(2)} s` });
      }
    }
    // El fragmento declarado debe coincidir con lo que realmente se narra en la escena.
    const spoken = words
      .filter((w) => (w.startSeconds + w.endSeconds) / 2 >= scene.startSeconds && (w.startSeconds + w.endSeconds) / 2 < scene.endSeconds)
      .map((w) => w.text)
      .join(" ");
    const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (norm(spoken) !== norm(scene.narration)) {
      issues.push({ sceneId: scene.id, code: "narration_mismatch", message: `se narra «${spoken}», el manifiesto dice «${scene.narration}»` });
    }
  }
  for (const cue of manifest.soundCues) {
    if (cue.startSeconds < 0 || cue.endSeconds > expectedEnd + 1e-6 || cue.endSeconds <= cue.startSeconds) {
      issues.push({ sceneId: cue.id, code: "cue_timing", message: "pista fuera de la duración de la muestra" });
    }
  }
  return issues;
}

/** Issues que bloquean CUALQUIER render (no solo el de aprobación). */
export function blockingIssues(issues: ManifestIssue[]): ManifestIssue[] {
  return issues.filter((i) => i.code !== "pending_review");
}

// --- Gasto de pago (M3): plan y libro de reservas, puros ---

export type PaidRates = { imageUsd: number; veoClipUsd: number };

export type PaidItem = {
  /** Clave de idempotencia del gasto (`<veoKey>:still` / `<veoKey>:veo`). */
  key: string;
  sceneId: string;
  provider: "openai-image" | "veo";
  estimateUsd: number;
  prompt: string;
};

/** Todo lo que la muestra pagaría si no existiera nada generado: una imagen por referencia IA y un clip por escena IA. */
export function paidPlan(manifest: SampleManifest, rates: PaidRates): PaidItem[] {
  const items: PaidItem[] = [];
  for (const scene of manifest.scenes) {
    if (scene.source.kind !== "veo-clip") continue;
    const src = scene.source;
    if (src.reference.kind === "ai-still") {
      items.push({ key: `${src.key}:still`, sceneId: scene.id, provider: "openai-image", estimateUsd: rates.imageUsd, prompt: src.reference.prompt });
    }
    items.push({ key: `${src.key}:veo`, sceneId: scene.id, provider: "veo", estimateUsd: rates.veoClipUsd, prompt: src.prompt });
  }
  return items;
}

export type PaidLedgerEntry = {
  key: string;
  sceneId: string;
  provider: PaidItem["provider"];
  /** reserved: reservado antes de llamar (cuenta como gastado hasta liquidar); spent: costo real; failed: sin resultado, pero puede haberse cobrado. */
  status: "reserved" | "spent" | "failed";
  estimateUsd: number;
  actualUsd?: number;
  providerJobId?: string;
  note?: string;
  reservedAtIso: string;
  settledAtIso?: string;
};

export type PaidLedger = { entries: PaidLedgerEntry[] };

export class PaidBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaidBudgetError";
  }
}

/** Comprometido: lo gastado real + lo reservado o fallido por su estimación (un fallo tras enviar puede haberse cobrado). */
export function committedUsd(ledger: PaidLedger): number {
  return +ledger.entries.reduce((sum, e) => sum + (e.status === "spent" ? (e.actualUsd ?? e.estimateUsd) : e.estimateUsd), 0).toFixed(4);
}

/**
 * Reserva ANTES de llamar al proveedor. Nunca dos veces la misma clave
 * (un reintento deliberado usa otra clave) y nunca por encima del
 * presupuesto aprobado acumulado entre ejecuciones.
 */
export function reservePaid(ledger: PaidLedger, item: PaidItem, budgetUsd: number, nowIso: string): PaidLedger {
  if (ledger.entries.some((e) => e.key === item.key)) {
    throw new PaidBudgetError(`«${item.key}» ya tiene una reserva: nunca se reenvía la misma generación (usa una clave nueva para un reintento aprobado)`);
  }
  const after = committedUsd(ledger) + item.estimateUsd;
  if (after > budgetUsd + 1e-9) {
    throw new PaidBudgetError(`«${item.key}» ($${item.estimateUsd.toFixed(2)}) excede el presupuesto aprobado: comprometido $${committedUsd(ledger).toFixed(2)} de $${budgetUsd.toFixed(2)}`);
  }
  return {
    entries: [...ledger.entries, { key: item.key, sceneId: item.sceneId, provider: item.provider, status: "reserved", estimateUsd: item.estimateUsd, reservedAtIso: nowIso }],
  };
}

export function settlePaid(
  ledger: PaidLedger,
  key: string,
  outcome: { status: "spent" | "failed"; actualUsd?: number; providerJobId?: string; note?: string },
  nowIso: string,
): PaidLedger {
  if (!ledger.entries.some((e) => e.key === key && e.status === "reserved")) throw new PaidBudgetError(`«${key}» no tiene una reserva abierta`);
  return {
    entries: ledger.entries.map((e) => (e.key === key && e.status === "reserved" ? { ...e, ...outcome, settledAtIso: nowIso } : e)),
  };
}
