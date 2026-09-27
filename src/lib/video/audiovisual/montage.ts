/**
 * Montaje del Reel dirigido: duración de planos, movimiento y transiciones
 * según intención, ritmo y energía de cada escena, sobre los tiempos REALES
 * de la narración (timestamps por palabra). Puro, sin I/O.
 *
 * Garantías (validadas por validateTimeline antes de renderizar):
 *  - Cobertura exacta: el primer plano empieza en 0 y el último termina en
 *    la duración final (voz + cola). Sin huecos ni solapes: cada plano
 *    termina donde empieza el siguiente (antes, un silencio largo entre
 *    escenas podía dejar fotogramas negros).
 *  - Los cortes internos de una escena caen entre palabras (en el hueco
 *    entre dos palabras) siempre que haya uno cerca, no a mitad de palabra.
 *  - Suspenso = anticipación y revelación, no solo lentitud: la escena
 *    previa a la revelación se sostiene en un solo plano con acercamiento
 *    lento, y la revelación entra por corte seco con impulso.
 *  - La narración nunca se estira ni se recorta: solo cambia el montaje.
 */
import type { ReelMotion } from "../../../../remotion/reel-motion";
import type { IntentId, PaceId } from "./catalog";
import type { SceneEnergy } from "./direction";

export const REEL_FPS = 30;

export type BeatBounds = { min: number; max: number };

/** Segundos por plano (Reel). Long Form tendrá su propia tabla de documental. */
export const REEL_BEAT_BOUNDS: Record<PaceId, Record<SceneEnergy, BeatBounds>> = {
  slow: { low: { min: 3.0, max: 5.2 }, medium: { min: 2.6, max: 4.4 }, high: { min: 1.8, max: 3.2 } },
  balanced: { low: { min: 2.4, max: 4.2 }, medium: { min: 1.8, max: 3.8 }, high: { min: 1.5, max: 2.8 } },
  dynamic: { low: { min: 1.8, max: 3.2 }, medium: { min: 1.4, max: 2.6 }, high: { min: 1.1, max: 2.0 } },
};

/** Fotogramas de fundido de entrada por intención (a 30 fps). 0 = corte seco. */
export const TRANSITION_FRAMES: Record<IntentId, number> = {
  suspense: 18,
  humor: 4,
  uplifting: 12,
  informative: 10,
  reflective: 22,
  action: 3,
};

const MOTION_CYCLE: Record<IntentId, ReelMotion[]> = {
  suspense: ["push_in_slow", "pan_left", "push_in_slow", "pan_right"],
  humor: ["punch_in", "pan_left", "push_in", "pan_right"],
  uplifting: ["push_in", "pan_right", "pull_out", "pan_left"],
  informative: ["push_in", "pan_left", "pull_out", "pan_right"],
  reflective: ["pull_out", "push_in_slow", "pan_right", "push_in_slow"],
  action: ["punch_in", "pan_right", "push_in", "pan_left"],
};

export type ShotRole = "hook" | "normal" | "anticipation" | "reveal";

export type PlannedShot = {
  sceneIndex: number;
  beatIndex: number;
  startSeconds: number;
  endSeconds: number;
  motion: ReelMotion;
  /** Fundido de entrada; el plano anterior se prolonga lo mismo por debajo. */
  transitionInFrames: number;
  role: ShotRole;
};

export type WordTime = { startSeconds: number; endSeconds: number };

/** Un plano nunca dura menos que esto, aunque la escena sea muy corta (evita parpadeos). */
export const MIN_SHOT_SECONDS = 0.9;
/** Distancia máxima a la que se busca un hueco entre palabras para alinear un corte. */
export const SNAP_WINDOW_SECONDS = 0.7;

/**
 * Tramos de escena contiguos que cubren [0, totalSeconds]: cada escena se
 * extiende hasta donde empieza la siguiente (silencios incluidos).
 */
export function coverScenes(sceneTimings: { start: number; end: number }[], totalSeconds: number): { start: number; end: number }[] {
  if (sceneTimings.length === 0) return [];
  const starts = sceneTimings.map((s, i) => (i === 0 ? 0 : Math.max(s.start, 0)));
  // Si los tiempos llegaran desordenados (palabras repetidas/omitidas), nunca retroceder.
  for (let i = 1; i < starts.length; i++) starts[i] = Math.max(starts[i], starts[i - 1]);
  return starts.map((start, i) => ({ start, end: i === starts.length - 1 ? Math.max(totalSeconds, start) : starts[i + 1] }));
}

