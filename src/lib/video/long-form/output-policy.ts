/**
 * Política de SALIDA de Long Form (P0 2026-09-25: el final.mp4 del Canal de
 * Panamá, ~300 s a 1080p/crf 26, fue rechazado por Storage con "The object
 * exceeded the maximum allowed size").
 *
 * Límite DEMOSTRADO (scripts/diagnose-long-form-output.ts, run 36172299459):
 * el bucket "videos" no tiene file_size_limit (null); el límite que rechaza
 * es el GLOBAL del proyecto Supabase ("Upload file size limit"): 49 MiB
 * aceptado, 51 MiB rechazado con el mismo mensaje que vio producción. Es
 * el valor por defecto de Supabase (50 MB) y el máximo del plan Free; solo
 * se sube desde el dashboard (plan Pro o superior).
 *
 * Aquí solo hay decisiones PURAS (sin I/O): perfil de codificación de Long
 * Form (Reel/Avatar no lo usan), envolvente de tamaño esperada por
 * duración, y qué hacer con un archivo ya renderizado según el techo de
 * Storage — nunca volver a correr el pipeline por un problema de tamaño.
 */

/** Perfil de codificación de Long Form v1 — CRF con tope de bitrate (constrained quality). */
export const LONG_FORM_ENCODING_PROFILE = {
  id: "long_form_h264_v1",
  codec: "h264" as const,
  width: 1920,
  height: 1080,
  fps: 30,
  /** 23 = calidad visual alta para 1080p (26 era el valor de Shorts). */
  crf: 23,
  /** Tope de bitrate de video: evita que el metraje de stock con mucho movimiento dispare el tamaño. */
  maxVideoKbps: 5000,
  bufferKbps: 10000,
  x264Preset: "medium" as const,
  /** La masterización de loudness vuelve a codificar el audio a este bitrate (audio-master.ts). */
  audioKbps: 192,
} as const;

/** Perfil anterior (render hasta el P0) — solo para medir el equivalente del original en recuperación. */
export const LEGACY_LONG_FORM_ENCODING = { id: "legacy_crf26", crf: 26 } as const;

const MiB = 1024 * 1024;

export const LONG_FORM_OUTPUT_POLICY = {
  /**
   * Techo de la POLÍTICA de Long Form: 1 GiB. El peor caso del perfil v1 a
   * 15 min (tope de 5 Mbps de video + 192 kbps de audio sostenidos todo el
   * video) es ~584 MB → 1.75× de margen. Es el valor a configurar en el
   * "Upload file size limit" del proyecto y el file_size_limit del bucket.
   */
  policyMaxBytes: 1024 * MiB,
  /**
   * Límite de Storage demostrado HOY (50 MiB, global del proyecto). Se usa
   * solo como techo de respaldo cuando Storage rechaza por tamaño y no hay
   * un valor configurado (LONG_FORM_STORAGE_MAX_OBJECT_BYTES).
   */
  demonstratedStorageMaxBytes: 50 * MiB,
  /** Margen bajo el techo para el ajuste de tamaño (contenedor, VBV, desviación del 2-pass). */
  fitSafetyRatio: 0.94,
  /** Por debajo de este bitrate de video a 1080p la calidad ya no es entregable: se diagnostica, no se degrada más. */
  minFitVideoKbps: 1000,
  /** Audio en el archivo ajustado de tamaño. */
  fitAudioKbps: 128,
} as const;

