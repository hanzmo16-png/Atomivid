/**
 * Material nuevo del Director, dentro del tope que el PROPIETARIO aprobó para ESTA producción (anexo C1, 2026-10-18).
 *
 * The Director only arranges material that exists (reel-render.ts). When its plan cannot be cut because some shots
 * need NEW material (case f404ec4f: one image of USD 0.04 against a budget fixed at 0), the old behaviour was a hard
 * stop. Now, and only for the owner's private tests:
 *   - the owner approves, at start, a ceiling of new Director material for this production (never the browser alone:
 *     the server honours it only for isInternalProductionOwner, and reserves it atomically in the image provider's
 *     envelope, the same reservation pi_submit_with_supply enforces);
 *   - the worker generates EXACTLY the shots the plan asked for, if their summed unit cost fits what remains of that
 *     ceiling, with the same gated image call as the rest of the Reel (ledger, idempotency, no blind retry); then it
 *     re-plans ONCE. No loop, no second fill;
 *   - if they do not fit, it stops BEFORE any new paid call, keeps the voice and the material already obtained, and
 *     says how much more would be needed (the delta), so the owner can approve a higher ceiling.
 * Customers (profile «commercial») keep the previous rule: no new Director material.
 */
import type { DirectedReel, ResolvedBeat } from "./reel-render";
import { topicsOf } from "./policy";
import { GENERATED_IMAGE_LICENSE } from "./beat-license";
import { stableHash } from "@/lib/production-intelligence/canonical";

export type ProductionProfile = "owner_test" | "commercial";
/** Hard last line of defence for one production's new Director material (owner tests). */
export const MAX_DIRECTOR_MATERIAL_USD = 2;

/** The profile is decided on the server from the verified user; a browser parameter never selects it. */
export function productionProfile(isOwner: boolean): ProductionProfile {
  return isOwner ? "owner_test" : "commercial";
}

/**
 * Ceiling of new Director material the server will reserve for this start. Commercial: always 0. Owner: what they
 * approved, rounded to cents and bounded by MAX_DIRECTOR_MATERIAL_USD. Anything that is not a finite, non-negative
 * number is refused (never read as «unlimited» nor silently as 0).
 */
export function approvedDirectorMaterialUsd(profile: ProductionProfile, requested: unknown):
  { ok: true; usd: number } | { ok: false; error: string } {
  if (requested === undefined || requested === null || requested === "") return { ok: true, usd: 0 };
  const n = typeof requested === "number" ? requested : Number(requested);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: "El tope de material nuevo del Director debe ser un importe válido (USD, 0 o más)." };
  if (profile !== "owner_test") return n > 0 ? { ok: false, error: "El material nuevo del Director solo está disponible en las pruebas privadas del propietario." } : { ok: true, usd: 0 };
  if (n > MAX_DIRECTOR_MATERIAL_USD + 1e-9) return { ok: false, error: `El tope de material nuevo del Director no puede superar USD ${MAX_DIRECTOR_MATERIAL_USD.toFixed(2)} por producción.` };
  return { ok: true, usd: Math.floor(n * 100 + 1e-6) / 100 };
}

/** One shot of the plan that needs new material, with where it goes and what it must show. */
export type FillShot = { shotId: string; segmentId: string; kind: "ai_image"; estimatedMaxUsd: number; start: number; end: number; reason: string;
  /** Exact sentence fragment the shot illustrates, and the Director's words for what it shows (never a fact to invent). */
  anchorText: string; visualTheme: string };

/**
 * Blockers a fill can resolve: the shot has no material (MATERIAL_NOT_AUTHORISED), the plan's cost is above the zero
 * budget (AUDIT_BUDGET_EXCEEDED) and the gap each skipped shot leaves in the timeline (TIMELINE_GAP). Anything else
 * (licence, editorial policy, timing, motion, contract) is not a lack of material: no money is spent on it.
 */
const FILLABLE = new Set(["MATERIAL_NOT_AUTHORISED", "BUDGET_EXCEEDED", "TIMELINE_GAP"]);

/**
 * The shots to fill, or why this block is NOT a «missing material» block (licence, policy, timing, motion...): then
 * no money is spent and the Director's own message stands. ai_video is not filled here (motion clips are a separate,
 * costlier decision).
 */
