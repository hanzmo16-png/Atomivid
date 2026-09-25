/**
 * Manifiesto de una MUESTRA de calidad (M2): escenas con su recurso
 * elegido, procedencia, revisión visual, dirección de montaje y pistas de
 * sonido. Genérico (no específico de Panamá): la herramienta
 * scripts/long-form-quality-sample.ts lo resuelve y renderiza.
 *
 * Aquí solo validación PURA (sin red): continuidad, cortes que no parten
 * palabras, unicidad de recursos, revisión pendiente y duración de clips.
 */
import type { SceneDirection } from "../../../../remotion/long-form-direction";
import type { SceneProvenance } from "../../../../remotion/long-form-card-fit";
import { cutsThroughWord } from "./scene-anchoring";

export type SampleSource =
  | { kind: "pexels-video"; id: number }
  | { kind: "pexels-photo"; id: number }
  | { kind: "commons"; title: string; crop?: { x0: number; y0: number; x1: number; y1: number } }
  | { kind: "data-map"; spec: string; geo: string }
  | { kind: "existing"; path: string };

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

const sourceKey = (s: SampleSource): string =>
  s.kind === "pexels-video" || s.kind === "pexels-photo" ? `${s.kind}:${s.id}` : s.kind === "commons" ? `commons:${s.title}` : s.kind === "data-map" ? `map:${s.spec}` : `existing:${s.path}`;

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
    const key = sourceKey(scene.source);
    const prior = seen.get(key);
    if (prior) issues.push({ sceneId: scene.id, code: "duplicate", message: `mismo recurso que ${prior} (${key})` });
    else seen.set(key, scene.id);
    if (scene.review.status !== "approved") issues.push({ sceneId: scene.id, code: "pending_review", message: scene.review.note || "revisión pendiente" });
    if (scene.provenance === "ai_recreation" && scene.source.kind !== "existing") {
      issues.push({ sceneId: scene.id, code: "ai_source", message: "una recreación IA debe venir de un recurso ya generado y registrado" });
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
