/**
 * Presentación PURA del Autonomous Quality Loop para el administrador (sin React, probada aparte).
 * Solo traduce lo que `publicView` del motor ya devuelve: no deduce actividad, no inventa ejecuciones
 * programadas ni presenta la próxima hora nominal como garantía.
 */
import type { publicView } from "@/lib/mystery-shopper/quality-loop/model";

export type LoopView = ReturnType<typeof publicView>;
type Cycle = LoopView["cycles"][number];
type Defect = LoopView["defects"][number];

export const TZ = "America/Cancun";
export const when = (iso: string | null | undefined) => {
  if (!iso) return "Sin evidencia";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "Sin evidencia" : new Intl.DateTimeFormat("es-MX", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }).format(d);
};

export const TRIGGER: Record<Cycle["trigger"], string> = {
  schedule: "Programada (cron)", deployment_status: "Posterior a despliegue", workflow_dispatch: "Manual", fixture: "Simulación local",
};
export const PRODUCT: Record<string, string> = {
  youtube: "YouTube Long Form", reels: "Reels", "audio-podcast": "Audio Podcast", "video-podcast": "Podcast audiovisual",
  "account-nav": "Cuenta y navegación", commercial: "Comercial", "command-center": "Command Center",
};
export const DEFECT_STATE: Record<Defect["state"], string> = {
  DETECTED: "Detectado", CLAIMED: "En corrección (ACK)", FIXED_IN_BRANCH: "Corregido en rama", INTEGRATED: "Integrado, pendiente de revalidar", REVALIDATED: "Revalidado",
};
export const OPERATIONAL: Record<LoopView["operational"], string> = {
  STOPPED: "Detenido", STALE: "Sin ciclo reciente", ERROR: "Fallos detectados", BLOCKED: "Último ciclo con bloqueos", ACTIVE: "Último ciclo sin fallos ni bloqueos",
};

export type LoopSummary = {
  lastReal: Cycle | null;
  byTrigger: { trigger: Cycle["trigger"]; label: string; count: number; last: string | null }[];
  scheduleProven: boolean;
  next: { display: string; note: string };
  killSwitch: { engaged: boolean; label: string; note: string };
};

/** Ciclos reales (no simulación) agrupados por origen; la hora siguiente sólo es «nominal» y se dice si cron nunca corrió. */
export function summarize(v: LoopView): LoopSummary {
  const real = v.cycles.filter((c) => c.scope !== "fixture");
  const lastReal = real.at(-1) ?? null;
  const byTrigger = (["schedule", "deployment_status", "workflow_dispatch"] as const).map((trigger) => {
    const of = real.filter((c) => c.trigger === trigger);
    return { trigger, label: TRIGGER[trigger], count: of.length, last: of.at(-1)?.finishedAt ?? null };
  });
  const scheduleProven = byTrigger[0].count > 0;
  const next = !v.enabled
    ? { display: "Ninguna", note: "El bucle está detenido." }
    : { display: when(v.nextEvaluation), note: scheduleProven ? "Nominal: GitHub cron es best effort, no garantizado." : "Nominal: aún no hay ninguna ejecución programada acreditada en el historial." };
  const killSwitch = v.enabled
    ? { engaged: false, label: "Sin activar", note: "El ciclo puede reclamar evaluaciones. Pulsa «Parada de emergencia» para detenerlo." }
    : { engaged: true, label: "ACTIVADA — ciclo detenido", note: "Ninguna evaluación nueva se reclama hasta reactivarlo." };
  return { lastReal, byTrigger, scheduleProven, next, killSwitch };
}

export const shortSha = (sha: string | null | undefined) => (sha && /^[a-f0-9]{7,40}$/.test(sha) ? sha.slice(0, 7) : null);

/** Texto del ACK de un defecto: quién lo reclamó (hash, nunca correo) y hasta cuándo; vencido se dice. */
export function ackOf(d: Defect): string | null {
  if (!d.claim) return null;
  return d.claim.expired ? `ACK vencido (${when(d.claim.expiresAt)}): puede reclamarse de nuevo` : `ACK de ${d.owner} · actor ${d.claim.actor} · vigente hasta ${when(d.claim.expiresAt)}`;
}
