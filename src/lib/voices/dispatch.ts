/**
 * Encola la clonación/prueba de una voz propia. En Vercel siempre por
 * GitHub Actions (voice-clone.yml); en desarrollo local sin credenciales de
 * GitHub corre en este mismo proceso, sin esperar.
 */
import { MissingEnvVarError } from "@/lib/env-errors";
import { dispatchRepositoryEvent } from "@/lib/worker/github-actions";

export const VOICE_CLONE_EVENT_TYPE = "clone-voice";

export async function dispatchVoiceClone(voiceId: string): Promise<void> {
  const hasGitHub = Boolean(process.env.GH_WORKER_TOKEN && process.env.GH_WORKER_REPO);
  if (process.env.VERCEL === "1" || hasGitHub) {
    if (!process.env.GH_WORKER_TOKEN) throw new MissingEnvVarError("GH_WORKER_TOKEN");
    if (!process.env.GH_WORKER_REPO) throw new MissingEnvVarError("GH_WORKER_REPO");
    await dispatchRepositoryEvent(VOICE_CLONE_EVENT_TYPE, { voiceId });
    return;
  }
  const { runVoiceCloneJobWithDefaults } = await import("./clone-deps");
  void runVoiceCloneJobWithDefaults(voiceId).catch((err) => console.error("[atomivid:my-voice] worker local:", err instanceof Error ? err.message : err));
}
