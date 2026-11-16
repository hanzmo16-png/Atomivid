import { renderProject } from "./render";
import type { BlobStore, ProjectStore } from "./store";
import type { VoiceAvailability } from "./voice";

/**
 * Arranque del worker. En 1.0 solo existe el worker local en proceso (`AUDIO_STUDIO_WORKER=inline`), que el arnés y el CI
 * usan con la voz fixture. En producción no se activa (VERCEL/NODE_ENV) y, sin autorización de gasto, ninguna
 * generación llega a la cola. Devuelve si arrancó.
 */
export function startWorker(store: ProjectStore & BlobStore, voice: VoiceAvailability, ownerId: string, id: string, env: Record<string, string | undefined> = process.env): boolean {
  if (env.AUDIO_STUDIO_WORKER !== "inline" || env.VERCEL || env.NODE_ENV === "production" || !voice.ok) return false;
  setTimeout(() => { renderProject({ store, voice: voice.voice, musicDir: env.AUDIO_STUDIO_MUSIC_DIR || undefined }, ownerId, id).catch((e) => console.error("[audio-studio] worker", (e as Error).message)); }, 0);
  return true;
}
