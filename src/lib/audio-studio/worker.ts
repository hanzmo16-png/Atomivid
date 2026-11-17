import { renderProject } from "./render";
import type { BlobStore, ProjectStore } from "./store";
import { isUuid } from "./model";
import type { VoiceAvailability } from "./voice";

/** Evento propio del estudio: no reutiliza «render-video» para no activar el workflow de Reels/Long Form. */
export const AUDIO_STUDIO_DISPATCH_EVENT = "audio-studio-render";
const OWNER_REPO = /^[^\s/]+\/[^\s/]+$/;

export type WorkerMode = "inline" | "github" | "apagado";

/**
 * Qué worker atiende la cola:
 *  - inline: render en el propio proceso; solo fuera de producción (arnés y CI con la voz fixture).
 *  - github: despacha `.github/workflows/audio-studio-worker.yml` (ffmpeg real en un runner). Es el modo de producción;
 *    requiere GH_WORKER_TOKEN y GH_WORKER_REPO, que ya existen para el worker de video (no se modifican).
 *  - apagado: cualquier otro valor. La generación queda en cola sin gastar nada.
 */
export function workerMode(env: Record<string, string | undefined> = process.env): WorkerMode {
  if (env.AUDIO_STUDIO_WORKER === "inline" && !env.VERCEL && env.NODE_ENV !== "production") return "inline";
  if (env.AUDIO_STUDIO_WORKER === "github") return "github";
  return "apagado";
}

/** Payload mínimo del despacho: solo identificadores (el worker relee el proyecto y su autorización desde Storage). */
export function dispatchPayload(ownerId: string, id: string): { event_type: string; client_payload: { ownerId: string; projectId: string } } {
  if (!isUuid(ownerId) || !isUuid(id)) throw new Error("Identificadores inválidos para el worker.");
  return { event_type: AUDIO_STUDIO_DISPATCH_EVENT, client_payload: { ownerId, projectId: id } };
}

/**
 * Arranca el worker para un proyecto ya encolado (con su autorización de gasto guardada). Devuelve el modo usado o
 * «apagado». Un fallo del despacho no cobra nada: la generación queda en cola y, al vencer, se puede reanudar.
 */
export async function startWorker(
  store: ProjectStore & BlobStore, voice: VoiceAvailability, ownerId: string, id: string,
  env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch,
): Promise<WorkerMode> {
  const mode = workerMode(env);
  if (!voice.ok || mode === "apagado") return "apagado";
  if (mode === "inline") {
    setTimeout(() => { renderProject({ store, voice: voice.voice, musicDir: env.AUDIO_STUDIO_MUSIC_DIR || undefined }, ownerId, id).catch((e) => console.error("[audio-studio] worker", (e as Error).message)); }, 0);
    return "inline";
  }
  const token = env.GH_WORKER_TOKEN, repo = env.GH_WORKER_REPO;
  if (!token || !repo || !OWNER_REPO.test(repo)) { console.error("[audio-studio] worker github sin GH_WORKER_TOKEN/GH_WORKER_REPO válidos"); return "apagado"; }
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      body: JSON.stringify(dispatchPayload(ownerId, id)),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) { console.error("[audio-studio] despacho del worker HTTP", res.status); return "apagado"; }
    return "github";
  } catch (e) {
    console.error("[audio-studio] despacho del worker", e instanceof Error ? e.message : String(e));
    return "apagado";
  }
}

/**
 * Verificación previa del worker de producción (corre con la clave de servicio): el payload solo trae identificadores y
 * no se confía en él. Antes de leer voz en caché, sintetizar o escribir nada se exige:
 *  - UUID válidos;
 *  - que el proyecto exista en la ruta del dueño indicado y que su JSON declare ese mismo dueño (otro dueño → no existe);
 *  - generación en cola o interrumpida (una terminada, inactiva o fallida no se vuelve a procesar: despacho duplicado);
 *  - para «generar»: autorización guardada para la revisión actual, con el mismo modelo, monto > 0 y dentro del tope.
 *    Única excepción: con la voz de demostración (`opts.demo`, USD 0 por construcción) se acepta un monto exactamente 0.
 *    Con voz de pago un monto 0 se sigue rechazando (una autorización de demo nunca habilita un cargo).
 * Devuelve el motivo del rechazo, o null si puede continuar.
 */
export async function workerPreflight(store: ProjectStore, ownerId: string, id: string, opts: { demo?: boolean } = {}): Promise<string | null> {
  if (!isUuid(ownerId) || !isUuid(id)) return "identificadores inválidos";
  const p = await store.get(ownerId, id);
  if (!p || p.ownerId !== ownerId || p.id !== id) return "proyecto inexistente para ese dueño";
  const g = p.generation;
  if (g.status !== "en_cola" && g.status !== "generando") return `generación en estado «${g.status}»: nada que hacer`;
  if (g.kind !== "generar" && g.kind !== "remezclar") return "tipo de generación desconocido";
  if (g.kind === "remezclar") return null;
  const a = g.authorization;
  if (!a) return "sin autorización de gasto guardada";
  if (a.revision !== p.revision) return "la autorización es de otra revisión del guion";
  if (a.model !== p.ttsModel) return "la autorización es para otro modelo de voz";
  const zeroDemo = opts.demo === true && a.usd === 0;
  if (!(a.usd > 0 || zeroDemo) || a.usd > p.budgetUsd + 1e-9) return "monto autorizado inválido o mayor que el tope del episodio";
  return null;
}

/**
 * El worker no tiene sesión: la voz de demostración solo se concede si el dueño del proyecto (ruta del payload, ya
 * validada por `workerPreflight`) es exactamente INTERNAL_PRODUCTION_OWNER_USER_ID. Sin esa variable → nunca.
 */
export function workerOwnerIsInternal(ownerId: string, env: Record<string, string | undefined> = process.env): boolean {
  const id = env.INTERNAL_PRODUCTION_OWNER_USER_ID?.trim().toLowerCase();
  return !!id && isUuid(id) && ownerId.toLowerCase() === id;
}