/** Techo configurado explícitamente para el Storage real (bytes), o null si no hay. */
export function configuredStorageMaxBytes(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.LONG_FORM_STORAGE_MAX_OBJECT_BYTES?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

export type OutputSizeEstimate = { minutes: number; typicalBytes: number; worstCaseBytes: number };

/**
 * Envolvente de tamaño del perfil v1. "worstCase" = tope de bitrate sostenido
 * todo el video (no puede excederse salvo desviación del VBV). "typical" usa
 * el bitrate medio observado (`typicalVideoKbps`), por defecto 60% del tope
 * hasta tener más mediciones reales.
 */
export function estimateOutputBytes(durationSeconds: number, typicalVideoKbps: number = LONG_FORM_ENCODING_PROFILE.maxVideoKbps * 0.6): OutputSizeEstimate {
  const audio = LONG_FORM_ENCODING_PROFILE.audioKbps;
  const bytes = (kbps: number) => Math.round((kbps * 1000 * durationSeconds) / 8);
  return {
    minutes: durationSeconds / 60,
    typicalBytes: bytes(typicalVideoKbps + audio),
    worstCaseBytes: bytes(LONG_FORM_ENCODING_PROFILE.maxVideoKbps + audio),
  };
}

export type OutputFitDecision =
  | { action: "upload" }
  | { action: "fit"; ceilingBytes: number; targetVideoKbps: number; audioKbps: number }
  | { action: "too_large"; ceilingBytes: number; requiredVideoKbps: number };

/**
 * Qué hacer con un archivo ya renderizado de `bytes` y `durationSeconds`
 * frente a un techo de Storage. Nunca pide re-renderizar ni volver a
 * llamar a un proveedor: o se sube tal cual, o se ajusta desde el MISMO
 * archivo (transcodificación 2-pass a un bitrate calculado), o se
 * diagnostica que no cabe con calidad entregable.
 */
export function decideOutputFit(input: { bytes: number; durationSeconds: number; ceilingBytes: number }): OutputFitDecision {
  if (input.bytes <= input.ceilingBytes) return { action: "upload" };
  const policy = LONG_FORM_OUTPUT_POLICY;
  const budgetBits = input.ceilingBytes * policy.fitSafetyRatio * 8;
  const totalKbps = budgetBits / Math.max(1, input.durationSeconds) / 1000;
  const targetVideoKbps = Math.floor(totalKbps - policy.fitAudioKbps);
  if (targetVideoKbps < policy.minFitVideoKbps) {
    return { action: "too_large", ceilingBytes: input.ceilingBytes, requiredVideoKbps: targetVideoKbps };
  }
  return { action: "fit", ceilingBytes: input.ceilingBytes, targetVideoKbps, audioKbps: policy.fitAudioKbps };
}

/** Categorías de fallo de subida — deciden si reintentar (mismo archivo) o parar. */
export type UploadFailureCategory = "size_rejected" | "auth" | "transient" | "unknown";

export function classifyStorageError(input: { status?: number | null; message?: string | null }): UploadFailureCategory {
  const message = input.message ?? "";
  const status = input.status ?? 0;
  if (status === 413 || /exceeded the maximum allowed size|payload too large|entity too large|maximum allowed size/i.test(message)) {
    return "size_rejected";
  }
  if (status === 401 || status === 403 || /unauthori[sz]ed|forbidden|invalid (jwt|signature|api key)/i.test(message)) return "auth";
  if (
    status === 408 ||
    status === 429 ||
    status >= 500 ||
    /timeout|timed out|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|socket hang up|network|fetch failed|terminated|aborted|gateway|temporarily/i.test(message)
  ) {
    return "transient";
  }
  return "unknown";
}

/** Mensaje para el CLIENTE cuando el render terminó pero la entrega falló — nunca rutas ni errores crudos. */
export const OUTPUT_NOT_SAVED_CUSTOMER_MESSAGE =
  "El video terminó de renderizarse, pero no pudo guardarse. Tu producción está protegida y puede recuperarse.";

/**
 * Error de ENTREGA (render ya hecho): lleva un mensaje seguro para el
 * cliente y los detalles para el admin por separado. `run-job.ts` usa
 * `customerMessage` para error_message; los detalles quedan en el estado
 * durable de salida (`${requestId}/state/output.json`).
 */
export class LongFormOutputError extends Error {
  readonly customerMessage = OUTPUT_NOT_SAVED_CUSTOMER_MESSAGE;
  constructor(
    readonly category: UploadFailureCategory | "too_large" | "output_invalid" | "state_write_failed",
    readonly diagnosticId: string,
    readonly adminDetail: Record<string, unknown>,
  ) {
    super(`long_form_output_${category}`);
    this.name = "LongFormOutputError";
  }
}

export function isCustomerSafeError(error: unknown): error is { customerMessage: string; diagnosticId?: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { customerMessage?: unknown }).customerMessage === "string"
  );
}
