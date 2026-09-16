import { MAX_RENDER_ATTEMPTS, RENDER_TIMEOUT_MS } from "./limits";

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
};

export type RenderStartDecision =
  | { allowed: true }
  | { allowed: false; status: number; error: string };

export function evaluateRenderStart(
  row: RenderStartRow,
  nowMs: number = Date.now(),
): RenderStartDecision {
  const startedAt = row.render_started_at ? new Date(row.render_started_at).getTime() : null;
  const isStale =
    row.status === "processing" && startedAt !== null && nowMs - startedAt > RENDER_TIMEOUT_MS;

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
