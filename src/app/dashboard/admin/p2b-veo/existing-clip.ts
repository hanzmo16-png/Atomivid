import { aiVideoClipStoragePath } from "@/lib/video/long-form/ai-video-storage";

/**
 * El primer MP4 real de Google Veo generado por ATOMIVID (P2B, misión
 * "cerrar AI Video Veo end-to-end", 2026-09-24) — shot "Pillar Transport".
 * `providerJobId` es el operation name real devuelto por Google, confirmado
 * por Hans tras el intento SUCCESS — no es un secreto (no es una API key ni
 * un token, solo un identificador de operación ya completada). Se
 * reconstruye la MISMA ruta de Storage que `p2b-pillar-transport-execution.ts`
 * usó para subir el archivo (vía `aiVideoClipStoragePath`, ver
 * ai-video-storage.ts) — nunca se hardcodea la ruta completa como string
 * literal, para que ambos lugares no puedan divergir.
 */
const FIRST_REAL_CLIP_PROVIDER_JOB_ID = "models/veo-3.1-fast-generate-preview/operations/9bs4xi895fwx";
const FIRST_REAL_CLIP_BENCHMARK_ID = "gobekli-tepe-ai-video-benchmark-v2-active";
const FIRST_REAL_CLIP_SHOT_ID = "bench-v2-a-pillar-transport";

export function firstRealClipStoragePath(): string {
  const idempotencyKey = FIRST_REAL_CLIP_PROVIDER_JOB_ID.replace(/[^a-zA-Z0-9_-]/g, "-");
  return aiVideoClipStoragePath(FIRST_REAL_CLIP_BENCHMARK_ID, FIRST_REAL_CLIP_SHOT_ID, idempotencyKey, "mp4");
}
