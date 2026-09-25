import { LONG_FORM_HEARTBEAT_STALE_MS, MAX_RENDER_ATTEMPTS, RENDER_TIMEOUT_MS } from "./limits";

/**
 * Decisión pura de si una solicitud puede empezar a renderizarse ahora —
 * extraída de render/route.ts (mismo patrón de DI usado en
 * script-quality.ts, checkout.ts, etc.) para poder probar cada caso
 * (duplicada, ya en proceso, colgada, máximo de intentos) sin necesitar
 * un cliente de Supabase real ni mocks pesados de la ruta HTTP.
 *
 * Esta comprobación es la primera línea de defensa contra doble render
 * (mensaje rápido y claro); la garantía real de que solo uno de dos
 * intentos concurrentes gana es el UPDATE condicional
 * (`.eq("status", row.status)`) en route.ts, que Postgres serializa a
 * nivel de fila — esta función no puede (ni pretende) reemplazar eso.
 */
export type RenderStartRow = {
  status: string;
  render_attempts: number;
  render_started_at: string | null;
  created_at?: string;
  mode?: string | null;
  /** JSONB de progreso de Long Form — su `updatedAt` es el latido del worker. */
  long_form_progress?: unknown;
};

export type RenderStartDecision =
  | { allowed: true }
  | { allowed: false; status: number; error: string };

export function evaluateRenderStart(
  row: RenderStartRow,
  nowMs: number = Date.now(),
): RenderStartDecision {
  const isStale = isRenderStale(row, nowMs);

  if (row.status === "processing" && !isStale) {
    return { allowed: false, status: 409, error: "Este video ya se está generando." };
  }
  if (row.status !== "script_ready" && row.status !== "failed" && !isStale) {
    return {
      allowed: false,
      status: 409,
      error: `La solicitud ya está en estado "${row.status}"`,
    };
  }
  if (row.render_attempts >= MAX_RENDER_ATTEMPTS) {
    return {
      allowed: false,
      status: 409,
      error: `Se alcanzó el máximo de ${MAX_RENDER_ATTEMPTS} intentos de render para este video. Crea una nueva solicitud desde "Nuevo video".`,
    };
  }
  return { allowed: true };
}

function heartbeatOf(progress: unknown): number | null {
  if (!progress || typeof progress !== "object") return null;
  const updatedAt = (progress as { updatedAt?: unknown }).updatedAt;
  if (typeof updatedAt !== "string") return null;
  const ms = Date.parse(updatedAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Shared by API and UI so recovery is offered only when both agree.
 *
 * Long Form dura mucho más que un Reel (un documental de 3-15 min puede
 * tardar decenas de minutos en producirse) — con el umbral fijo de 15 min
 * se ofrecía "Reintentar" a una producción que seguía trabajando, y un
 * segundo intento en paralelo habría repetido gasto. Para Long Form solo
 * cuenta como colgado si el worker dejó de latir (sin actualizaciones de
 * progreso) durante LONG_FORM_HEARTBEAT_STALE_MS.
 */
export function isRenderStale(row: RenderStartRow, nowMs: number): boolean {
  const timestamp = row.render_started_at ?? row.created_at;
  if (row.status !== "processing" || !timestamp) return false;
  const startedAt = Date.parse(timestamp);
  if (!Number.isFinite(startedAt)) return false;
  if (row.mode === "long_form") {
    const lastSignal = Math.max(startedAt, heartbeatOf(row.long_form_progress) ?? startedAt);
    return nowMs - lastSignal > LONG_FORM_HEARTBEAT_STALE_MS;
  }
  return nowMs - startedAt > RENDER_TIMEOUT_MS;
}
