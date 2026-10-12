/**
 * Director → existing VerticalReel render: an explicit, reviewable bridge (chatgpt-26). NOT wired into production:
 * nothing in the app or the render worker imports it (a test enforces this); only tests and the local synthetic
 * harness call it. It never selects, buys or generates material, and never authorises spend: the Director plan stays
 * `proposal / executable=false / paidCalls=0`, and the caller must hand over media that ALREADY exists.
 *
 * Contract:
 *  - input: the validated Director plan + its Director input + the catalog, the media that already exists per asset id
 *    (url, still/video, licence), the segment timings measured on the real narration, the narration audio and captions;
 *  - output: either `VerticalReelProps` for the existing composition, or a list of blockers. Nothing is filled in.
 * Blockers (never silently patched): any audit issue once real licences are applied; material that is missing or would
 * have to be created (`needs_new` — no budget is authorised here); a shot that promises real motion with a still; an AI
 * recreation whose required label the VerticalReel cannot display; timings that do not cover the narration.
 */
import type { Caption, Scene, VerticalReelProps } from "../../../../remotion/VerticalReel";
import { LABEL_TEXT, type SceneDirection, type SceneMotion, type SceneTransitionIn, type SceneTransitionOut } from "../../../../remotion/reel-direction";
import { auditPlan, type Issue } from "./audit";
import { DirectorInputSchema, DirectorPlanSchema, type DirectorInputRaw, type RecipeCatalog } from "./contract";

export type ExistingMedia = { url: string; mediaType: "image" | "video"; license: "CLEARED" | "NEEDS_REVIEW" | "NOT_CLEARED" };
export type BridgeBlocker = { code: string; shotId?: string; detail: string };
export type BridgeInput = {
  plan: unknown;
  input: DirectorInputRaw;
  catalog: RecipeCatalog;
  /** Media that already exists, by Director asset id. Missing ids are blockers. */
  media: Record<string, ExistingMedia>;
  /** Segment timings measured on the real narration (e.g. alignScenesToWords), by segment id. */
  segmentTimes: Record<string, { start: number; end: number }>;
  audioUrl: string;
  captions: Caption[];
  durationSeconds: number;
  narrationGaps?: VerticalReelProps["narrationGaps"];
};
/** What the plan asked for vs what the VerticalReel really applies, per shot (unsupported properties are declared). */
export type ShotApplication = {
  shotId: string; anchorText: string; recipeId: string | null;
  planned: { movement: string; transitionIn: string | null; transitionOut: string | null; label: string | null; shotType: string; composition: string | null };
  applied: { motion: SceneMotion; transitionIn: SceneTransitionIn; transitionOut: SceneTransitionOut; label: string | null; startSeconds: number; endSeconds: number };
  unsupported: string[];
};
export type BridgeResult =
  | { ok: true; props: VerticalReelProps; paidCalls: 0; shots: { shotId: string; assetId: string; mediaType: Scene["mediaType"]; label: string | null }[]; applied: ShotApplication[] }
  | { ok: false; paidCalls: 0; blockers: BridgeBlocker[] };

const EPS = 0.05;

