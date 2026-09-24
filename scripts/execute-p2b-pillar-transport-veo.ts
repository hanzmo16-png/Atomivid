/**
 * P2B — ejecución administrativa de UNA ÚNICA generación real de video vía
 * Google Veo 3.1 Fast, autorizada explícitamente por Hans para el shot
 * "Pillar Transport" (gobekli-tepe-ai-video-benchmark-v2-active).
 *
 * Wrapper CLI fino — toda la lógica de seguridad/ejecución vive en
 * src/lib/video/long-form/p2b-pillar-transport-execution.ts (compartida
 * con el endpoint administrativo de Vercel, ver
 * src/app/api/admin/p2b-execute-pillar-transport-veo/route.ts — misma
 * lógica, nunca duplicada). NUNCA es un endpoint público.
 *
 * Uso (server-side, con VEO_API_KEY y P2B_PILLAR_TRANSPORT_VEO_EXECUTE=true
 * en el entorno):
 *   npx tsx scripts/execute-p2b-pillar-transport-veo.ts
 */
export {}; // Fuerza scope de módulo — evita colisionar con `main()` de otros scripts.

async function main() {
  const { executeP2BPillarTransportVeoOnce, ABSOLUTE_MAX_COST_USD } = await import("../src/lib/video/long-form/p2b-pillar-transport-execution");

  console.log("=".repeat(72));
  console.log("[P2B] Ejecución administrativa de UNA generación real — Veo 3.1 Fast — Pillar Transport");
  console.log(`[P2B] techo absoluto autorizado: $${ABSOLUTE_MAX_COST_USD}`);
  console.log("=".repeat(72));

  const result = await executeP2BPillarTransportVeoOnce();

  if (!result.preflightPassed) {
    console.log("\n[P2B] RUNTIME PRE-CHECK: FAIL — ABORTANDO SIN LLAMAR A GOOGLE.");
    for (const f of result.failures) console.log(`  - ${f.check}: ${f.detail}`);
    console.log("\n[P2B] REAL VIDEO GENERATIONS ATTEMPTED: 0/1");
    process.exit(1);
  }

  console.log("\n[P2B] RUNTIME PRE-CHECK: PASS.");

  if (result.success) {
    console.log(`\n[P2B] Google respondió con éxito. providerJobId=${result.providerJobId}, generationTimeMs=${result.generationTimeMs}`);
    console.log(`[P2B] Validación del clip: ${JSON.stringify(result.validation)}`);
    console.log(`[P2B] Clip guardado localmente en: ${result.storedLocallyAt} (Supabase Storage real no disponible en este proceso — ver informe P2B, sección Storage).`);
    console.log("\n" + "=".repeat(72));
    console.log("[P2B] REAL VIDEO GENERATIONS ATTEMPTED: 1/1");
    console.log(`[P2B] SUCCESSFUL REAL VIDEO GENERATIONS: ${result.validation.valid ? "1/1" : "0/1 (generó, pero no pasó validación)"}`);
    console.log(`[P2B] ACTUAL COST: $${result.actualCostUsd}`);
    console.log("=".repeat(72));
  } else {
    console.log("\n" + "=".repeat(72));
    console.log("[P2B] FALLO en la generación real — NO se reintenta.");
    console.log(`  reason: ${result.errorReason}`);
    console.log(`  providerId: ${result.errorProviderId}`);
    console.log(`  message (sanitizado, sin secretos): ${result.errorMessage}`);
    console.log(`  generationTimeMs: ${result.generationTimeMs}`);
    console.log("[P2B] REAL VIDEO GENERATIONS ATTEMPTED: 1/1");
    console.log("[P2B] SUCCESSFUL REAL VIDEO GENERATIONS: 0/1");
    console.log("=".repeat(72));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[P2B] fallo inesperado del script:", err);
  process.exit(1);
});
