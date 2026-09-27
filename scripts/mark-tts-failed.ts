/**
 * Red de seguridad de tts.yml: si el worker se corta (timeout, runner
 * caído), la pieza queda «failed» con un mensaje claro en vez de
 * «processing» para siempre. Los fragmentos ya generados se conservan en
 * la caché y un reintento no los vuelve a cobrar. Una mezcla cortada queda
 * «failed» sin tocar la narración.
 *
 * Uso: TTS_JOB_ID=<uuid> npx tsx scripts/mark-tts-failed.ts
 */
export {};

async function main() {
  const jobId = process.env.TTS_JOB_ID;
  if (!jobId) return;
  const { readFile } = await import("node:fs/promises");
  const saved = await readFile(".tts-job.json", "utf8").then(JSON.parse).catch(() => null);
  if (!saved || saved.jobId !== jobId) return;
  const { createServiceClient } = await import("../src/lib/supabase/service");
  const service = createServiceClient();
  const now = new Date().toISOString();
  await service
    .from("tts_jobs")
    .update({
      status: "failed",
      error_message: "El audio no terminó a tiempo. Lo ya generado se conserva: puedes reintentar sin volver a pagarlo.",
      updated_at: now,
    })
    .eq("id", jobId)
    .eq("status", "processing");
  await service
    .from("tts_jobs")
    .update({
      mix_status: "failed",
      mix_error: "La versión con música no terminó a tiempo. La narración se conserva; puedes reintentar la mezcla.",
      updated_at: now,
    })
    .eq("id", jobId)
    .eq("mix_status", "processing");
}

main().catch(() => {
  console.error("TTS_CLEANUP_FAILED");
  process.exit(1);
});
