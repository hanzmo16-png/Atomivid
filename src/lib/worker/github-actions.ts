import type { RenderWorker } from "./types";
import { MissingEnvVarError, InvalidEnvVarError } from "@/lib/env-errors";

const GITHUB_API = "https://api.github.com";
const DISPATCH_EVENT_TYPE = "render-video";

// El despacho es una llamada liviana (solo encola el workflow, no espera
// a que corra) — no hay motivo para dejar que un problema de red la
// cuelgue hasta el límite de la función (maxDuration=300s en route.ts).
// Un timeout corto falla rápido y da un mensaje claro en vez de una
// espera larga que el usuario interpreta como que la página se congeló.
const DISPATCH_TIMEOUT_MS = 15_000;

// "owner/repo" de GitHub: sin espacios, sin protocolo/URL completa, un
// solo "/". No valida caracteres exactos permitidos por GitHub (eso lo
// hace la propia API) — solo descarta errores obvios de formato (URL
// completa pegada por error, falta el "/", espacios) antes de gastar una
// llamada de red.
const OWNER_REPO_PATTERN = /^[^\s/]+\/[^\s/]+$/;

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
 * Fallo de red/timeout al intentar contactar la API de GitHub (DNS,
 * conexión rechazada, o venció DISPATCH_TIMEOUT_MS) — distinto de
 * GitHubWorkerDispatchError (que implica que sí hubo respuesta HTTP, solo
 * que con error) para poder darle al cliente un mensaje que sugiera
 * reintentar en vez de apuntar a una variable de configuración.
 */
export class GitHubWorkerNetworkError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`No se pudo contactar la API de GitHub: ${detail}`);
    this.name = "GitHubWorkerNetworkError";
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
 *   este endpoint específico ("Create a repository dispatch event"). Para
 *   un token classic: scope "repo". Para uno fine-grained, la
 *   documentación de GitHub lista "Contents: Read and write" como el
 *   permiso que cubre este endpoint (no "Actions" — ese permiso cubre
 *   gestionar workflow runs/artifacts existentes, no crear el evento de
 *   dispatch); en la práctica, conviene igual otorgar también "Actions:
 *   Read and write" porque el resto del worker (scripts/render-worker.ts,
 *   vía el mismo repo) puede necesitarlo para otras operaciones.
 * - GH_WORKER_REPO: "owner/repo", p. ej. "hanzmo16-png/Atomivid".
 */
export const githubActionsWorker: RenderWorker = {
  name: "github-actions",
  async trigger({ requestId, renderAttempt, mode }) {
    await dispatchRepositoryEvent(DISPATCH_EVENT_TYPE, {
      requestId,
      // `mode` permite a render.yml dar a Long Form su propio timeout y
      // sus credenciales (OpenAI/Veo/confirmación de gasto) sin
      // exponerlas ni cambiar nada para Reel/Avatar.
      ...(renderAttempt === undefined ? {} : { renderAttempt }),
      ...(mode ? { mode } : {}),
    });
  },
};

/**
 * Dispara un workflow por `repository_dispatch` con el `event_type` dado y
 * retorna de inmediato. Lo usan el render (render.yml, "render-video") y
 * «Texto a voz» (tts.yml, "text-to-speech"), con las mismas credenciales y
 * los mismos errores tipados.
 */
export async function dispatchRepositoryEvent(eventType: string, clientPayload: Record<string, unknown>): Promise<void> {
  const token = process.env.GH_WORKER_TOKEN;
  const repo = process.env.GH_WORKER_REPO;

  // Tipados (no un Error genérico) para que classifyRenderError pueda
  // decirle al cliente exactamente qué variable falta, en vez de un
  // mensaje que suena transitorio ("intenta de nuevo") para un problema
  // de configuración permanente.
  if (!token) throw new MissingEnvVarError("GH_WORKER_TOKEN");
  if (!repo) throw new MissingEnvVarError("GH_WORKER_REPO");
  if (!OWNER_REPO_PATTERN.test(repo)) {
    throw new InvalidEnvVarError("GH_WORKER_REPO", '"owner/repo", p. ej. "hanzmo16-png/Atomivid"');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}/repos/${repo}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ event_type: eventType, client_payload: clientPayload }),
      signal: controller.signal,
    });
  } catch (error) {
    // fetch() rechaza (no responde con un status) ante DNS/conexión
    // rechazada, y AbortController produce un DOMException "AbortError"
    // al vencer el timeout — ambos son fallos de red, no de config.
    throw new GitHubWorkerNetworkError(error);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    // No incluir el token ni headers en el mensaje de error — solo el
    // código de estado y el cuerpo de la respuesta de GitHub.
    const body = await res.text().catch(() => "");
    throw new GitHubWorkerDispatchError(res.status, body);
  }
}
