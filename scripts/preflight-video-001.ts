/**
 * PREFLIGHT GRATUITO — VIDEO #001 (Göbekli Tepe), FAIL CLOSED.
 *
 * Corre ANTES de cualquier llamada paga en el workflow de GitHub Actions
 * dedicado a VIDEO #001 (.github/workflows/produce-video-001.yml). Hace
 * CERO llamadas a OpenAI/ElevenLabs — solo: (a) verifica PRESENCIA (nunca
 * valores) de credenciales, (b) confirma que Supabase Storage/el bucket
 * "videos"/el ledger durable son accesibles, (c) recomputa el estado
 * esperado (gasto acumulado, presupuesto restante, conteos de shots/
 * beats/assets) contra la base canónica del video y contra el ledger
 * REAL, y (d) valida estructuralmente que ningún shot de texto/diagrama/
 * mapa puede quedar como placeholder.
 *
 * Si CUALQUIER verificación falla: imprime exactamente qué falta/no
 * cuadra, sale con código != 0, y el workflow NUNCA llega al job de
 * producción real (ver needs: preflight + if: success() en el workflow).
 * Nunca hace fallback silencioso ni intenta "arreglar" nada por su cuenta.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const VIDEO_ID = "gobekli-tepe-001";
const CONTENT_DIR = path.join(process.cwd(), "content/long-form/gobekli-tepe-001");
const SCRIPT_FILE = path.join(CONTENT_DIR, "gobekli-script-003-current.json");
const STORYBOARD_FILE = path.join(CONTENT_DIR, "gobekli-storyboard-003.json");
const MANIFEST_FILE = path.join(CONTENT_DIR, "gobekli-asset-manifest-003.json");

const EXPECTED_TOTAL_SHOTS = 45;
const EXPECTED_TTS_BEATS = 13;
const EXPECTED_AI_RECREATION_TOTAL = 11;
const EXPECTED_AI_RECREATION_REMAINING = 8;
const EXPECTED_STOCK_REAL = 4;
// Piso del gasto acumulado ya confirmado por el usuario antes de que
// existiera este workflow (las 3 imágenes del Visual Test V2) — el
// ledger real SOLO puede crecer desde acá a medida que corren fases
// reales sucesivas (TTS, imágenes nuevas) entre ejecuciones del
// workflow, nunca bajar ni reiniciarse. Comparar contra un monto EXACTO
// fijo (en vez de un piso) rompería el preflight en la primera ejecución
// real exitosa parcial — que es precisamente lo esperado y deseable.
const CONFIRMED_SPENT_FLOOR_USD = 0.1681;
const SPENT_TOLERANCE_USD = 0.0001;

type CheckResult = { name: string; ok: boolean; detail: string };
const results: CheckResult[] = [];

function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`[preflight] ${ok ? "OK  " : "FAIL"} — ${name}: ${detail}`);
}

async function main() {
  console.log(`[preflight] VIDEO #001 (${VIDEO_ID}) — preflight gratuito, fail-closed. Cero llamadas pagas en este script.`);

  // --- 1. Presencia de credenciales (SOLO presencia, nunca se imprime el valor) ---
  const REQUIRED_ENV_VARS = [
    "OPENAI_API_KEY",
    "ELEVENLABS_API_KEY",
    "PEXELS_API_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "NEXT_PUBLIC_SUPABASE_URL",
  ] as const;
  for (const name of REQUIRED_ENV_VARS) {
    const present = !!process.env[name]?.trim();
    record(`credencial presente: ${name}`, present, present ? "presente (valor no verificado ni impreso)" : "AUSENTE");
  }

  // ELEVENLABS_VOICE_ID/ELEVENLABS_MODEL_ID son overrides OPCIONALES — si
  // faltan, src/lib/ai/voice.ts ya cae a su voiceId/modelId por defecto
  // (los mismos ya usados por el resto de la app, Shorts incluido), así
  // que su ausencia nunca debe bloquear el preflight — solo se informa
  // cuál identidad de voz se usará.
  for (const name of ["ELEVENLABS_VOICE_ID", "ELEVENLABS_MODEL_ID"] as const) {
    const present = !!process.env[name]?.trim();
    console.log(`[preflight] INFO — ${name}: ${present ? "presente (override activo, valor no impreso)" : "ausente (se usará el default de src/lib/ai/voice.ts)"}`);
  }

  const missingCreds = results.filter((r) => !r.ok);
  if (missingCreds.length > 0) {
    finish("faltan credenciales — no se intenta ninguna verificación adicional que dependa de ellas");
    return;
  }

  // --- 2. Providers reales resuelven sin caer a fixture (mismo código que usará la producción real; cero llamadas pagas, solo construye los clientes) ---
  try {
    process.env.LONG_FORM_REAL_RUN_CONFIRM = "YES_SPEND_REAL_MONEY";
    const { resolveLongFormProviders } = await import("../src/lib/video/long-form/mode");
    const providers = resolveLongFormProviders("real");
    const allReal =
      providers.voiceProvider.name !== "fixture" &&
      providers.footageProvider.name !== "fixture" &&
      providers.imageProvider.name !== "fixture" &&
      providers.musicProvider.name !== "fixture";
    record(
      "proveedores reales resuelven (voz/footage/imagen/música)",
      allReal,
      JSON.stringify({
        voice: providers.voiceProvider.name,
        footage: providers.footageProvider.name,
        image: providers.imageProvider.name,
        music: providers.musicProvider.name,
      }),
    );
  } catch (err) {
    record("proveedores reales resuelven (voz/footage/imagen/música)", false, String(err));
  }

  // --- 3. Supabase Storage / bucket "videos" / ledger durable accesibles ---
  let ledgerSpent: number | undefined;
  try {
    const { createServiceClient } = await import("../src/lib/supabase/service");
    const { readVisualTestV2Ledger, VISUAL_TEST_V2_STORAGE_BUCKET } = await import(
      "../src/lib/video/long-form/visual-test-v2-storage"
    );
    const { totalSpentUsd, VIDEO_001_HARD_STOP_USD } = await import("../src/lib/video/long-form/video-cost-guard");
    const supabase = createServiceClient();

    const { error: bucketError } = await supabase.storage.from(VISUAL_TEST_V2_STORAGE_BUCKET).list("long-form", { limit: 1 });
    record("bucket Supabase Storage accesible", !bucketError, bucketError ? bucketError.message : `bucket "${VISUAL_TEST_V2_STORAGE_BUCKET}" accesible`);

    const ledger = await readVisualTestV2Ledger(supabase, VISUAL_TEST_V2_STORAGE_BUCKET, VIDEO_ID);
    const spent = totalSpentUsd(ledger);
    ledgerSpent = spent;
    record("ledger durable accesible", true, `${ledger.entries.length} entradas, gasto acumulado leído=$${spent.toFixed(4)}`);

    const spentAtLeastFloor = spent >= CONFIRMED_SPENT_FLOOR_USD - SPENT_TOLERANCE_USD;
    record(
      `gasto acumulado >= piso confirmado ($${CONFIRMED_SPENT_FLOOR_USD.toFixed(4)}, Visual Test V2)`,
      spentAtLeastFloor,
      `leído=$${spent.toFixed(4)} — el ledger nunca debe mostrar MENOS que el gasto ya confirmado antes de este workflow (indicaría un ledger corrupto/reiniciado)`,
    );

    const remaining = round4(VIDEO_001_HARD_STOP_USD - spent);
    const withinHardStopAlready = spent <= VIDEO_001_HARD_STOP_USD;
    record(
      `gasto acumulado dentro del hard stop (presupuesto restante real=$${remaining.toFixed(4)} de $${VIDEO_001_HARD_STOP_USD.toFixed(2)})`,
      withinHardStopAlready,
      `gasto acumulado=$${spent.toFixed(4)}, restante=$${remaining.toFixed(4)}`,
    );
  } catch (err) {
    record("Supabase Storage / bucket / ledger accesibles", false, String(err));
  }

  // --- 4. Los 3 shots ya aprobados deben validar como REUSE (nunca se regeneran) ---
  try {
    const { createServiceClient } = await import("../src/lib/supabase/service");
    const { buildVisualTestV2Manifest } = await import("../src/lib/video/long-form/visual-test-v2");
    const { VISUAL_TEST_V2_REAL_SHOT_IDS } = await import("../src/lib/video/long-form/visual-test-v2-real");
    const { readVisualTestV2ShotRecord, validateExistingVisualTestV2Image, VISUAL_TEST_V2_STORAGE_BUCKET } = await import(
      "../src/lib/video/long-form/visual-test-v2-storage"
    );
    const supabase = createServiceClient();
    const manifest = buildVisualTestV2Manifest();

    for (const shotId of VISUAL_TEST_V2_REAL_SHOT_IDS) {
      const entry = manifest.shots.find((s) => s.shotId === shotId);
      if (!entry) {
        record(`shot aprobado ${shotId} = REUSE`, false, "no está en buildVisualTestV2Manifest()");
        continue;
      }
      const rec = await readVisualTestV2ShotRecord(supabase, VISUAL_TEST_V2_STORAGE_BUCKET, VIDEO_ID, entry.idempotencyKey);
      const valid = rec?.status === "COMPLETED" && (await validateExistingVisualTestV2Image(supabase, VISUAL_TEST_V2_STORAGE_BUCKET, rec));
      record(`shot aprobado ${shotId} = REUSE`, !!valid, valid ? "COMPLETED, checksum válido" : `status=${rec?.status ?? "sin registro"} — NUNCA se regenera automáticamente`);
    }
  } catch (err) {
    record("validación de los 3 shots ya aprobados", false, String(err));
  }

  // --- 5. Base canónica: storyboard = 45 shots, 11 AI_RECREATION (8 restantes), 4 STOCK_REAL, 30 TEXT/DETERMINISTIC ---
  let storyboardShotsFlat: { shotId: string; assetType: string; hybridClassification?: string; visualIntent: string; licensing?: { status?: string } | null }[] = [];
  try {
    const raw = JSON.parse(readFileSync(STORYBOARD_FILE, "utf8")) as {
      meta: { videoId: string; totalShots: number };
      shots: { shotId: string; assetType: string; hybridClassification?: string; visualIntent: string; licensing?: { status?: string } | null }[];
    };
    storyboardShotsFlat = raw.shots;
    record("storyboard videoId correcto", raw.meta.videoId === VIDEO_ID, `videoId="${raw.meta.videoId}"`);
    record(`storyboard = ${EXPECTED_TOTAL_SHOTS} shots`, raw.shots.length === EXPECTED_TOTAL_SHOTS, `${raw.shots.length} shots en el archivo`);

    const aiShots = raw.shots.filter((s) => s.hybridClassification === "AI_RECREATION");
    record(`${EXPECTED_AI_RECREATION_TOTAL} shots AI_RECREATION en total`, aiShots.length === EXPECTED_AI_RECREATION_TOTAL, `${aiShots.length} encontrados`);

    const { VISUAL_TEST_V2_REAL_SHOT_IDS } = await import("../src/lib/video/long-form/visual-test-v2-real");
    const approvedSet = new Set<string>(VISUAL_TEST_V2_REAL_SHOT_IDS);
    const remaining = aiShots.filter((s) => !approvedSet.has(s.shotId));
    record(
      `exactamente ${EXPECTED_AI_RECREATION_REMAINING} AI_RECREATION restantes por generar`,
      remaining.length === EXPECTED_AI_RECREATION_REMAINING,
      `restantes=${remaining.length} (${remaining.map((s) => s.shotId).join(", ")})`,
    );

    const stockShots = raw.shots.filter((s) => s.hybridClassification === "STOCK_REAL");
    record(`${EXPECTED_STOCK_REAL} shots STOCK_REAL`, stockShots.length === EXPECTED_STOCK_REAL, `${stockShots.length} encontrados: ${stockShots.map((s) => s.shotId).join(", ")}`);
  } catch (err) {
    record("lectura/validación del storyboard canónico", false, String(err));
  }

  // --- 6. Guion: exactamente 13 beats narrados, contenido NO fixture ---
  try {
    const { loadScriptFromFile } = await import("../src/lib/video/long-form/script-loader");
    const loaded = loadScriptFromFile(SCRIPT_FILE);
    record(`guion = ${EXPECTED_TTS_BEATS} beats (${EXPECTED_TTS_BEATS} síntesis TTS pendientes/reutilizables según caché)`, loaded.beats.length === EXPECTED_TTS_BEATS, `${loaded.beats.length} beats leídos`);
    record("guion NO es contenido fixture (0 fixtures requerido)", loaded.isFixtureContent === false, `isFixtureContent=${loaded.isFixtureContent}`);
  } catch (err) {
    record("lectura/validación del guion canónico", false, String(err));
  }

  // --- 7. Asset manifest válido y consistente con el storyboard ---
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as {
      videoId: string;
      totalShots: number;
      shots: { shotId: string; assetClass: string; licenseStatus?: string }[];
    };
    record("asset manifest videoId correcto", manifest.videoId === VIDEO_ID, `videoId="${manifest.videoId}"`);
    record(`asset manifest = ${EXPECTED_TOTAL_SHOTS} shots`, manifest.shots.length === EXPECTED_TOTAL_SHOTS, `${manifest.shots.length} shots`);
    const stockEntries = manifest.shots.filter((s) => s.assetClass === "STOCK_REAL");
    const allCleared = stockEntries.every((s) => s.licenseStatus === "CLEARED");
    record(`stock manifest válido (${EXPECTED_STOCK_REAL} STOCK_REAL, todos CLEARED)`, stockEntries.length === EXPECTED_STOCK_REAL && allCleared, `${stockEntries.length} STOCK_REAL, licenseStatus=[${stockEntries.map((s) => s.licenseStatus).join(", ")}]`);
    const det = manifest.shots.filter((s) => s.assetClass === "DETERMINISTIC" || s.assetClass === "TEXT");
    record("30 shots TEXT/DETERMINISTIC (local, sin llamada externa)", det.length === 30, `${det.length} encontrados`);
  } catch (err) {
    record("lectura/validación del asset manifest", false, String(err));
  }

  // --- 8. Placeholders finales requeridos = 0: cada shot text/diagram/map del storyboard debe producir contenido real sin lanzar ---
  try {
    const { realGraphicSpecProvider } = await import("../src/lib/video/long-form/real-graphics");
    const graphicShots = storyboardShotsFlat.filter((s) => s.assetType === "text" || s.assetType === "diagram" || s.assetType === "map");
    const failures: string[] = [];
    for (const s of graphicShots) {
      try {
        const shotType = s.assetType === "text" ? "text" : s.assetType === "diagram" ? "diagram" : "map";
        const spec = realGraphicSpecProvider({
          id: s.shotId,
          type: shotType,
          captionText: s.visualIntent,
          license: s.licensing?.status ?? "N/A (determinístico, sin asset externo)",
        } as Parameters<typeof realGraphicSpecProvider>[0]);
        if (!spec || spec.isFixture) failures.push(`${s.shotId} (sin spec real o marcado isFixture)`);
      } catch (err) {
        failures.push(`${s.shotId}: ${String(err)}`);
      }
    }
    record(
      `0 placeholders — los ${graphicShots.length} shots text/diagram/map producen contenido real`,
      failures.length === 0,
      failures.length === 0 ? "todos generan spec real (isFixture:false), ninguno lanza" : `fallaron: ${failures.join(" | ")}`,
    );
  } catch (err) {
    record("validación estructural de 0 placeholders", false, String(err));
  }

  // --- 9. Preflight de costo: proyección MÁXIMA (worst case, asume 0 reuso) de los 8 AI_RECREATION restantes + 13 TTS beats, contra el presupuesto REAL restante ---
  try {
    const { VISUAL_TEST_V2_ESTIMATED_COST_PER_IMAGE_USD } = await import("../src/lib/video/long-form/visual-test-v2");
    const { getPricingConfig } = await import("../src/lib/billing/pricing");
    const { loadScriptFromFile } = await import("../src/lib/video/long-form/script-loader");
    const { VIDEO_001_HARD_STOP_USD } = await import("../src/lib/video/long-form/video-cost-guard");

    const pricing = getPricingConfig();
    const loaded = loadScriptFromFile(SCRIPT_FILE);
    const totalChars = loaded.beats.reduce((sum, b) => sum + b.narration.length, 0);
    const projectedTtsUsd = (totalChars / 1000) * pricing.elevenLabsUsdPer1kChars;
    const projectedImagesUsd = EXPECTED_AI_RECREATION_REMAINING * VISUAL_TEST_V2_ESTIMATED_COST_PER_IMAGE_USD;
    const projectedTotalNewUsd = round4(projectedTtsUsd + projectedImagesUsd);

    const spentSoFar = ledgerSpent ?? CONFIRMED_SPENT_FLOOR_USD;
    const projectedGrandTotal = round4(spentSoFar + projectedTotalNewUsd);
    const withinHardStop = projectedGrandTotal <= VIDEO_001_HARD_STOP_USD;
    record(
      `proyección de costo máximo dentro del hard stop ($${VIDEO_001_HARD_STOP_USD.toFixed(2)})`,
      withinHardStop,
      `proyectado (peor caso, sin reuso)=$${projectedTotalNewUsd.toFixed(4)} (imágenes=$${projectedImagesUsd.toFixed(4)} + TTS=$${projectedTtsUsd.toFixed(4)}), ` +
        `ya gastado=$${spentSoFar.toFixed(4)}, total proyectado=$${projectedGrandTotal.toFixed(4)}`,
    );
  } catch (err) {
    record("preflight de costo (proyección máxima)", false, String(err));
  }

  finish();
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function finish(extraNote?: string) {
  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log("=".repeat(70));
  console.log(`[preflight] RESULTADO: ${failed.length === 0 ? "PASA — autorizado a continuar a producción real" : "FALLA — FAIL CLOSED, cero llamadas pagas"}`);
  if (extraNote) console.log(`[preflight] ${extraNote}`);
  if (failed.length > 0) {
    console.log("[preflight] verificaciones fallidas:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  console.log("=".repeat(70));
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[preflight] error inesperado — FAIL CLOSED, cero llamadas pagas:", err);
  process.exit(1);
});
