import type { RenderWorker } from "./types";
import { inlineWorker } from "./inline";
import { githubActionsWorker } from "./github-actions";

/**
 * Selecciona el worker de render, igual que `get*Provider()` en
 * src/lib/providers/: forzable por env var, con auto-fallback a "inline"
 * si no hay credenciales de GitHub Actions configuradas.
 */
export function getRenderWorker(): RenderWorker {
  if (process.env.RENDER_WORKER === "inline") return inlineWorker;
  if (process.env.RENDER_WORKER === "github-actions") return githubActionsWorker;

  return process.env.GH_WORKER_TOKEN && process.env.GH_WORKER_REPO
    ? githubActionsWorker
    : inlineWorker;
}

export type { RenderWorker } from "./types";
