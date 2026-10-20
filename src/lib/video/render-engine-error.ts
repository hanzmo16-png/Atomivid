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

/**
 * F40 caos (T-20261019-1602): fallos de una llamada de PAGO llegaban crudos al cliente («OpenAI Images respondió HTTP 500»,
 * «mock storage fault» con la ruta interna, «op_…: reconcile with the provider before any new submission»). Todos esos
 * casos dejan la operación en RECONCILIATION_REQUIRED (resultado incierto: pudo cobrarse) y el reintento NO reenvía.
 * El mensaje dice qué pasó, qué se conserva, que el gasto es incierto y cuál es la siguiente acción segura (esperar la
 * verificación, no reintentar). La causa cruda queda en el log con el mismo código.
 */
export const PAYMENT_UNCERTAIN_MARK = "verificación de cobro pendiente";
export const PAYMENT_IN_FLIGHT_CUSTOMER_MESSAGE =
  "Esta producción ya tiene una llamada de pago en curso en otra ejecución. No se envía otra para no cobrarte dos veces. "
  + "Se conservan tu guion y el material guardado. Espera unos minutos y vuelve a abrir el video; no hace falta reintentar.";
export function paymentUncertainCustomerMessage(what: "imagen" | "voz" | "proveedor"): string {
  const who = what === "imagen" ? "del proveedor de imágenes" : what === "voz" ? "del proveedor de voz" : "del proveedor";
  return `No pudimos confirmar el resultado de una llamada de pago ${who}: pudo haberse cobrado (${PAYMENT_UNCERTAIN_MARK}). `
    + "Para no cobrarte dos veces, no se vuelve a enviar automáticamente. Se conservan tu guion y el material ya guardado. "
    + "No reintentes todavía: la operación queda para verificar con el proveedor; si no hubo cobro se libera sin costo y podrás reintentar.";
}
const UNCERTAIN = /reconcile with the provider|RECONCILIATION_REQUIRED|respondió HTTP (429|5\d\d)|Error de red llamando a|timeout|timed out|No se pudo subir la imagen generada|No se pudo subir el audio/i;
export function classifyPaidFailure(error: unknown): string | null {
  const e = error as { name?: string; message?: string; inFlight?: boolean; constructor?: { name?: string } } | null;
  const msg = String(e?.message ?? "");
  if (e?.inFlight === true || e?.constructor?.name === "SubmissionInFlightError" || /submission already in flight/i.test(msg)) return PAYMENT_IN_FLIGHT_CUSTOMER_MESSAGE;
  if (e?.constructor?.name === "ReconciliationRequiredError" || UNCERTAIN.test(msg)) {
    return paymentUncertainCustomerMessage(/image|imagen|director-fill/i.test(msg) ? "imagen" : /voz|voice|elevenlabs|audio/i.test(msg) ? "voz" : "proveedor");
  }
  return null;
}
