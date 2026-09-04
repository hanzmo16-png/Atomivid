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

  const { createServiceClient } = await import("../src/lib/supabase/service");
  const service = createServiceClient();

  const { data: row } = await service
    .from("video_requests")
    .select("status")
    .eq("id", requestId)
    .single<{ status: string }>();

  // Si runRenderJob ya dejó un error más específico (completed o failed),
  // no lo pises con un mensaje genérico.
  if (!row || row.status !== "processing") return;

  await service
    .from("video_requests")
    .update({
      status: "failed",
      error_message:
        "El render no terminó a tiempo o el worker falló inesperadamente. Puedes reintentar.",
      progress_stage: null,
    })
    .eq("id", requestId);
}

main().catch((err) => {
  console.error("No se pudo marcar la solicitud como fallida:", err);
  process.exit(1);
});
