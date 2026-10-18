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

  const { data: closed } = await service
    .from("video_requests")
    .update({
      status: "failed",
      error_message:
        "El render no terminó a tiempo o el worker falló inesperadamente. Puedes reintentar.",
      progress_stage: null,
    })
    .eq("id", requestId)
    .eq("status", "processing")
    .eq("render_attempts", saved.attempt)
    .select("id");
  // Control de costos (2026-10-18): the timed-out attempt's envelope used to stay OPEN forever. Only its
  // UNUSED part is released (pi_release_job_supply); a paid call left uncertain by the crash stays held in
  // the ledger as SUBMITTED/RECONCILIATION_REQUIRED and is never released here. Only after this run closed
  // the attempt (the CAS above), so a newer attempt's envelope is never touched.
  if (closed?.length) {
    const { releaseUnusedJobSupply } = await import("../src/lib/supply/job");
    await releaseUnusedJobSupply(service, requestId, saved.attempt).catch(() => console.error("RENDER_CLEANUP_RELEASE_UNCONFIRMED"));
  }
}

main().catch(() => {
  console.error("RENDER_CLEANUP_FAILED");
  process.exit(1);
});
