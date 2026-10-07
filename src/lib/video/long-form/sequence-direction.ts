/**
 * Plan v5: de la secuencia EJECUTABLE (sequence-intent.ts) a planos, y de los
 * planos ejecutados a dirección del renderer. Se encaja en el pipeline
 * existente; no hay otro:
 *
 *   resolveSequences → sequenceShotsForSpan (en lugar del reparto de 3–8 s por duración)
 *   → allocateShotTypes → executeShot (selector + registro verificado, SIN cambios)
 *   → buildVisualReport/directCinematic (verdad, procedencia, QA, SIN cambios)
 *   → directAnchoredScenes (SIN cambios) → directSequenceScenes (escala/encuadre por rol) → LongFormDoc.
 *
 * directSequenceScenes solo cambia la PRESENTACIÓN: nunca el recurso, su
 * procedencia, su crédito ni una carencia.
 */
import type { WordTiming } from "@/lib/providers/types";
import type { LongFormCuratedSvgGraphic, LongFormShotScene } from "../../../../remotion/LongFormDoc";
import type { ShotDirection } from "../../../../remotion/long-form-direction";
import type { Shot, ShotType } from "./types";
import type { ShotExecution } from "./shot-executor";
import { fragmentForRange, intentWordSpans, narrationWords } from "./scene-anchoring";
import type { ProductionPlanBeatInput } from "./production-plan";
import { LONG_FORM_NARRATION_WORDS_PER_SECOND } from "./duration-budget";
import { productMotion } from "./shots";
import type { DetailRegion, ExecutableSequence, ResolvedSlot, SequenceRole, ShotScale, SlotStatus } from "./sequence-intent";

export type SequenceSlotRef = {
  sequenceId: string;
  sequenceIndex: number;
  index: number;
  role: SequenceRole;
  scale: ShotScale;
  scaleReason: string;
  status: SlotStatus;
  /** Primer plano de su secuencia (frontera: único sitio con fundido). */
  opensSequence: boolean;
  detail?: { of: number; region: DetailRegion };
  slug?: { year?: string; place?: string };
};

/** Planos de UN beat a partir de los roles resueltos (no del reparto por duración). Un DETAIL descartado no se emite: el anterior se sostiene. */
export function sequenceShotsForSpan(input: {
  beatId: string;
  startSec: number;
  endSec: number;
  narration: string;
  /** Tiempos reales por palabra RELATIVOS al inicio del beat (ejecución); sin ellos, reparto proporcional (plan). */
  words?: WordTiming[];
  sequences: ExecutableSequence[];
}): Shot[] {
  const slots: { slot: ResolvedSlot; sequenceIndex: number; slug?: ExecutableSequence["slug"] }[] = [];
  input.sequences.forEach((seq, sequenceIndex) => {
    const live = seq.slots.filter((s) => s.status !== "DROPPED");
    for (const slot of live) {
      if (slot.beatId === input.beatId) slots.push({ slot, sequenceIndex, ...(live[0] === slot && seq.slug ? { slug: seq.slug } : {}) });
    }
  });
  if (slots.length === 0) return [];
  const spans = intentWordSpans(input.narration, slots.map((s) => s.slot.visual));
  const total = narrationWords(input.narration).length;
  const span = input.endSec - input.startSec;
  const tokens = input.words && input.words.length > 0 ? input.words : undefined;
  const scale = tokens ? tokens.length / Math.max(1, total) : 1;
  const timeAt = (wordIndex: number) => {
    if (wordIndex <= 0) return input.startSec;
    if (wordIndex >= total) return input.endSec;
    if (tokens) return input.startSec + tokens[Math.min(tokens.length - 1, Math.floor(wordIndex * scale))].startSeconds;
    return input.startSec + (wordIndex / total) * span;
  };
  const order = slots.map((_, i) => i).sort((a, b) => spans[a].start - spans[b].start);
  return order.map((i, k) => {
    const { slot, sequenceIndex, slug } = slots[i];
    const start = k === 0 ? input.startSec : timeAt(spans[i].start);
    const end = k === order.length - 1 ? input.endSec : timeAt(spans[order[k + 1]].start);
    const range = { first: spans[i].start, last: Math.max(spans[i].start, spans[i].end - 1) };
    const fragment = fragmentForRange(input.narration, tokens ? { first: Math.floor(range.first * scale), last: Math.floor(range.last * scale) } : range, tokens) || input.narration;
    // TRANSITION es tipo (tarjeta); todo lo demás es imagen y lo decide el selector/registro (que rechazan dobles y falsos amigos).
    const type: ShotType = slot.status === "CARD" ? "text" : "ken_burns_image";
    const opensSequence = slot === input.sequences[sequenceIndex].slots.find((s) => s.status !== "DROPPED");
    return {
      id: `${input.beatId}-${slot.sequenceId}-${slot.index + 1}`,
      beatId: input.beatId,
      startSec: round3(start),
      endSec: round3(end),
      durationSec: round3(end - start),
      type,
      source: type === "text" ? "local" : "stock",
      assetId: `${input.beatId}-${slot.sequenceId}-${slot.index}`,
      visualIntent: slot.visual.description,
      motionRequired: slot.visual.motion || undefined,
      motion: productMotion(type),
      captionText: fragment,
      narrationFragment: fragment,
      anchoredVisual: slot.visual,
      intentAnchor: { visualIndex: slot.index, reuseIndex: 0, anchoredBy: spans[i].anchoredBy },
      license: "resolved-at-execution",
      attribution: "",
      dedupKey: `${input.beatId}:${slot.sequenceId}:${slot.index}`,
      status: "planned",
      validationStatus: "pending",
      sequenceSlot: {
        sequenceId: slot.sequenceId,
        sequenceIndex,
        index: slot.index,
        role: slot.role,
        scale: slot.scale,
        scaleReason: slot.scaleReason,
        status: slot.status,
        opensSequence,
        ...(slot.detail ? { detail: slot.detail } : {}),
        ...(slug ? { slug } : {}),
      },
    } satisfies Shot;
  });
}

