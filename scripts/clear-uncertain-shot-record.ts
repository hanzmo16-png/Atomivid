/**
 * Herramienta de UN SOLO USO, deliberada y manual — borra el registro
 * STARTED huérfano de UN shot AI_RECREATION concreto en Supabase Storage,
 * para casos donde YA se confirmó por fuera (leyendo el log real del run
 * que lo dejó así) que el costo fue $0 — p. ej. un rechazo de moderación
 * de OpenAI ANTES de generar nada, que la API nunca cobra.
 *
 * Esto es exactamente el paso "revisa y, solo si confirmas que NO se
 * cobró, borra manualmente ese registro" que ya pide
 * ProductionAiRecreationUncertainCostStateError — automatizado como
 * script en vez de clicks manuales en el dashboard de Supabase, pero con
 * las MISMAS salvaguardas:
 *   - Nunca corre sobre los 3 shots YA aprobados (b1-s4/b4-s2/b8-s5) —
 *     rechaza explícitamente, sin excepción.
 *   - Nunca borra un registro COMPLETED (protección de doble chequeo:
 *     si ya hay un asset real generado, borrarlo sería perder trabajo
 *     pagado real).
 *   - Recalcula el idempotencyKey exactamente como lo hace la
 *     producción real (buildProductionAiRecreationEntry, mismo texto de
 *     storyboard) — nunca acepta una clave a mano, para no borrar el
 *     registro equivocado.
 *
 * Uso: npx tsx scripts/clear-uncertain-shot-record.ts --shot-id=b2-s3
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const VIDEO_ID = "gobekli-tepe-001";
const STORYBOARD_FILE = path.join(process.cwd(), "content/long-form/gobekli-tepe-001/gobekli-storyboard-003.json");

function parseArgs(argv: string[]) {
  const get = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const found = argv.find((a) => a.startsWith(prefix));
    return found ? found.slice(prefix.length) : undefined;
  };
  const shotId = get("shot-id");
  if (!shotId) throw new Error("Uso: clear-uncertain-shot-record.ts --shot-id=<shotId>");
  return { shotId };
}

async function main() {
  const { shotId } = parseArgs(process.argv.slice(2));

  const { isApprovedVisualTestV2Shot, buildProductionAiRecreationEntry } = await import(
    "../src/lib/video/long-form/production-ai-recreation"
  );
  if (isApprovedVisualTestV2Shot(shotId)) {
    throw new Error(
      `clear-uncertain-shot-record: "${shotId}" es uno de los 3 shots YA APROBADOS del Visual Test V2 — este script ` +
        `NUNCA opera sobre ellos, sin excepción. Nada se tocó.`,
    );
  }

  const raw = JSON.parse(readFileSync(STORYBOARD_FILE, "utf8")) as {
    shots: { shotId: string; beatId: string; queryOrPrompt?: string | null; visualIntent: string }[];
  };
  const sbShot = raw.shots.find((s) => s.shotId === shotId);
  if (!sbShot) {
    throw new Error(`clear-uncertain-shot-record: shot "${shotId}" no existe en el storyboard canónico. Nada se tocó.`);
  }

  const entry = buildProductionAiRecreationEntry({
    id: sbShot.shotId,
    beatId: sbShot.beatId,
    visualIntent: sbShot.queryOrPrompt ?? sbShot.visualIntent,
  });

  const { createServiceClient } = await import("../src/lib/supabase/service");
  const { readVisualTestV2ShotRecord, deleteVisualTestV2ShotRecord, VISUAL_TEST_V2_STORAGE_BUCKET } = await import(
    "../src/lib/video/long-form/visual-test-v2-storage"
  );
  const supabase = createServiceClient();

  const record = await readVisualTestV2ShotRecord(supabase, VISUAL_TEST_V2_STORAGE_BUCKET, VIDEO_ID, entry.idempotencyKey);
  if (!record) {
    console.log(`[clear-uncertain-shot-record] "${shotId}" (idempotencyKey=${entry.idempotencyKey}): no hay ningún registro — nada que borrar.`);
    return;
  }
  if (record.status !== "STARTED") {
    throw new Error(
      `clear-uncertain-shot-record: el registro de "${shotId}" está en estado "${record.status}", no "STARTED" — ` +
        `este script SOLO borra registros STARTED huérfanos (nunca un COMPLETED, para no perder un asset real ya generado). Nada se tocó.`,
    );
  }

  await deleteVisualTestV2ShotRecord(supabase, VISUAL_TEST_V2_STORAGE_BUCKET, VIDEO_ID, entry.idempotencyKey);
  console.log(
    `[clear-uncertain-shot-record] "${shotId}" (idempotencyKey=${entry.idempotencyKey}): registro STARTED borrado. ` +
      `Confirmado por fuera de este script (log del run que lo dejó así) que el costo real fue $0 — rechazo de ` +
      `moderación de OpenAI antes de generar nada. El próximo run tratará este shot como una generación nueva.`,
  );
}

main().catch((err) => {
  console.error("[clear-uncertain-shot-record] fallo:", err);
  process.exit(1);
});
