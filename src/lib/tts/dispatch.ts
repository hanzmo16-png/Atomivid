/**
 * Encola una pieza de «Texto a voz» en el worker. En Vercel siempre por
 * GitHub Actions (tts.yml); fuera de Vercel sin credenciales de GitHub
 * (desarrollo local) corre en este mismo proceso, sin esperar.
 */
import { MissingEnvVarError } from "@/lib/env-errors";
import { dispatchRepositoryEvent } from "@/lib/worker/github-actions";

export const TTS_DISPATCH_EVENT_TYPE = "text-to-speech";

export async function dispatchTtsJob(jobId: string): Promise<void> {
  const hasGitHub = Boolean(process.env.GH_WORKER_TOKEN && process.env.GH_WORKER_REPO);
  if (process.env.VERCEL === "1" || hasGitHub) {
    if (!process.env.GH_WORKER_TOKEN) throw new MissingEnvVarError("GH_WORKER_TOKEN");
    if (!process.env.GH_WORKER_REPO) throw new MissingEnvVarError("GH_WORKER_REPO");
    await dispatchRepositoryEvent(TTS_DISPATCH_EVENT_TYPE, { jobId });
    return;
  }
  const { runTtsJobWithDefaults } = await import("./worker-deps");
  void runTtsJobWithDefaults(jobId).catch((err) => console.error("[atomivid:tts] worker local:", err instanceof Error ? err.message : err));
}