/** Planos ESTIMADOS de un guion v5 (misma forma que planShotsFromScript; para el plan y el preflight). */
export function planSequenceShots(beats: ProductionPlanBeatInput[], sequences: ExecutableSequence[]): { shots: Shot[]; narrationSeconds: number } {
  let cursor = 0;
  const shots: Shot[] = [];
  for (const beat of beats) {
    const startSec = cursor;
    // Mismo ritmo calibrado que estimateNarrationSeconds (production-plan.ts), sin importarlo (evita el ciclo).
    const endSec = cursor + Math.max(1, beat.narration.trim().split(/\s+/).filter(Boolean).length / LONG_FORM_NARRATION_WORDS_PER_SECOND);
    cursor = endSec;
    shots.push(...sequenceShotsForSpan({ beatId: beat.id, startSec, endSec, narration: beat.narration, sequences }));
  }
  return { shots, narrationSeconds: cursor };
}

const SEQUENCE_DISSOLVE_SEC = 0.3;
/** Encuadre de un MEDIUM sin región "subject" curada: un tercio fijo (composición), nunca un detalle inventado. */
const MEDIUM_DEFAULT_FOCUS = { x: 0.42, y: 0.4 };

/**
 * Dirección v5 por ROL, sobre escenas que ya pasaron por la verdad (directAnchoredScenes):
 * mismo recurso, misma procedencia, mismo crédito, misma carencia. Cortes secos;
 * fundido corto solo en una frontera real de secuencia.
 */