function wordGapCandidates(words: WordTime[], start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i].endSeconds;
    const b = words[i + 1].startSeconds;
    const mid = (a + Math.max(a, b)) / 2;
    if (mid > start && mid < end) out.push(mid);
  }
  return out;
}

/** Reparte una escena en planos dentro de `bounds`, con cortes alineados a huecos entre palabras. */
export function splitSceneIntoShots(start: number, end: number, bounds: BeatBounds, words: WordTime[]): { start: number; end: number }[] {
  const duration = Math.max(0, end - start);
  if (duration <= bounds.max) return [{ start, end }];
  let count = Math.max(1, Math.round(duration / bounds.max));
  if (duration / count > bounds.max) count += 1;
  while (count > 1 && duration / count < bounds.min) count -= 1;
  const ideal = Array.from({ length: count - 1 }, (_, i) => start + ((i + 1) * duration) / count);
  const gaps = wordGapCandidates(words, start, end);
  const cuts: number[] = [];
  let prev = start;
  for (let i = 0; i < ideal.length; i++) {
    const target = ideal[i];
    const nextLimit = i + 1 < ideal.length ? ideal[i + 1] : end;
    const near = gaps
      .filter((g) => Math.abs(g - target) <= SNAP_WINDOW_SECONDS && g - prev >= MIN_SHOT_SECONDS && nextLimit - g >= MIN_SHOT_SECONDS)
      .sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
    const cut = near ?? target;
    cuts.push(cut);
    prev = cut;
  }
  const edges = [start, ...cuts, end];
  return edges.slice(0, -1).map((s, i) => ({ start: s, end: edges[i + 1] }));
}

/** Escenas de revelación en suspenso: energía alta tras una no alta; si no hay ninguna, la última (resolución). */
export function revealScenes(energy: SceneEnergy[]): Set<number> {
  const out = new Set<number>();
  for (let i = 1; i < energy.length; i++) if (energy[i] === "high" && energy[i - 1] !== "high") out.add(i);
  if (out.size === 0 && energy.length >= 2) out.add(energy.length - 1);
  return out;
}

export function planReelMontage(input: {
  intent: IntentId;
  pace: PaceId;
  sceneEnergy: SceneEnergy[];
  sceneTimings: { start: number; end: number }[];
  words: WordTime[];
  totalSeconds: number;
}): PlannedShot[] {
  const { intent, pace, sceneEnergy, words } = input;
  const scenes = coverScenes(input.sceneTimings, input.totalSeconds);
  const reveals = intent === "suspense" ? revealScenes(sceneEnergy) : new Set<number>();
  const anticipations = new Set([...reveals].map((i) => i - 1).filter((i) => i >= 0 && !reveals.has(i)));
  const baseTransition = TRANSITION_FRAMES[intent];
  const cycle = MOTION_CYCLE[intent];
  const shots: PlannedShot[] = [];
  let cycleIndex = 0;

  scenes.forEach((scene, sceneIndex) => {
    const energy = sceneEnergy[sceneIndex] ?? "medium";
    let bounds = REEL_BEAT_BOUNDS[pace][energy];
    if (anticipations.has(sceneIndex)) bounds = { min: bounds.min, max: bounds.max * 1.6 };
    if (reveals.has(sceneIndex)) bounds = REEL_BEAT_BOUNDS[pace].high;
    const parts = splitSceneIntoShots(scene.start, scene.end, bounds, words);
    parts.forEach((part, beatIndex) => {
      const first = shots.length === 0;
      let role: ShotRole = "normal";
      let motion: ReelMotion = cycle[cycleIndex++ % cycle.length];
      let transitionInFrames = first ? 0 : baseTransition;
      if (first) {
        role = "hook";
        motion = intent === "suspense" || intent === "reflective" ? "push_in" : "hook";
      } else if (reveals.has(sceneIndex) && beatIndex === 0) {
        role = "reveal";
        motion = "punch_in";
        transitionInFrames = 0;
      } else if (anticipations.has(sceneIndex) && beatIndex === parts.length - 1) {
        role = "anticipation";
        motion = "push_in_slow";
      }
      // El fundido nunca puede ocupar más de la mitad del plano anterior ni del propio.
      const prev = shots[shots.length - 1];
      if (prev) {
        const limit = Math.floor((Math.min(prev.endSeconds - prev.startSeconds, part.end - part.start) * REEL_FPS) / 2);
        transitionInFrames = Math.max(0, Math.min(transitionInFrames, limit));
      }
      shots.push({ sceneIndex, beatIndex, startSeconds: part.start, endSeconds: part.end, motion, transitionInFrames, role });
    });
  });
  return absorbShortShots(shots);
}

