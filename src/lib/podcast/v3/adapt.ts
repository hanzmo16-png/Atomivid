/**
 * «Adaptar producción al límite disponible» (incidente real 4290175a, 2026-11-08: 48 llamadas de HeyGen pedidas, límite
 * diario de la plataforma 40). La persona lo resuelve sola desde ATOMIVID, sobre el MISMO episodio:
 *  1. Vista previa (sin cambios ni cargos): cuántas apariciones del avatar pasan a imagen/ilustración, duración conservada,
 *     presupuesto antes/después y si con el ajuste los proveedores quedan listos.
 *  2. Confirmación: se guarda solo el tope aceptado (spec.visual.avatar_max_calls) y su registro (spec.adaptation); guion,
 *     participantes, voces, ledger y gastos no cambian. Después se reintenta el mismo episodio con la verificación previa
 *     de siempre (si el proveedor sigue sin capacidad, no se inicia nada).
 * Sin llamadas de pago: el plan y la estimación usan los proveedores de planificación.
 */
import type { ProviderNeeds } from "./pipeline";
import { preflight, providerNeeds, avatarPrepares } from "./pipeline";
import { planIssues, type EditorialPlan } from "./editorial";
import { readinessMessage } from "./readiness";
import { StudioSpec, type StudioSpec as Spec } from "./spec";
import type { StudioEpisodeRow } from "./store";
import type { SupplyReadiness } from "@/lib/supply/readiness";

const ON_CAMERA = new Set(["avatar_a", "avatar_b", "two_shot", "over_shoulder"]);
const avatarShots = (plan: EditorialPlan) => plan.shots.filter((s) => ON_CAMERA.has(s.kind)).length;
/** Mayor tramo seguido sin nadie a cámara (segundos): la adaptación no debe dejar al avatar ausente en bloque. */
export function longestOffCamera(plan: EditorialPlan): number {
  let best = 0, run = 0;
  for (const s of plan.shots) { if (ON_CAMERA.has(s.kind)) run = 0; else { run += s.end - s.start; best = Math.max(best, run); } }
  return Math.round(best);
}
export const MAX_OFF_CAMERA_SECONDS = 60;
const planSeconds = (plan: EditorialPlan) => plan.shots.length ? plan.shots[plan.shots.length - 1].end : 0;
const speakersOnCamera = (plan: EditorialPlan) => [...new Set(plan.shots.filter((s) => ON_CAMERA.has(s.kind)).map((s) => s.speaker).filter(Boolean))].sort();

export type AdaptDeps = {
  supplyCheck: (needs: ProviderNeeds) => Promise<SupplyReadiness>;
  /** Operaciones ya liquidadas del episodio (se reutilizan; no son llamadas nuevas). Lanza si no se puede leer. */
  settledOps: (episodeId: string) => Promise<{ op: string }[]>;
};
export type AdaptProposal = {
  episodeId: string;
  limit: number; usedToday: number; available: number;
  callsBefore: number; callsAfter: number; maxCalls: number;
  avatarShotsBefore: number; avatarShotsAfter: number;
  replaced: { ilustracion_o_imagen: number; estudio: number; transicion: number };
  durationSeconds: number; durationPreserved: boolean;
  estimateBeforeUsd: number; estimateAfterUsd: number; budgetUsd: number; withinBudget: boolean;
  longestOffCameraBefore: number; longestOffCameraAfter: number; speakersStillOnCamera: boolean;
  readyAfter: boolean; blockAfter: string | null;
  quality: { ok: boolean; issues: string[] };
};
type Fail = { ok: false; status: number; error: string; code: string };
/** `adapted`: spec normalizado (para estimar); `stored`: el spec original con solo el tope y el registro añadidos (se guarda). */
type Ok = { ok: true; proposal: AdaptProposal; adapted: Spec; stored: Record<string, unknown>; preflight: Awaited<ReturnType<typeof preflight>> } | { ok: true; proposal: null; fits: true };

