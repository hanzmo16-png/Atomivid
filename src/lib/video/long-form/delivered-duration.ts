/**
 * Duración REAL del MP4 ya entregado.
 *
 * `video_requests.duration_seconds` es lo que se pidió (p. ej. 300). El
 * archivo medido vive en `${requestId}/state/output.json` (output-finalize),
 * no en esa columna. La ficha del dueño tiene que mostrar la medición cuando
 * existe; si no, sigue mostrando la duración pedida y no inventa otra.
 */
import { canonicalSubtitlePath } from "./packaging";

export function deliveredDurationSeconds(state: unknown): number | null {
  if (!state || typeof state !== "object") return null;
  const row = state as { delivered?: { durationSeconds?: unknown }; rendered?: { durationSeconds?: unknown } };
  const value = row.delivered?.durationSeconds ?? row.rendered?.durationSeconds;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** Texto de la ficha. Solo sustituye la duración pedida cuando la medición difiere. */
export function longFormDurationLabel(requestedSeconds: number, measuredSeconds: number | null): string {
  if (measuredSeconds === null || Math.abs(measuredSeconds - requestedSeconds) <= 1) return `${requestedSeconds}s`;
  return `${formatClock(measuredSeconds)} (pedido ${formatClock(requestedSeconds)})`;
}

/** Línea visible junto al reproductor. Null si no hay medición o coincide con lo pedido. */
export function measuredDurationNote(requestedSeconds: number, measuredSeconds: number | null): string | null {
  if (measuredSeconds === null || Math.abs(measuredSeconds - requestedSeconds) <= 1) return null;
  return `Duración del archivo: ${longFormDurationLabel(requestedSeconds, measuredSeconds)}`;
}

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 120) return `${s}s`;
  const minutes = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${minutes} min` : `${minutes} min ${rem} s`;
}

export const outputStateObjectPath = (requestId: string) => `${requestId}/state/output.json`;

type BlobLike = { text: () => Promise<string> };
export type DeliveryStorage = {
  download: (path: string) => Promise<{ data: BlobLike | null; error: unknown }>;
  list: (dir: string, opts: { search: string; limit: number }) => Promise<{ data: { name: string }[] | null; error: unknown }>;
};

/**
 * Lectura de la entrega ya guardada. Un fallo de Storage no tumba la página:
 * el video sigue firmándose por su ruta y la duración pedida queda como está.
 */
export async function readLongFormDeliveryFacts(
  storage: DeliveryStorage,
  request: { id: string; language?: string | null },
): Promise<{ deliveredDurationSeconds: number | null; subtitlePath: string | null }> {
  const language = request.language === "en" ? "en" : "es";
  const subtitlePath = canonicalSubtitlePath(request.id, language);
  const subtitleName = subtitlePath.slice(subtitlePath.lastIndexOf("/") + 1);
  const [state, listed] = await Promise.all([
    storage.download(outputStateObjectPath(request.id)).catch(() => ({ data: null, error: "download" })),
    storage.list(`${request.id}/output`, { search: subtitleName, limit: 10 }).catch(() => ({ data: null, error: "list" })),
  ]);
  let measured: number | null = null;
  if (state.data) {
    try {
      measured = deliveredDurationSeconds(JSON.parse(await state.data.text()));
    } catch {
      measured = null;
    }
  }
  const present = (listed.data ?? []).some((entry) => entry.name === subtitleName);
  return { deliveredDurationSeconds: measured, subtitlePath: present ? subtitlePath : null };
}
