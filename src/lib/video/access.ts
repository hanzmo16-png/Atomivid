import type { VideoRequestSummary } from "./request-view";

export type OwnedRequestRow = VideoRequestSummary & { user_id: string };

/**
 * Segunda comprobación de propiedad, además del filtro `.eq("user_id", ...)`
 * ya aplicado en la consulta a Supabase — nunca se confía solo en el `id`
 * recibido por la URL. Si por lo que sea llegara una fila que no pertenece
 * al usuario actual (o no llegó ninguna fila), se trata exactamente igual
 * que "no encontrado": nunca se filtra a quién pertenece realmente.
 */
export function selectIfOwned(
  row: OwnedRequestRow | null | undefined,
  userId: string,
): VideoRequestSummary | null {
  if (!row || !userId || row.user_id !== userId) return null;
  // Se descarta user_id explícitamente: el resto del código nunca debe
  // recibir ese dato mezclado con el resumen que se pasa a la UI.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { user_id: _userId, ...summary } = row;
  return summary;
}
