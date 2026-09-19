import type { RenderWorker } from "./types";

/**
 * Corre el pipeline completo en el mismo proceso que respondió la request
 * HTTP — el comportamiento original del proyecto, antes de tener un worker
 * separado. Solo pensado para desarrollo local (o `npm run test:pipeline`)
 * cuando no hay credenciales de GitHub Actions configuradas.
 *
 * NUNCA se selecciona en Vercel — getRenderWorker() (src/lib/worker/
 * index.ts) lo excluye explícitamente ahí, ni siquiera como fallback
 * automático. Incidente real en producción (Código cde1d3da): con
 * GH_WORKER_TOKEN/GH_WORKER_REPO ausentes, el fallback automático a
 * inline intentó cargar @remotion/bundler dentro de la función de Vercel
 * y falló con "Cannot find module '@rspack/binding'" (un binario nativo
 * que Vercel no empaqueta para funciones serverless) — el render
 * pertenece exclusivamente al worker de GitHub Actions en producción; la
 * solución no es instalar ese binario en Vercel, sino que este worker no
 * pueda ejecutarse ahí bajo ninguna circunstancia.
 *
 * Limitación conocida de todas formas (documentada en el README): al no
 * delegar a un proceso aparte, esto sigue atado al límite de duración de
 * la función que lo invoca — relevante solo para quien lo use localmente.
 *
 * runRenderJob se importa de forma perezosa (dentro de trigger, no arriba
 * a nivel de módulo): run-job.ts importa generate-video.ts, que a su vez
 * importa @remotion/bundler y @remotion/renderer a nivel de módulo. Si
 * ese import fuera estático aquí arriba, CUALQUIER ruta que importe
 * @/lib/worker —incluida /api/generate/[id]/render, incluso cuando el
 * worker seleccionado en runtime es "github-actions" y este código nunca
 * se ejecuta— arrastraría la misma cadena de carga externa de Remotion
 * que Turbopack tiene que resolver antes de que el módulo completo esté
 * disponible. Es el mismo mecanismo, ya diagnosticado y corregido antes,
 * que rompía /api/generate/[id]/script con "Failed to load external
 * module @remotion/..." (ver generate-script.ts) — aquí producía el
 * mismo fallo, pero silenciado detrás del mensaje genérico del cliente
 * porque el error ocurre al cargar el módulo, antes de que el try/catch
 * de render/route.ts alrededor de worker.trigger() pueda capturarlo.
 */
export const inlineWorker: RenderWorker = {
  name: "inline",
  async trigger({ requestId, renderAttempt }) {
    const { runRenderJob } = await import("@/lib/video/run-job");
    await runRenderJob(requestId, renderAttempt);
  },
};
