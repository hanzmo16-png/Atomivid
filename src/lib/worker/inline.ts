import type { RenderWorker } from "./types";
import { runRenderJob } from "@/lib/video/run-job";

/**
 * Corre el pipeline completo en el mismo proceso que respondió la request
 * HTTP — el comportamiento original del proyecto, antes de tener un worker
 * separado. Se usa automáticamente cuando no hay credenciales de GitHub
 * Actions configuradas (desarrollo local, `npm run test:pipeline`, o antes
 * de que el usuario configure `GH_WORKER_TOKEN`/`GH_WORKER_REPO`).
 *
 * Limitación conocida (documentada en el README): al no delegar a un
 * proceso aparte, esto sigue atado al límite de duración de la función
 * serverless que lo invoca.
 */
export const inlineWorker: RenderWorker = {
  name: "inline",
  async trigger({ requestId }) {
    await runRenderJob(requestId);
  },
};
