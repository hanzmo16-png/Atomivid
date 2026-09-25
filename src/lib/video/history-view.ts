/**
 * QA blocker real (2026-09-25): el Historial mostraba "Todavía no has
 * generado ningún video" para una cuenta que SÍ tenía una solicitud recién
 * creada — la causa real era una migración pendiente (0016) que hacía que
 * el SELECT de video_requests fallara (columnas aspect_ratio/
 * long_form_stage inexistentes en producción todavía), y el código nunca
 * revisaba `error` de esa consulta: un `data: null` por fallo de query se
 * trataba exactamente igual que "cero solicitudes reales". Esta función
 * hace esa distinción explícita y obligatoria — cualquier código que arme
 * el Historial debe pasar por aquí en vez de repetir `!requests ||
 * requests.length === 0` sin mirar `error`.
 */
export type HistoryViewState<T> =
  | { kind: "error" }
  | { kind: "empty" }
  | { kind: "list"; requests: T[] };

export function resolveHistoryViewState<T>(requests: T[] | null | undefined, error: unknown): HistoryViewState<T> {
  if (error) return { kind: "error" };
  if (!requests || requests.length === 0) return { kind: "empty" };
  return { kind: "list", requests };
}