export function planToVerticalReel(b: BridgeInput): BridgeResult {
  const blockers: BridgeBlocker[] = [];
  const parsedPlan = DirectorPlanSchema.safeParse(b.plan);
  const parsedInput = DirectorInputSchema.safeParse(b.input);
  if (!parsedPlan.success || !parsedInput.success) {
    return { ok: false, paidCalls: 0, blockers: [{ code: "CONTRACT_INVALID", detail: !parsedPlan.success ? "plan inválido" : "entrada inválida" }] };
  }
  const plan = parsedPlan.data;
  if (parsedInput.data.aspect !== "9:16") blockers.push({ code: "ASPECT_MISMATCH", detail: "VerticalReel es 9:16" });
  // Times must be finite and non-negative before any comparison: NaN/±Infinity make comparisons silently false.
  const finite = (x: number) => Number.isFinite(x) && x >= 0;
  if (!finite(b.durationSeconds) || b.durationSeconds <= 0) blockers.push({ code: "INVALID_TIME", detail: `durationSeconds no válido: ${b.durationSeconds}` });
  for (const [id, t] of Object.entries(b.segmentTimes)) {
    if (!finite(t.start) || !finite(t.end) || !(t.end > t.start)) blockers.push({ code: "INVALID_TIME", detail: `segmentTimes.${id} no válido: ${t.start}..${t.end}` });
  }
  b.captions.forEach((c, i) => {
    if (!finite(c.startSeconds) || !finite(c.endSeconds) || c.endSeconds < c.startSeconds) blockers.push({ code: "INVALID_TIME", detail: `caption ${i} no válido: ${c.startSeconds}..${c.endSeconds}` });
  });
  if (blockers.some(x => x.code === "INVALID_TIME")) return { ok: false, paidCalls: 0, blockers };

  // Licences come from the media that really exists, never from the plan; the gate is re-run with them.
  const licensed: DirectorInputRaw = { ...b.input, inventory: b.input.inventory.map(a => (b.media[a.id] ? { ...a, license: b.media[a.id].license } : a)) };
  const audit = auditPlan(plan, licensed, b.catalog);
  for (const i of audit.issues as Issue[]) blockers.push({ code: `AUDIT_${i.code}`, shotId: i.shotId, detail: i.detail });

  const scenes: Scene[] = [];
  const shots: Extract<BridgeResult, { ok: true }>["shots"] = [];
  const applied: ShotApplication[] = [];
  for (const s of plan.shots) {
    const seg = parsedInput.data.segments.find(x => x.id === s.segmentId);
    const t = b.segmentTimes[s.segmentId];
    if (!seg || !t || !(t.end > t.start)) { blockers.push({ code: "TIMING_MISSING", shotId: s.id, detail: `sin tiempos medidos para ${s.segmentId}` }); continue; }
    if (s.asset.status === "needs_new") { blockers.push({ code: "MATERIAL_NOT_AUTHORISED", shotId: s.id, detail: "requiere material nuevo; no hay presupuesto autorizado aquí" }); continue; }
    const assetId = s.asset.assetId;
    const m = assetId ? b.media[assetId] : undefined;
    if (!assetId || !m) { blockers.push({ code: "MEDIA_MISSING", shotId: s.id, detail: `no existe material para ${assetId ?? "(sin asset)"}` }); continue; }
    if (m.license !== "CLEARED") blockers.push({ code: "LICENSE_NOT_CLEARED_FOR_RENDER", shotId: s.id, detail: `${assetId}: ${m.license}` });
    if (s.movement.realMotion && m.mediaType !== "video") blockers.push({ code: "REAL_MOTION_WITHOUT_CLIP", shotId: s.id, detail: "el plano promete movimiento real y el material es una imagen fija" });
    // A required label must be drawable by the composition; the label itself travels in the scene direction.
    if (s.asset.label && !(s.asset.label in LABEL_TEXT)) blockers.push({ code: "LABEL_NOT_RENDERABLE", shotId: s.id, detail: `VerticalReel no puede mostrar la etiqueta obligatoria «${s.asset.label}»` });
    // Proportional mapping inside the segment: planned fractions onto the measured narration timing.
    const span = seg.end - seg.start, real = t.end - t.start;
    const startSeconds = t.start + ((s.start - seg.start) / span) * real;
    const endSeconds = t.start + ((s.end - seg.start) / span) * real;
    const { direction, unsupported } = directionFor(s, m.mediaType);
    scenes.push({ mediaUrl: m.url, mediaType: m.mediaType, startSeconds: round3(startSeconds), endSeconds: round3(endSeconds), direction });
    shots.push({ shotId: s.id, assetId, mediaType: m.mediaType, label: s.asset.label });
    applied.push({ shotId: s.id, anchorText: s.anchorText, recipeId: s.recipeId,
      planned: { movement: s.movement.kind, transitionIn: s.suggestions.transitionIn, transitionOut: s.suggestions.transitionOut, label: s.asset.label, shotType: s.shotType, composition: s.suggestions.composition },
      applied: { motion: direction.motion, transitionIn: direction.transitionIn, transitionOut: direction.transitionOut, label: direction.label ?? null, startSeconds: round3(startSeconds), endSeconds: round3(endSeconds) },
      unsupported });
  }
  scenes.sort((x, y) => x.startSeconds - y.startSeconds);
  if (scenes.length) {
    const narrationEnd = Math.max(...Object.values(b.segmentTimes).map(t => t.end));
    if (scenes[0].startSeconds > EPS) blockers.push({ code: "TIMELINE_GAP", detail: `el primer plano empieza en ${scenes[0].startSeconds}s` });
    for (let i = 1; i < scenes.length; i++) if (Math.abs(scenes[i].startSeconds - scenes[i - 1].endSeconds) > EPS) blockers.push({ code: "TIMELINE_GAP", detail: `hueco o solape antes de ${scenes[i].startSeconds}s` });
    if (Math.abs(scenes[scenes.length - 1].endSeconds - narrationEnd) > EPS) blockers.push({ code: "TIMELINE_GAP", detail: "los planos no terminan con la narración" });
    if (b.durationSeconds + EPS < narrationEnd) blockers.push({ code: "DURATION_SHORT", detail: "la duración es menor que la narración" });
  }
  // Last line of defence: no non-finite or negative scene time ever reaches the props.
  for (const sc of scenes) if (!finite(sc.startSeconds) || !finite(sc.endSeconds) || !(sc.endSeconds > sc.startSeconds)) blockers.push({ code: "INVALID_TIME", detail: `escena ${sc.startSeconds}..${sc.endSeconds}` });
  if (blockers.length) return { ok: false, paidCalls: 0, blockers };
  applied.sort((x, y) => x.applied.startSeconds - y.applied.startSeconds);
  return { ok: true, paidCalls: 0, shots, applied,
    props: { audioUrl: b.audioUrl, durationSeconds: b.durationSeconds, scenes, captions: b.captions, narrationGaps: b.narrationGaps ?? [] } };
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

type PlanShot = ReturnType<typeof DirectorPlanSchema.parse>["shots"][number];

/** Recipe transition vocabulary → what VerticalReel can do. Anything else is declared unsupported and applied as a cut. */
const TRANSITION_IN: Record<string, SceneTransitionIn> = { cut: "cut", fade_in_short: "fade", fade_in: "fade", crossfade: "crossfade", dissolve: "crossfade" };
const TRANSITION_OUT: Record<string, SceneTransitionOut> = { cut: "cut", fade_out_short: "fade", fade_to_black: "fade", crossfade: "crossfade", dissolve: "crossfade" };

/**
 * The recipe (through the plan shot) decides how the scene moves and enters/leaves. A real clip is never zoomed
 * synthetically; a move on a still is a declared push-in/pan; a locked (approved avatar) segment plays untouched.
 */
export function directionFor(s: PlanShot, mediaType: Scene["mediaType"]): { direction: SceneDirection; unsupported: string[] } {
  const unsupported: string[] = [];
  let motion: SceneMotion;
  if (s.asset.status === "locked") motion = mediaType === "video" ? "real" : "static";
  else switch (s.movement.kind) {
    case "real_motion": motion = mediaType === "video" ? "real" : "static"; break;
    case "push_in_still": motion = mediaType === "video" ? "real" : "push_in"; if (mediaType === "video") unsupported.push("push_in_still sobre un clip: se reproduce tal cual"); break;
    case "pan": motion = mediaType === "video" ? "real" : "pan"; if (mediaType === "video") unsupported.push("pan sobre un clip: se reproduce tal cual"); break;
    case "handheld": motion = mediaType === "video" ? "real" : "static"; unsupported.push("handheld: sin simulación de cámara en mano"); break;
    case "graphic_animation": motion = "static"; unsupported.push("graphic_animation: el gráfico no se construye por etapas en VerticalReel"); break;
    default: motion = "static";
  }
  const tin = s.asset.status === "locked" ? "cut" : s.suggestions.transitionIn, tout = s.asset.status === "locked" ? "cut" : s.suggestions.transitionOut;
  const transitionIn = tin ? TRANSITION_IN[tin] : "cut", transitionOut = tout ? TRANSITION_OUT[tout] : "cut";
  if (tin && !TRANSITION_IN[tin]) unsupported.push(`transición de entrada «${tin}» no soportada: corte`);
  if (tout && !TRANSITION_OUT[tout]) unsupported.push(`transición de salida «${tout}» no soportada: corte`);
  return { direction: { recipeId: s.recipeId, motion, transitionIn: transitionIn ?? "cut", transitionOut: transitionOut ?? "cut", label: s.asset.label }, unsupported };
}
