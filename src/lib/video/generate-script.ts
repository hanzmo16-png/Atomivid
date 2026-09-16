import { getScriptProvider } from "@/lib/providers/script";
import type { GeneratedScript, ScriptLanguage } from "@/lib/providers/types";

/**
 * Etapa 1 del pipeline: solo el guion. Se guarda para que el usuario lo
 * revise/edite (y pueda regenerar una escena puntual) antes de gastar en
 * voz, footage, música y render.
 *
 * Deliberadamente en su propio archivo, separado de generate-video.ts (que
 * sí necesita @remotion/bundler y @remotion/renderer): esta función la
 * importa la ruta /api/generate/[id]/script, que nunca debería cargar
 * Remotion. Antes vivían en el mismo módulo (generate.ts) — como JS carga
 * el archivo completo al importar cualquiera de sus exports, la ruta de
 * guion arrastraba Remotion igual, aunque nunca lo usara. Eso rompía en
 * producción con "Failed to load external module @remotion/bundler" al
 * cargar la función (Remotion está marcado como serverExternalPackages en
 * next.config.ts precisamente porque usa requires dinámicos por
 * plataforma que el bundler no puede resolver estáticamente — y el
 * tracing de Vercel para la función de guion, que nunca ejecuta ese
 * código, no incluía los archivos que esos requires necesitan).
 */
export async function generateScriptForRequest({
  topic,
  style,
  durationSeconds,
  language = "es",
}: {
  topic: string;
  style: string;
  durationSeconds: number;
  language?: ScriptLanguage;
}): Promise<{ script: GeneratedScript; providerName: string }> {
  const scriptProvider = getScriptProvider();
  const script = await scriptProvider.generateScript({ topic, style, durationSeconds, language });
  return { script, providerName: scriptProvider.name };
}