export function fillPlan(directed: DirectedReel): { ok: true; shots: FillShot[]; totalUsd: number } | { ok: false; reason: string } {
  if (directed.ok) return { ok: false, reason: "el plan ya se puede montar" };
  if (!directed.plan) return { ok: false, reason: "no hay plan del Director" };
  const codes = directed.blockers.map(b => blockerCode(b));
  const other = codes.filter(c => !FILLABLE.has(c));
  if (other.length) return { ok: false, reason: `bloqueo que el material nuevo no resuelve: ${[...new Set(other)].join(", ")}` };
  const shots: FillShot[] = [];
  for (const s of directed.plan.shots) {
    if (s.asset.status !== "needs_new") continue;
    if (!s.newMaterial || s.newMaterial.kind !== "ai_image") return { ok: false, reason: `el plano ${s.id} pide ${s.newMaterial?.kind ?? "material sin tipo"}` };
    shots.push({ shotId: s.id, segmentId: s.segmentId, kind: "ai_image", estimatedMaxUsd: s.newMaterial.estimatedMaxUsd, start: s.start, end: s.end, reason: s.newMaterial.reason,
      anchorText: s.anchorText, visualTheme: s.visualTheme });
  }
  if (!shots.length) return { ok: false, reason: "ningún plano pide material nuevo" };
  return { ok: true, shots, totalUsd: Math.round(shots.reduce((sum, s) => sum + s.estimatedMaxUsd, 0) * 10000) / 10000 };
}

/** The bridge re-runs the contract audit and reports its issues as AUDIT_<code>. */
function blockerCode(b: { code: string }): string {
  return b.code === "AUDIT_BUDGET_EXCEEDED" ? "BUDGET_EXCEEDED" : b.code;
}

/** Leftover slivers shorter than this are absorbed by the fill shot (the plan's times are rounded). */
const SNAP_SECONDS = 0.05;

/**
 * The scene's beats with the generated images inserted at their shots' windows (clamped to the scene's measured
 * time): the existing material keeps the rest of the scene, never stretched over the new shot. Pure.
 */
export function fillBeats(beatsBySegment: ResolvedBeat[][], sceneTimings: { start: number; end: number }[], segmentIds: string[],
  filled: { shot: FillShot; url: string }[]): ResolvedBeat[][] {
  return beatsBySegment.map((beats, i) => {
    const mine = filled.filter(f => f.shot.segmentId === segmentIds[i]).sort((x, y) => x.shot.start - y.shot.start);
    if (!mine.length) return beats;
    const st = sceneTimings[i];
    const out: ResolvedBeat[] = [];
    let cursor = st.start;
    // Existing material for [from, to): the original beats, cut to that interval.
    const keep = (from: number, to: number) => {
      for (const b of beats) {
        const s = Math.max(b.start, from), e = Math.min(b.end, to);
        if (e - s > 1e-6) out.push({ ...b, start: s, end: e });
      }
    };
    for (const { shot, url } of mine) {
      let a = Math.max(st.start, Math.min(st.end, shot.start)), e = Math.max(st.start, Math.min(st.end, shot.end));
      if (a - cursor < SNAP_SECONDS) a = cursor;
      if (st.end - e < SNAP_SECONDS) e = st.end;
      if (e <= a) continue;
      if (a > cursor) keep(cursor, a);
      out.push({ url, mediaType: "image", source: "generated", license: GENERATED_IMAGE_LICENSE, start: a, end: e, topics: topicsOf(shot.anchorText) });
      cursor = e;
    }
    if (cursor < st.end) keep(cursor, st.end);
    return out;
  });
}

/**
 * Storage object and ledger key of one fill image (corrección 2, P1). Bound to WHAT is generated — the exact prompt
 * and negative prompt, the sentence fragment it illustrates, the provider variant (model, quality, size) and a schema
 * version — not only to the shot id: the same content on a retry reuses its image (never paid twice); a changed
 * sentence, prompt or model never inherits an image made for something else.
 */
export function fillObjectKey(shot: FillShot, prompt: string, negativePrompt: string | undefined, variant: string): string {
  const safeShot = shot.shotId.replace(/[^a-zA-Z0-9-]/g, "-");
  return `director-fill-${safeShot}-${stableHash({ v: 1, prompt, negativePrompt: negativePrompt ?? null, anchorText: shot.anchorText, variant, aspect: "9:16" }, 16)}`;
}

/** Image prompt for one fill shot: the scene's own prompt, focused on this shot's theme. Never adds facts. */
export function fillPrompt(sceneImagePrompt: string, shot: FillShot): string {
  return `${sceneImagePrompt.trim()} Distinct framing for this moment: ${shot.visualTheme || shot.anchorText}. No text, logos or numbers in the image.`.slice(0, 1800);
}

