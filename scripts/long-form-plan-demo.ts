/**
 * Imprime los ProductionPlan de las 3 estrategias para el documental de
 * prueba de ~180 s — salen del MISMO motor que usa la pantalla "Configurar
 * producción" y el worker. Puro: sin red, sin proveedores, sin costo.
 *
 * Uso: npx tsx scripts/long-form-plan-demo.ts
 * (video IA solo aparece con LONG_FORM_AI_VIDEO_ENABLED=true; este script
 * lo fuerza para mostrar el plan cinemático completo)
 */
process.env.LONG_FORM_AI_VIDEO_ENABLED = process.env.LONG_FORM_AI_VIDEO_ENABLED ?? "true";

async function main() {
  const { computeProductionPlan, REAL_LONG_FORM_PROVIDER_NAMES, VISUAL_STRATEGIES } = await import("../src/lib/video/long-form/production-plan");
  const { documentary180sFixture } = await import("../src/lib/video/long-form/test-fixtures");
  const script = documentary180sFixture();
  for (const strategy of VISUAL_STRATEGIES) {
    const p = computeProductionPlan({ beats: script.beats, topic: script.topic, strategy, providers: REAL_LONG_FORM_PROVIDER_NAMES, aiVideoEnabled: true });
    console.log(
      JSON.stringify({
        strategy,
        durationSeconds: p.durationSeconds,
        totalShots: p.shotCount,
        stockArchive: p.stockVideoCount + p.stockImageCount,
        aiImages: p.aiImageCount,
        aiVideoClips: p.aiVideoClipCount,
        aiVideoSecondsOnScreen: p.aiVideoSeconds,
        aiVideoSecondsBilled: p.aiVideoBilledSeconds,
        textCards: p.deterministicCount,
        elevenLabsUsd: p.estimatedVoiceCostUsd,
        openAiImagesUsd: p.estimatedImageCostUsd,
        veoUsd: p.estimatedAiVideoCostUsd,
        totalProviderUsd: p.estimatedProviderCostUsd,
      }),
    );
  }
}

main();
