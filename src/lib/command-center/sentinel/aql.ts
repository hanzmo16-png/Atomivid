import { publicView, type Queue } from "@/lib/mystery-shopper/quality-loop/model";

/**
 * Resumen de SOLO LECTURA del Autonomous Quality Loop (AQL) para la pantalla de recursos. Reutiliza `publicView` del
 * módulo de Codex sin modificarlo y descarta todo lo que no se debe mostrar aquí: tokens de reclamo, actores, evidencias.
 * No deduce agentes activos de una asignación ni presenta la próxima evaluación como garantía (cron best effort).
 */
export type AqlOperational = "STOPPED" | "STALE" | "ERROR" | "BLOCKED" | "ACTIVE";
export type AqlSummary = {
  operational: AqlOperational;
  lastEvaluation: string | null;
  nextEvaluation: string | null;
  stale: boolean;
  pending: number;
  critical: number;
  fixed: number;
  mirror: "PENDING" | "VERIFIED" | "BLOCKED";
  sentinel: "READ" | "BLOCKED" | null;
  lastChecks: { pass: number; fail: number; blocked: number; skip: number } | null;
};

export function aqlSummaryOf(queue: Queue, now: string): AqlSummary {
  const v = publicView(queue, now);
  const last = [...queue.cycles].reverse().find((c) => c.scope !== "fixture") ?? null;
  const count = (s: string) => last?.checks.filter((c) => c.state === s).length ?? 0;
  return {
    operational: v.operational as AqlOperational, lastEvaluation: v.lastEvaluation, nextEvaluation: v.nextEvaluation, stale: v.stale,
    pending: v.pending, critical: v.critical, fixed: v.fixed, mirror: queue.mirror.state, sentinel: last?.sentinel ?? null,
    lastChecks: last ? { pass: count("PASS"), fail: count("FAIL"), blocked: count("BLOCKED"), skip: count("SKIP") } : null,
  };
}

type Tone = "ok" | "warn" | "danger" | "muted" | "info";
const STATE: Record<AqlOperational, { label: string; tone: Tone; note: string }> = {
  ACTIVE: { label: "Última evaluación sin fallos", tone: "ok", note: "La última evaluación auténtica no tuvo comprobaciones fallidas ni bloqueadas." },
  BLOCKED: { label: "Con bloqueos", tone: "warn", note: "La última evaluación tuvo comprobaciones bloqueadas (sin evidencia suficiente para dictaminar)." },
  ERROR: { label: "Con fallos", tone: "danger", note: "La última evaluación tuvo comprobaciones fallidas." },
  STALE: { label: "Sin evaluación reciente", tone: "warn", note: "No hay una evaluación auténtica en los últimos 75 minutos." },
  STOPPED: { label: "Detenido", tone: "muted", note: "El bucle está detenido por un administrador." },
};
const MIRROR: Record<AqlSummary["mirror"], string> = { VERIFIED: "verificado", PENDING: "pendiente", BLOCKED: "bloqueado" };

export type AqlCard = {
  label: string; tone: Tone; note: string;
  facts: { label: string; value: string }[];
  checks: string | null;
  href: string;
};

export function aqlCard(s: AqlSummary | null, fmt: (iso: string) => string): AqlCard {
  const href = "/dashboard/command-center/quality-loop";
  if (!s) return { label: "Desconocido", tone: "muted", note: "No se pudo leer el estado del bucle de calidad.", facts: [], checks: null, href };
  const st = STATE[s.operational];
  return {
    label: st.label, tone: st.tone, note: st.note, href,
    facts: [
      { label: "Última evaluación", value: s.lastEvaluation ? fmt(s.lastEvaluation) : "Ninguna" },
      { label: "Próxima (nominal, no garantizada)", value: s.nextEvaluation ? fmt(s.nextEvaluation) : "—" },
      { label: "Defectos abiertos", value: `${s.pending}${s.critical ? ` (${s.critical} P0)` : ""}` },
      { label: "Revalidados", value: String(s.fixed) },
      { label: "Espejo en Drive", value: MIRROR[s.mirror] },
      { label: "Sentinel en el ciclo", value: s.sentinel === "READ" ? "leído" : s.sentinel === "BLOCKED" ? "bloqueado" : "—" },
    ],
    checks: s.lastChecks ? `${s.lastChecks.pass} PASS · ${s.lastChecks.fail} FAIL · ${s.lastChecks.blocked} BLOCKED · ${s.lastChecks.skip} SKIP` : null,
  };
}
