/**
 * F2-B (T-20261019-1602): a failure of the render ENGINE (Remotion / headless Chromium / FFmpeg / bundling) reached the
 * customer verbatim («"browserExecutable" was specified as '/…' but the path doesn't exist…»). Those texts carry
 * internal paths and options and give no next step. They are replaced by a human explanation (what happened, what was
 * kept, spend, next safe action); the raw cause stays in the server log with the same diagnostic code.
 */
const ENGINE_PATTERNS = /browserExecutable|chrome-headless|chromium|headless shell|remotion|@remotion|ffmpeg|ffprobe|selectComposition|renderMedia|bundl(e|ing) failed|webpack|SIGKILL|out of memory|ENOMEM|EPIPE/i;

export const RENDER_ENGINE_CUSTOMER_MESSAGE =
  "El montaje final del video falló por un problema técnico de nuestro lado. Se conservan tu guion, la voz y el material ya generado; "
  + "un reintento los reutiliza sin volver a pagarlos. En este paso no se hizo ninguna llamada de pago nueva. "
  + "Puedes reintentar; si vuelve a fallar, contacta al soporte con este código.";

export function isRenderEngineFailure(detail: string): boolean {
  return ENGINE_PATTERNS.test(detail);
}