/** Calcula la propuesta (sin escribir nada). `now` solo para el registro. */
export async function planAdaptation(d: AdaptDeps, row: StudioEpisodeRow, now = () => new Date()): Promise<Fail | Ok> {
  if (row.status !== "draft" && row.status !== "failed") return { ok: false, status: 409, code: "ESTADO", error: row.status === "ready" ? "Este episodio ya está terminado." : "El episodio se está generando; no se puede adaptar ahora." };
  const parsed = StudioSpec.safeParse(row.spec);
  if (!parsed.success) return { ok: false, status: 409, code: "SPEC", error: "Especificación del episodio inválida." };
  const spec = parsed.data;
  if (spec.mode === "narracion" || spec.output === "audio") return { ok: false, status: 409, code: "SIN_AVATAR", error: "Este episodio no usa avatar: no hay nada que adaptar." };
  const settled = await d.settledOps(row.id);
  const pf = await preflight(spec, (await import("./api")).planningProviders());
  const r = await d.supplyCheck(providerNeeds(spec, pf, settled, { prepare: true }));
  if (r.ready) return { ok: true, proposal: null, fits: true };
  const q = r.failure?.provider === "heygen" && r.failure.reason === "daily request quota" ? r.failure.quota : undefined;
  // Solo se adapta el límite diario de llamadas del avatar; cualquier otro bloqueo (saldo, topes, otro proveedor) se mantiene.
  if (!q) return { ok: false, status: 409, code: "OTRO_BLOQUEO", error: `La adaptación solo resuelve el límite diario de apariciones del avatar. Motivo actual: ${readinessMessage(r.failure)}` };
  const available = Math.max(0, q.max - q.today);
  const settledAvatar = settled.filter((x) => x.op === "avatar_clip" || x.op === "avatar_prepare").length;
  // Tope TOTAL del episodio: lo ya liquidado se reutiliza (no son llamadas nuevas) + lo que queda hoy.
  const maxCalls = available + settledAvatar;
  const shotsAllowed = maxCalls - avatarPrepares(spec);
  if (available < 1 || shotsAllowed < 2) {
    const zone = q.timezone === "America/Cancun" ? "Cancún" : q.timezone;
    return { ok: false, status: 409, code: "SIN_CAPACIDAD", error: `Hoy no queda capacidad suficiente del avatar (${q.today} de ${q.max} llamadas usadas). El límite se restablece a las 00:00 hora de ${zone}; tu episodio se conserva y podrás adaptarlo o reintentarlo entonces.` };
  }
  const adapted: Spec = { ...spec, visual: { ...spec.visual, avatar_max_calls: maxCalls } };
  const pf2 = await preflight(adapted, (await import("./api")).planningProviders());
  const needs2 = providerNeeds(adapted, pf2, settled, { prepare: true });
  const r2 = await d.supplyCheck(needs2);
  const before = avatarShots(pf.plan), after = avatarShots(pf2.plan);
  const changed = new Set(pf.plan.shots.filter((s) => ON_CAMERA.has(s.kind)).map((s) => s.turn_id));
  const nowOff = pf2.plan.shots.filter((s) => changed.has(s.turn_id) && !ON_CAMERA.has(s.kind) && !pf2.plan.shots.some((x) => x.turn_id === s.turn_id && ON_CAMERA.has(x.kind)));
  const replaced = {
    ilustracion_o_imagen: nowOff.filter((s) => s.kind === "imagen" || s.kind === "recreacion" || s.kind === "archivo").length,
    estudio: nowOff.filter((s) => s.kind === "estudio_quieto").length,
    transicion: nowOff.filter((s) => s.kind === "transicion").length,
  };
  const issues = [...planIssues(pf2.plan)];
  const durBefore = planSeconds(pf.plan), durAfter = planSeconds(pf2.plan);
  const durationPreserved = Math.abs(durBefore - durAfter) < 0.01 && pf.turns.length === pf2.turns.length && pf.ttsChars === pf2.ttsChars;
  if (!durationPreserved) issues.push("La duración o el guion cambiarían.");
  const sp1 = speakersOnCamera(pf.plan), sp2 = speakersOnCamera(pf2.plan);
  const speakersStillOnCamera = sp1.every((x) => sp2.includes(x));
  if (!speakersStillOnCamera) issues.push("Algún participante dejaría de aparecer a cámara.");
  if (replaced.transicion > 0) issues.push(`${replaced.transicion} apariciones quedarían en un plano de transición sin imagen.`);
  if (needs2.avatarCalls! > available) issues.push("El ajuste no cabe en el límite disponible.");
  // Ritmo: nadie a cámara durante demasiado tiempo seguido degradaría la conversación (máx. 60 s o 3× el original).
  const gapBefore = longestOffCamera(pf.plan), gapAfter = longestOffCamera(pf2.plan);
  if (gapAfter > Math.max(MAX_OFF_CAMERA_SECONDS, 3 * gapBefore)) issues.push(`Nadie aparecería a cámara durante ${gapAfter} s seguidos.`);
  const proposal: AdaptProposal = {
    episodeId: row.id, limit: q.max, usedToday: q.today, available,
    callsBefore: q.calls, callsAfter: needs2.avatarCalls ?? 0, maxCalls,
    avatarShotsBefore: before, avatarShotsAfter: after, replaced,
    durationSeconds: Math.round(durAfter), durationPreserved,
    estimateBeforeUsd: pf.estimate.totalUsd, estimateAfterUsd: pf2.estimate.totalUsd, budgetUsd: spec.budget_usd, withinBudget: pf2.estimate.totalUsd <= spec.budget_usd + 1e-9,
    longestOffCameraBefore: gapBefore, longestOffCameraAfter: gapAfter, speakersStillOnCamera,
    readyAfter: r2.ready, blockAfter: r2.ready ? null : readinessMessage(r2.failure),
    quality: { ok: issues.length === 0, issues },
  };
  const record = { at: now().toISOString(), reason: "avatar_daily_quota" as const, calls_before: q.calls, calls_after: proposal.callsAfter,
    avatar_shots_before: before, avatar_shots_after: after, previous_max_calls: spec.visual.avatar_max_calls ?? null };
  // Se guarda el spec ORIGINAL tal cual (sin normalizar ni completar campos) con solo dos añadidos: el tope y su registro.
  const raw = row.spec as Record<string, unknown> & { visual?: Record<string, unknown> };
  const stored = { ...raw, visual: { ...(raw.visual ?? {}), avatar_max_calls: maxCalls }, adaptation: record };
  if (!StudioSpec.safeParse(stored).success) return { ok: false, status: 409, code: "SPEC", error: "No se pudo preparar la adaptación de este episodio." };
  return { ok: true, proposal, adapted: { ...adapted, adaptation: record }, stored, preflight: pf2 };
}

