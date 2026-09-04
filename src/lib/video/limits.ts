/**
 * Límites del render en segundo plano, compartidos entre la ruta API que
 * dispara el worker y la UI que decide cuándo ofrecer un reintento.
 */

/** Reintentos máximos por solicitud antes de pedir crear una nueva. */
export const MAX_RENDER_ATTEMPTS = 3;

/**
 * Si una solicitud lleva más de esto en "processing" sin actualizarse, se
 * trata como colgada (el worker probablemente murió sin poder reportar el
 * error) y se permite reintentar en vez de bloquear para siempre.
 */
export const RENDER_TIMEOUT_MS = 15 * 60 * 1000;
