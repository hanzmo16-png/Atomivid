/**
 * Worker de «Texto a voz» en GitHub Actions (.github/workflows/tts.yml,
 * disparado por repository_dispatch "text-to-speech" desde la app).
 *
 * Uso: TTS_JOB_ID=<uuid> npx tsx scripts/tts-worker.ts
 */
export {};

async function main() {
  const jobId = process.env.TTS_JOB_ID;
  if (!jobId) throw new Error("TTS_JOB_ID no está definido");
  const { writeFile } = await import("node:fs/promises");
  // Para que la limpieza (mark-tts-failed.ts) sepa qué pieza atender si este paso se corta.
  await writeFile(".tts-job.json", JSON.stringify({ jobId }), { mode: 0o600 });

  // Una pieza de una usuaria real nunca se genera con la voz de prueba.
  const { getVoiceProvider } = await import("../src/lib/providers/voice");
  if (getVoiceProvider().name === "fixture" && process.env.GITHUB_EVENT_NAME === "repository_dispatch") {
    throw new Error("Falta ELEVENLABS_API_KEY en los secrets del worker: no se genera una pieza real con la voz de prueba.");
  }
  const { runTtsJobWithDefaults } = await import("../src/lib/tts/worker-deps");
  const result = await runTtsJobWithDefaults(jobId);
  console.log(`[tts] pieza ${jobId}: ${result}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
