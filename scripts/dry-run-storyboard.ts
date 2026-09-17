/**
 * Modo dry-run del Visual Director: genera storyboard + prompts +
 * selección prevista de proveedores + costos estimados + duraciones +
 * fallbacks + prompt musical, y los imprime como JSON — SIN llamar a
 * ninguna API de pago ni renderizar un video completo. Por defecto usa
 * SIEMPRE el guion fixture (cero costo, cero red); pásale
 * DRY_RUN_SCRIPT_PROVIDER=anthropic explícitamente si además quieres
 * gastar en la generación del guion real (nunca por defecto).
 *
 * El storyboard en sí respeta VISUAL_DIRECTOR_ENABLED/ANTHROPIC_API_KEY
 * igual que en producción (ver src/lib/video/storyboard/index.ts) — sin
 * esas dos cosas, cae automáticamente al modo simulado (cero costo).
 *
 * Uso: npx tsx scripts/dry-run-storyboard.ts
 * (opcionalmente con DRY_RUN_TOPIC, DRY_RUN_STYLE, DRY_RUN_LANGUAGE,
 * DRY_RUN_DURATION_SECONDS, DRY_RUN_SCRIPT_PROVIDER en el entorno)
 */
export {}; // Fuerza scope de módulo — evita colisionar con `main()` de otros scripts.

async function main() {
  const topic = process.env.DRY_RUN_TOPIC || "La disciplina te lleva más lejos que la motivación";
  const style = process.env.DRY_RUN_STYLE || "Motivacional";
  const language = (process.env.DRY_RUN_LANGUAGE === "en" ? "en" : "es") as "es" | "en";
  const durationSeconds = Number(process.env.DRY_RUN_DURATION_SECONDS || "30");
  const useRealScript = process.env.DRY_RUN_SCRIPT_PROVIDER === "anthropic";

  const { buildStoryboard } = await import("../src/lib/video/storyboard");
  const { estimateStoryboardCost } = await import("../src/lib/video/cost-estimator");
  const { getFeatureFlags } = await import("../src/lib/video/feature-flags");
  const { buildMusicPrompt } = await import("../src/lib/providers/music/beatoven");

  let script;
  if (useRealScript) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "DRY_RUN_SCRIPT_PROVIDER=anthropic requiere ANTHROPIC_API_KEY (esto SÍ tiene costo real de guion, aunque el resto del dry-run siga siendo gratis).",
      );
    }
    const { generateScript } = await import("../src/lib/ai/script");
    script = await generateScript({ topic, style, durationSeconds, language });
  } else {
    const { fixtureScriptProvider } = await import("../src/lib/providers/script/fixture");
    script = await fixtureScriptProvider.generateScript({ topic, style, durationSeconds, language });
  }

  const { storyboard, source } = await buildStoryboard(script, language);
  const flags = getFeatureFlags();
  // Tarifas de referencia solo para la estimación del dry-run (no gastan
  // nada) — mismas fuentes/caveats documentados en cada adaptador real.
  const referenceImageCostUsd = Number(process.env.OPENAI_IMAGE_ESTIMATED_COST_USD || "0.05");
  const referencePremiumSecondCostUsd = Number(process.env.RUNWAY_COST_USD_PER_SECOND || "0.05");
  const costEstimate = estimateStoryboardCost(storyboard.scenes, referenceImageCostUsd, referencePremiumSecondCostUsd);

  const musicPrompt = buildMusicPrompt({ durationSeconds, style, topic, scriptText: script.segments.map((s) => s.text).join(" "), language });

  const report = {
    input: { topic, style, language, durationSeconds },
    scriptProvider: useRealScript ? "anthropic" : "fixture",
    storyboardSource: source,
    featureFlags: flags,
    storyboard,
    costEstimate,
    musicPrompt,
    note:
      "Ningún proveedor de pago (OpenAI/Runway/Beatoven) fue llamado en este dry-run — solo se estimó su costo con las tarifas de referencia configuradas.",
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error("Dry-run falló:", err);
  process.exit(1);
});