/** Una escena de una o dos palabras no merece un plano propio de medio segundo: se funde con la vecina. */
function absorbShortShots(shots: PlannedShot[]): PlannedShot[] {
  const out: PlannedShot[] = [];
  for (const shot of shots) {
    const prev = out[out.length - 1];
    if (prev && shot.endSeconds - shot.startSeconds < MIN_SHOT_SECONDS) {
      prev.endSeconds = shot.endSeconds;
      continue;
    }
    out.push({ ...shot });
  }
  if (out.length > 1 && out[0].endSeconds - out[0].startSeconds < MIN_SHOT_SECONDS) {
    const [first, second, ...rest] = out;
    return [{ ...second, startSeconds: first.startSeconds, role: "hook", transitionInFrames: 0 }, ...rest];
  }
  return out;
}

export type TimelineIssue = { code: "empty" | "start" | "end" | "gap" | "overlap" | "too_short"; index?: number; detail: string };

/** Comprueba la cobertura exacta del audio aprobado antes de gastar en el render. */
export function validateTimeline(shots: { startSeconds: number; endSeconds: number }[], totalSeconds: number): TimelineIssue[] {
  const issues: TimelineIssue[] = [];
  const eps = 1e-6;
  if (shots.length === 0) return [{ code: "empty", detail: "sin planos" }];
  if (Math.abs(shots[0].startSeconds) > eps) issues.push({ code: "start", detail: `el primer plano empieza en ${shots[0].startSeconds}s` });
  const last = shots[shots.length - 1];
  if (Math.abs(last.endSeconds - totalSeconds) > eps) issues.push({ code: "end", detail: `el último plano termina en ${last.endSeconds}s de ${totalSeconds}s` });
  shots.forEach((s, i) => {
    if (s.endSeconds - s.startSeconds < Math.min(MIN_SHOT_SECONDS, totalSeconds) - eps) {
      issues.push({ code: "too_short", index: i, detail: `plano de ${(s.endSeconds - s.startSeconds).toFixed(2)}s` });
    }
    const next = shots[i + 1];
    if (!next) return;
    if (next.startSeconds - s.endSeconds > eps) issues.push({ code: "gap", index: i, detail: `hueco de ${(next.startSeconds - s.endSeconds).toFixed(2)}s` });
    if (s.endSeconds - next.startSeconds > eps) issues.push({ code: "overlap", index: i, detail: `solape de ${(s.endSeconds - next.startSeconds).toFixed(2)}s` });
  });
  return issues;
}

/**
 * Duración mínima que debe tener un clip de video para un plano: su
 * duración + el fundido con el que el SIGUIENTE plano entra por encima +
 * margen. Así un clip corto nunca se congela en su último fotograma.
 */
export function minimumClipSeconds(shots: PlannedShot[], index: number): number {
  const shot = shots[index];
  const nextFade = shots[index + 1]?.transitionInFrames ?? 0;
  return shot.endSeconds - shot.startSeconds + nextFade / REEL_FPS + 0.3;
}

/** Encuadres alternos para repetir la imagen de una escena en varios planos (ilustración) sin que se vea congelada. */
export function framingForBeat(beatIndex: number): { scale: number; originX: number; originY: number } | undefined {
  const table = [undefined, { scale: 1.3, originX: 0.5, originY: 0.35 }, { scale: 1.4, originX: 0.3, originY: 0.6 }, { scale: 1.35, originX: 0.7, originY: 0.5 }];
  return table[beatIndex % table.length];
}

/**
 * Mezcla por intención: la música siempre queda DEBAJO de la narración
 * (VerticalReel nunca permite superar AUDIO_MIX) y en suspenso/emotivo sube
 * menos y más despacio en los silencios, para no crear sustos de volumen.
 */
export function mixLevelsFor(intent: IntentId): { underVoice?: number; duringSilence?: number; duckTransitionSeconds?: number } | undefined {
  if (intent === "suspense") return { underVoice: 0.09, duringSilence: 0.22, duckTransitionSeconds: 0.8 };
  if (intent === "reflective") return { duringSilence: 0.28, duckTransitionSeconds: 0.7 };
  return undefined;
}
