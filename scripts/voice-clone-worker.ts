/**
 * Worker de «Mi voz» en GitHub Actions (.github/workflows/voice-clone.yml,
 * repository_dispatch "clone-voice" desde la app).
 *
 * Uso: VOICE_ID=<uuid> npx tsx scripts/voice-clone-worker.ts
 */
export {};

async function main() {
  const voiceId = process.env.VOICE_ID;
  if (!voiceId) throw new Error("VOICE_ID no está definido");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(".voice-clone.json", JSON.stringify({ voiceId }), { mode: 0o600 });
  const { getVoiceProvider } = await import("../src/lib/providers/voice");
  if (getVoiceProvider().name === "fixture" && process.env.GITHUB_EVENT_NAME === "repository_dispatch") {
    throw new Error("Falta ELEVENLABS_API_KEY en los secrets del worker: no se clona una voz real sin el proveedor real.");
  }
  const { runVoiceCloneJobWithDefaults } = await import("../src/lib/voices/clone-deps");
  const result = await runVoiceCloneJobWithDefaults(voiceId);
  console.log(`[my-voice] voz ${voiceId}: ${result}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
