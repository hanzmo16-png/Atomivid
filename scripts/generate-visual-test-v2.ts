/**
 * Ejecutor del VISUAL TEST V2 — genera las 3 imágenes AI_RECREATION
 * seleccionadas para validar el estilo visual de VIDEO #001 antes de
 * producir el resto (ver visual-test-v2.ts para el manifest y
 * HANDOFF-PRODUCTION-V1.md sección 14 para el contexto completo).
 *
 * NO SE HA EJECUTADO TODAVÍA. Este archivo queda listo para que, cuando
 * exista OPENAI_API_KEY y el usuario autorice explícitamente el
 * siguiente checkpoint, correrlo sea un solo comando — sin tener que
 * reconstruir nada de la lógica de idempotencia/costo desde cero.
 *
 * Seguridad (mismo criterio que produce-long-form-video.ts):
 *   - Exige --confirm=YES_SPEND_REAL_MONEY (string exacto) — sin eso,
 *     lanza antes de tocar OPENAI_API_KEY siquiera.
 *   - openaiImageProvider.generateImage() ya lanza "not_configured" si
 *     falta OPENAI_API_KEY (ver src/lib/providers/image/openai.ts) — este
 *     script no intenta rodear eso ni caer a fixture.
 *   - Por cada shot: shouldGenerate() se consulta ANTES de llamar a la
 *     API — si el archivo de salida ya existe (mismo shotId+prompt+
 *     parámetros → mismo idempotencyKey → mismo path), se salta sin
 *     llamar a la API, así que correr este script dos veces nunca genera
 *     ni cobra doble por el mismo shot.
 *   - assertCanSpend() se consulta ANTES de cada llamada (bloquea si
 *     excedería $0.50 de esta categoría o el hard stop de $3.00 total de
 *     VIDEO #001) y recordSpendToDisk() se anota INMEDIATAMENTE después
 *     de una llamada exitosa, antes de seguir con el siguiente shot — así
 *     un crash a mitad de las 3 imágenes dejaría el gasto real ya
 *     registrado para la siguiente ejecución.
 *
 * Uso (cuando corresponda, NO ahora):
 *   OPENAI_API_KEY=... npx tsx scripts/generate-visual-test-v2.ts --confirm=YES_SPEND_REAL_MONEY
 */
import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv: string[]) {
  const get = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const found = argv.find((a) => a.startsWith(prefix));
    return found ? found.slice(prefix.length) : undefined;
  };
  return { confirm: get("confirm") };
}

const REQUIRED_CONFIRM_VALUE = "YES_SPEND_REAL_MONEY";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.confirm !== REQUIRED_CONFIRM_VALUE) {
    throw new Error(
      `Este script gasta dinero real (OpenAI Images). Falta --confirm=${REQUIRED_CONFIRM_VALUE} — nunca se ejecuta sin esa confirmación explícita.`,
    );
  }

  const { buildVisualTestV2Manifest, shouldGenerate, toImageGenerationRequest } = await import("../src/lib/video/long-form/visual-test-v2");
  const { assertCanSpend, recordSpendToDisk, readCostLedgerFromDisk, totalSpentUsd } = await import(
    "../src/lib/video/long-form/video-cost-guard"
  );
  const { openaiImageProvider } = await import("../src/lib/providers/image/openai");

  const manifest = buildVisualTestV2Manifest();
  console.log(`[visual-test-v2] ${manifest.shots.length} shots, tope $${manifest.maxTotalUsd}, estimado $${manifest.estimatedTotalUsd}`);

  const ledgerBefore = readCostLedgerFromDisk(manifest.videoId);
  console.log(`[visual-test-v2] ledger actual de ${manifest.videoId}: $${totalSpentUsd(ledgerBefore).toFixed(4)} gastados hasta ahora`);

  await fs.mkdir(path.dirname(manifest.shots[0].outputPath), { recursive: true });

  for (const shot of manifest.shots) {
    if (!shouldGenerate(shot)) {
      console.log(`[visual-test-v2] ${shot.shotId}: ya existe en ${shot.outputPath} — se salta (idempotencia)`);
      continue;
    }

    const ledgerNow = readCostLedgerFromDisk(manifest.videoId);
    assertCanSpend(ledgerNow, "visual_test_v2", shot.estimatedCostUsd); // lanza ANTES de llamar si excedería el tope

    console.log(`[visual-test-v2] generando ${shot.shotId}...`);
    const asset = await openaiImageProvider.generateImage(toImageGenerationRequest(shot));
    await fs.writeFile(shot.outputPath, asset.buffer);

    // Se anota el costo REAL devuelto por el proveedor (no el estimado) — ver openai.ts computeUsageCostUsd.
    recordSpendToDisk(manifest.videoId, "visual_test_v2", asset.costUsd, `${shot.shotId} generado`);
    console.log(`[visual-test-v2] ${shot.shotId}: OK, costo real $${asset.costUsd.toFixed(4)}, guardado en ${shot.outputPath}`);
  }

  const ledgerAfter = readCostLedgerFromDisk(manifest.videoId);
  console.log(`[visual-test-v2] terminado. Gasto total acumulado de ${manifest.videoId}: $${totalSpentUsd(ledgerAfter).toFixed(4)}`);
}

main().catch((err) => {
  console.error("[visual-test-v2] fallo:", err);
  process.exit(1);
});
