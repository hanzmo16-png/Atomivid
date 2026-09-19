/**
 * Red de seguridad de timeout: si el paso "Renderizar video" del workflow
 * de GitHub Actions falla o se corta por `timeout-minutes`, este script
 * corre después con `if: failure()` para dejar la solicitud en "failed"
 * en vez de "processing" para siempre (el usuario podría quedar sin poder
 * reintentar nunca si nadie actualiza el estado).
 *
 * Uso: REQUEST_ID=<uuid> npx tsx scripts/mark-render-failed.ts
 */
export {}; // Fuerza scope de módulo — evita colisionar con `main()` de otros scripts.

async function main() {
  const requestId = process.env.REQUEST_ID;
  if (!requestId) return;

  const { readFile } = await import("node:fs/promises");
  const saved = await readFile(".render-attempt.json", "utf8").then(JSON.parse).catch(() => null);
  if (!saved || saved.requestId !== requestId || !Number.isInteger(saved.attempt)) return;
  const { createServiceClient } = await import("../src/lib/supabase/service");
  const service = createServiceClient();

  await service
    .from("video_requests")
    .update({
      status: "failed",
      error_message:
        "El render no terminó a tiempo o el worker falló inesperadamente. Puedes reintentar.",
      progress_stage: null,
    })
    .eq("id", requestId)
    .eq("status", "processing")
    .eq("render_attempts", saved.attempt);
}

main().catch(() => {
  console.error("RENDER_CLEANUP_FAILED");
  process.exit(1);
});