/**
 * Executes ONE fill, generator injected (the worker passes the gated image call). Before the first call the summed
 * unit costs are compared with what remains of the approved ceiling: if they do not fit, nothing is called and
 * DirectorMaterialBudgetError says by how much. Calls run one by one and stop at the first error (images already
 * stored are reused on a retry, never paid twice).
 */
export async function fillDirectorMaterial(a: {
  directed: DirectedReel; approvedUsd: number; spentUsd?: number;
  beatsBySegment: ResolvedBeat[][]; sceneTimings: { start: number; end: number }[];
  generate: (shot: FillShot, sceneIndex: number, maxUsd: number) => Promise<{ url: string; costUsd: number }>;
  /**
   * D-RETRY-CEILING (T-20261019-1602): true when this shot's image is ALREADY stored (paid in an earlier attempt).
   * Stored shots cost nothing on a retry, so they never count against the ceiling, and they are generated with a
   * 0 USD allowance: if the object vanished, the call cannot spend outside the confirmed ceiling.
   */
  isStored?: (shot: FillShot, sceneIndex: number) => Promise<boolean>;
}): Promise<{ beatsBySegment: ResolvedBeat[][]; spentUsd: number; shots: FillShot[]; reusedShots: string[] } | { skipped: string }> {
  const plan = fillPlan(a.directed);
  if (!plan.ok) return { skipped: plan.reason };
  const segmentIds = (a.directed.input?.segments ?? []).map(s => s.id);
  const indexed = plan.shots.map(shot => {
    const sceneIndex = segmentIds.indexOf(shot.segmentId);
    if (sceneIndex < 0) throw new Error(`plano ${shot.shotId} sin escena`);
    return { shot, sceneIndex };
  });
  const stored = new Set<string>();
  if (a.isStored) for (const { shot, sceneIndex } of indexed) if (await a.isStored(shot, sceneIndex)) stored.add(shot.shotId);
  const newUsd = Math.round(indexed.filter(x => !stored.has(x.shot.shotId)).reduce((t, x) => t + x.shot.estimatedMaxUsd, 0) * 10000) / 10000;
  const remaining = Math.max(0, Math.round((a.approvedUsd - (a.spentUsd ?? 0)) * 10000) / 10000);
  // Only NEW material is compared with the confirmed ceiling; the ceiling never grows from a new estimate.
  if (newUsd > remaining + 1e-9) throw new DirectorMaterialBudgetError(newUsd, remaining);
  const filled: { shot: FillShot; url: string }[] = [];
  let spent = 0;
  for (const { shot, sceneIndex } of indexed) {
    const reuse = stored.has(shot.shotId);
    const r = await a.generate(shot, sceneIndex, reuse ? 0 : shot.estimatedMaxUsd);
    if (reuse && r.costUsd > 0) throw new Error(`plano ${shot.shotId}: material guardado no reutilizado (cobro inesperado USD ${r.costUsd})`);
    spent += r.costUsd;
    filled.push({ shot, url: r.url });
  }
  return { beatsBySegment: fillBeats(a.beatsBySegment, a.sceneTimings, segmentIds, filled), spentUsd: Math.round(spent * 10000) / 10000, shots: plan.shots, reusedShots: [...stored] };
}

/** Customer-facing stop when the approved ceiling is not enough: before any new paid call, with the delta. */
export class DirectorMaterialBudgetError extends Error {
  readonly diagnosticId = "DIRECTOR-MATERIAL-BUDGET";
  readonly customerMessage: string;
  constructor(readonly neededUsd: number, readonly approvedRemainingUsd: number) {
    super(`DIRECTOR_MATERIAL_BUDGET:${neededUsd}:${approvedRemainingUsd}`);
    this.name = "DirectorMaterialBudgetError";
    const delta = Math.max(0.01, Math.ceil((neededUsd - approvedRemainingUsd) * 100 - 1e-6) / 100);
    this.customerMessage = approvedRemainingUsd > 0
      ? `El Director necesita material nuevo por hasta USD ${neededUsd.toFixed(2)} y el tope aprobado que queda para este video es USD ${approvedRemainingUsd.toFixed(2)}. Se detuvo antes de cualquier llamada de pago nueva; la voz y el material ya obtenidos se conservan. Para continuar, aprueba al menos USD ${delta.toFixed(2)} más para este video.`
      : `El Director necesita material nuevo por hasta USD ${neededUsd.toFixed(2)} y este video no tiene tope aprobado para material nuevo. Se detuvo antes de cualquier llamada de pago nueva; la voz y el material ya obtenidos se conservan. Para continuar, aprueba un tope de al menos USD ${delta.toFixed(2)} para este video.`;
  }
}
