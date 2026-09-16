import type { RenderWorker } from "./types";
import { MissingEnvVarError } from "@/lib/env-errors";

const GITHUB_API = "https://api.github.com";
const DISPATCH_EVENT_TYPE = "render-video";

/**
 * Error tipado para un fallo HTTP al disparar `repository_dispatch` —
 * separado de un `Error` genérico para que classifyRenderError pueda dar
 * un mensaje seguro y específico según el status (p. ej. 401/403 apunta a
 * un GH_WORKER_TOKEN inválido/expirado, 404 a un GH_WORKER_REPO
 * incorrecto), sin necesitar exponer el cuerpo de la respuesta de GitHub
 * al cliente. El log de servidor (logRenderError) sí registra el mensaje
 * completo vía `error.message`, que incluye el cuerpo truncado.
 */
export class GitHubWorkerDispatchError extends Error {
  constructor(
    public readonly status: number,
    body: string,
  ) {
    super(`No se pudo activar el worker de GitHub Actions (HTTP ${status}): ${body.slice(0, 300)}`);
    this.name = "GitHubWorkerDispatchError";
  }
}

/**
 * Dispara `.github/workflows/render.yml` vía la API de "repository
 * dispatch" de GitHub y retorna de inmediato — el render real corre en el
 * runner de GitHub Actions, no en esta función. El workflow recibe el
 * `requestId` en `client_payload` y llama a `scripts/render-worker.ts`,
 * que ejecuta el mismo `runRenderJob()` que usa el worker inline.
 *
 * Requiere dos variables de entorno (nunca secretos hardcodeados):
 * - GH_WORKER_TOKEN: un Personal Access Token con permiso para disparar
 *   workflows en el repo (fine-grained: "Actions: Read and write"; classic:
 *   scope "repo").
 * - GH_WORKER_REPO: "owner/repo", p. ej. "hanzmo16-png/Atomivid".
 */
export const githubActionsWorker: RenderWorker = {
  name: "github-actions",
  async trigger({ requestId }) {
    const token = process.env.GH_WORKER_TOKEN;
    const repo = process.env.GH_WORKER_REPO;

    // Tipados (no un Error genérico) para que classifyRenderError pueda
    // decirle al cliente exactamente qué variable falta, en vez de un
    // mensaje que suena transitorio ("intenta de nuevo") para un problema
    // de configuración permanente.
    if (!token) throw new MissingEnvVarError("GH_WORKER_TOKEN");
    if (!repo) throw new MissingEnvVarError("GH_WORKER_REPO");

    const res = await fetch(`${GITHUB_API}/repos/${repo}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        event_type: DISPATCH_EVENT_TYPE,
        client_payload: { requestId },
      }),
    });

    if (!res.ok) {
      // No incluir el token ni headers en el mensaje de error — solo el
      // código de estado y el cuerpo de la respuesta de GitHub.
      const body = await res.text().catch(() => "");
      throw new GitHubWorkerDispatchError(res.status, body);
    }
  },
};
