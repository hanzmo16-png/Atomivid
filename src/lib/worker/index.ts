import type { RenderWorker } from "./types";
import { inlineWorker } from "./inline";
import { githubActionsWorker } from "./github-actions";
import { MissingEnvVarError } from "@/lib/env-errors";

/**
 * true dentro de cualquier función de Vercel (Production, Preview, o
 * cualquier despliegue) — Vercel define esta variable siempre, sin
 * importar el entorno. El worker inline corre el pipeline completo de
 * Remotion (@remotion/bundler, que a su vez necesita @rspack/binding, un
 * binario nativo) en el mismo proceso — Vercel no empaqueta ese binario
 * para funciones serverless.
 *
 * Se evalúa en cada llamada (no como constante de módulo) por el mismo
 * motivo que el resto de las variables de este archivo: process.env
 * puede diferir entre llamadas en pruebas, y una constante fijada al
 * importar el módulo quedaría congelada con el valor de la primera vez
 * que se cargó, ignorando cualquier cambio posterior.
 *
 * Incidente real en producción (Código cde1d3da): con RENDER_WORKER sin
 * definir y GH_WORKER_TOKEN/GH_WORKER_REPO ausentes, getRenderWorker()
 * caía en el fallback automático a "inline", que intentó cargar
 * @remotion/bundler dentro de la función de Vercel y falló con "Cannot
 * find module '@rspack/binding'" — el log confirmó que Remotion se
 * ejecutó donde nunca debió hacerlo. La solución no es instalar
 * @rspack/binding en Vercel (el render no pertenece ahí): es que el
 * inline jamás pueda seleccionarse, ni por fallback automático ni por
 * override explícito, mientras el código corre en Vercel.
 */
function isRunningOnVercel(): boolean {
  return process.env.VERCEL === "1";
}

/**
 * Selecciona el worker de render — mismo patrón que `get*Provider()` en
 * src/lib/providers/, con una excepción no negociable: en Vercel, el
 * worker inline nunca puede seleccionarse (ver isRunningOnVercel arriba),
 * así que ahí el resultado es siempre "github-actions", o una excepción
 * tipada y explícita (MissingEnvVarError, con el nombre exacto de la
 * variable) si faltan sus credenciales — nunca un fallback silencioso.
 * Fuera de Vercel (desarrollo local, `npm run test:pipeline`, CI de este
 * repo) el comportamiento es el de siempre: forzable por RENDER_WORKER,
 * con auto-fallback a inline si no hay credenciales de GitHub Actions.
 */
export function getRenderWorker(): RenderWorker {
  if (isRunningOnVercel()) {
    if (!process.env.GH_WORKER_TOKEN) throw new MissingEnvVarError("GH_WORKER_TOKEN");
    if (!process.env.GH_WORKER_REPO) throw new MissingEnvVarError("GH_WORKER_REPO");
    return githubActionsWorker;
  }

  if (process.env.RENDER_WORKER === "inline") return inlineWorker;
  if (process.env.RENDER_WORKER === "github-actions") return githubActionsWorker;

  return process.env.GH_WORKER_TOKEN && process.env.GH_WORKER_REPO
    ? githubActionsWorker
    : inlineWorker;
}

export type { RenderWorker } from "./types";