export function directSequenceScenes(
  scenes: LongFormShotScene[],
  shots: Pick<Shot, "sequenceSlot" | "narrationFragment">[],
  executions: Pick<ShotExecution, "assetMeta">[],
  opts: {
    /** GEOGRAPHY: escena de revelado del SVG CURADO de esta escena (curatedSvgGraphic), o null. */
    geography?: (sceneIndex: number) => LongFormCuratedSvgGraphic | null;
  } = {},
): LongFormShotScene[] {
  return scenes.map((scene, i) => {
    const slot = shots[i]?.sequenceSlot;
    if (!slot) return scene;
    const provenance = executions[i]?.assetMeta?.provenance;
    const regions = provenance?.kind === "archival_documentary" ? (provenance.regions ?? []) : [];
    const transition = slot.opensSequence && slot.sequenceIndex > 0 ? { type: "dissolve" as const, seconds: SEQUENCE_DISSOLVE_SEC } : { type: "cut" as const };
    const look = scene.direction?.look ? { ...(scene.direction.look.preset ? { preset: scene.direction.look.preset } : {}), ...(scene.direction.look.contrast !== undefined ? { contrast: scene.direction.look.contrast } : {}) } : undefined;
    const keepLook = look && Object.keys(look).length > 0 ? { look } : {};
    const year = slot.slug?.year ?? /\b(1[5-9]\d\d|20\d\d)\b/.exec(shots[i]?.narrationFragment ?? "")?.[1];
    let shot: ShotDirection;
    let asset = scene.asset;
    if (scene.asset.kind === "graphic") {
      // Ausencia DIRIGIDA: la misma tarjeta veraz, con la tipografía de la película (no una plantilla).
      shot = { role: slot.role, scale: "WIDE", card: { ...(year ? { year } : {}) } };
    } else if (slot.role === "GEOGRAPHY" && opts.geography?.(i)) {
      asset = { kind: "graphic", graphic: opts.geography(i)! };
      shot = { role: "GEOGRAPHY", scale: "WIDE" };
    } else if (slot.scale === "DETAIL") {
      const region = regions.find((r) => r.label === slot.detail?.region);
      shot =
        region && provenance?.sourceWidth && provenance.sourceHeight
          ? { role: slot.role, scale: "DETAIL", region: { ...region }, sourceWidth: provenance.sourceWidth, sourceHeight: provenance.sourceHeight }
          : // Sin la región curada en el recurso EJECUTADO: plano general verdadero, nunca un recorte arbitrario.
            { role: slot.role, scale: "WIDE", wide: "field" };
    } else if (slot.scale === "MEDIUM") {
      const subject = regions.find((r) => r.label === "subject");
      shot = { role: slot.role, scale: "MEDIUM", focus: subject ? { x: subject.x + subject.w / 2, y: subject.y + subject.h / 2 } : MEDIUM_DEFAULT_FOCUS };
    } else {
      shot = { role: slot.role, scale: "WIDE", wide: "field" };
    }
    if (slot.slug && (slot.slug.year || slot.slug.place)) shot = { ...shot, slug: slot.slug };
    return {
      ...scene,
      asset,
      motion: "static",
      direction: { ...(scene.direction?.mediaStartSeconds !== undefined ? { mediaStartSeconds: scene.direction.mediaStartSeconds } : {}), transition, camera: shot.scale === "MEDIUM" ? "push" : "still", ...keepLook, shot },
    };
  });
}

export type SequenceDirectionFinding = { code: "IDENTICAL_PUSH_RUN" | "NO_SCALE_CONTRAST"; detail: string; scenes: string[] };

/**
 * Lo que mira un humano al pausar: tres empujes idénticos seguidos, o una
 * secuencia con varias imágenes y ninguna corte entre escalas distintas.
 * Diagnóstico (no una cuota): la escala sigue a la narración, no a la variedad.
 */
export function sequenceDirectionFindings(scenes: LongFormShotScene[], shots: Pick<Shot, "sequenceSlot">[]): SequenceDirectionFinding[] {
  const findings: SequenceDirectionFinding[] = [];
  const key = (s: LongFormShotScene) => {
    if (s.asset.kind !== "media") return null;
    const d = s.direction;
    const shot = d?.shot;
    if (shot) return `${shot.scale}|${d?.camera}|${shot.focus?.x ?? "c"},${shot.focus?.y ?? "c"}`;
    // Sin dirección v5: el empuje/paneo de v4 (o el Ken Burns por defecto) sobre el centro del cuadro.
    return `${d?.document ? "document" : (d?.camera ?? s.motion)}|${d?.look?.originX ?? "c"},${d?.look?.originY ?? "c"}|${d?.look?.scale ?? 1}`;
  };
  let run: string[] = [];
  let last: string | null = null;
  const flush = () => {
    if (run.length >= 3) findings.push({ code: "IDENTICAL_PUSH_RUN", detail: `${run.length} planos idénticos seguidos`, scenes: [...run] });
  };
  for (const s of scenes) {
    const k = key(s);
    if (k && k === last && !k.includes("still") && !k.startsWith("WIDE")) run.push(s.id);
    else {
      flush();
      run = k && !k.includes("still") ? [s.id] : [];
    }
    last = k;
  }
  flush();
  const bySequence = new Map<string, LongFormShotScene[]>();
  scenes.forEach((s, i) => {
    const seq = shots[i]?.sequenceSlot?.sequenceId;
    if (seq) bySequence.set(seq, [...(bySequence.get(seq) ?? []), s]);
  });
  for (const [seq, list] of bySequence) {
    const media = list.filter((s) => s.asset.kind === "media" || (s.asset.kind === "graphic" && s.asset.graphic.kind === "curated_svg"));
    if (media.length < 2) continue;
    const contrast = media.some((s, k) => k > 0 && s.direction?.shot?.scale !== media[k - 1].direction?.shot?.scale && s.direction?.transition?.type !== "dissolve");
    if (!contrast) findings.push({ code: "NO_SCALE_CONTRAST", detail: `${seq}: ningún corte entre escalas distintas`, scenes: media.map((s) => s.id) });
  }
  return findings;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
