/**
 * Punto de entrada del worker de render en GitHub Actions. Lo dispara
 * `.github/workflows/render.yml` vía `repository_dispatch` cuando
 * `/api/generate/[id]/render` llama a la API de GitHub — no corre dentro
 * de Next.js, pero reutiliza exactamente el mismo pipeline
 * (src/lib/video/run-job.ts → src/lib/video/generate.ts) que ya se
 * verifica con `npm run test:pipeline`.
 *
 * Uso: REQUEST_ID=<uuid> npx tsx scripts/render-worker.ts
 */
export {}; // Fuerza scope de módulo — evita colisionar con `main()` de otros scripts.

async function main() {
  const requestId = process.env.REQUEST_ID;
  if (!requestId) {
    throw new Error("REQUEST_ID no está definido");
  }

  // Este worker existe para generar videos reales para usuarios reales —
  // si falta una API key y el pipeline caería a un proveedor fixture
  // (texto/tono/imagen de relleno), mejor fallar con un mensaje claro que
  // entregar un video que no es el que el usuario pidió.
  // El tono genérico del fixture de música es intencional solo para
  // pruebas internas (ver README, "Música de fondo") — nunca debe llegar
  // a un video final para un usuario real, así que también bloquea aquí.
  const { getVoiceProvider } = await import("../src/lib/providers/voice");
  const { getFootageProvider } = await import("../src/lib/providers/footage");
  const { getMusicProvider } = await import("../src/lib/providers/music");
  const voiceName = getVoiceProvider().name;
  const footageName = getFootageProvider().name;
  const musicName = getMusicProvider().name;
  if (voiceName === "fixture" || footageName === "fixture" || musicName === "fixture") {
    throw new Error(
      `Faltan credenciales/configuración reales en los secrets del worker ` +
        `(voz="${voiceName}", footage="${footageName}", música="${musicName}"). ` +
        "Configura ELEVENLABS_API_KEY, PEXELS_API_KEY y al menos una pista de " +
        "música (MUSIC_MANIFEST o MUSIC_TRACK_URLS) antes de usar este worker " +
        "para usuarios reales.",
    );
  }

  const { runRenderJob } = await import("../src/lib/video/run-job");
  await runRenderJob(requestId);
}

main().catch((err) => {
  console.error("Fallo el render en el worker:", err);
  process.exit(1);
});
