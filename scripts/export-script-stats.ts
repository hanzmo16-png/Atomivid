/**
 * Lee el `script_json` YA guardado de una solicitud existente y calcula
 * estadísticas de texto (palabras por escena y total). De solo lectura:
 * no llama a Claude ni a ningún proveedor de IA, no genera ni regenera
 * ningún guion — solo lee una columna que ya existe en `video_requests`.
 *
 * Uso: REQUEST_ID=<uuid> npx tsx scripts/export-script-stats.ts
 */
import type { GeneratedScript } from "../src/lib/providers/types";

export {}; // Fuerza scope de módulo — evita colisionar con `main()` de otros scripts.

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

async function main() {
  const requestId = process.env.REQUEST_ID;
  if (!requestId) {
    throw new Error("REQUEST_ID no está definido");
  }

  const { createServiceClient } = await import("../src/lib/supabase/service");
  const service = createServiceClient();

  const { data, error } = await service
    .from("video_requests")
    .select("script_json, duration_seconds, status")
    .eq("id", requestId)
    .single<{ script_json: GeneratedScript | null; duration_seconds: number | null; status: string }>();

  if (error || !data) {
    throw new Error(`No se pudo leer la solicitud ${requestId}: ${error?.message ?? "no encontrada"}`);
  }
  if (!data.script_json) {
    throw new Error(`La solicitud ${requestId} no tiene script_json guardado`);
  }

  const perScene = data.script_json.segments.map((s, i) => ({
    sceneIndex: i,
    words: countWords(s.text),
  }));
  const totalWords = perScene.reduce((sum, s) => sum + s.words, 0);

  console.log(
    `[atomivid:script-stats] requestId=${requestId} status=${data.status} ` +
      `durationSecondsRequested=${data.duration_seconds} totalScenes=${perScene.length} totalWords=${totalWords}`,
  );
  console.log(`[atomivid:script-stats] palabrasPorEscena=${JSON.stringify(perScene)}`);
}

main().catch((err) => {
  console.error("No se pudieron calcular las estadísticas del guion:", err);
  process.exit(1);
});