/** Texto corto para la persona: qué cambia y qué se conserva. */
export function proposalSummary(p: AdaptProposal): string[] {
  const usd = (n: number) => `USD ${n.toFixed(2)}`;
  const mins = Math.max(1, Math.round(p.durationSeconds / 60));
  return [
    `El avatar aparecerá ${p.avatarShotsAfter} veces en lugar de ${p.avatarShotsBefore}: ${p.avatarShotsBefore - p.avatarShotsAfter} apariciones pasan a ${p.replaced.ilustracion_o_imagen ? "ilustraciones o imágenes del mismo momento" : "planos del estudio con los anfitriones"}${p.replaced.estudio && p.replaced.ilustracion_o_imagen ? ` (${p.replaced.estudio} al estudio con los anfitriones)` : ""}.`,
    `Llamadas del avatar: ${p.callsAfter} (antes ${p.callsBefore}); disponibles hoy: ${p.available} de ${p.limit}.`,
    `Se conservan el guion, las voces, los participantes y la duración (~${mins} min). La apertura, el cierre y la primera y última aparición de cada participante siguen a cámara.`,
    `Costo estimado: ${usd(p.estimateAfterUsd)} (antes ${usd(p.estimateBeforeUsd)}); tu tope sigue en ${usd(p.budgetUsd)}. Lo ya pagado se reutiliza y no se cobra dos veces.`,
  ];
}
