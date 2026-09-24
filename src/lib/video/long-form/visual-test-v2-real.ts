/**
 * Ejecución REAL controlada del Visual Test V2 — autorizada explícitamente
 * por el usuario para EXACTAMENTE estas 3 imágenes (b1-s4, b4-s2, b8-s5),
 * con el manifest/prompts/Visual Bible ya aprobados (visual-test-v2.ts,
 * SIN cambios en ese archivo ni en visual-test-v2-runtime.ts — el DRY_RUN
 * queda intacto). Ver HANDOFF-PRODUCTION-V1.md sección 24.
 *
 * Diseño (mismo principio que tts-cache.ts, pero con Supabase Storage en
 * vez de disco local — ver visual-test-v2-storage.ts): por shot, identidad
 * = idempotencyKey ya calculado por buildVisualTestV2Manifest() (hash de
 * shotId+modelo+tamaño+calidad+prompt+negativePrompt). STARTED se escribe
 * ANTES de llamar a OpenAI; COMPLETED se escribe después de subir y
 * validar la imagen. Un STARTED sin COMPLETED válido NUNCA se reintenta
 * solo — requiere revisión manual.
 *
 * El chequeo de costo es POR LOTE, antes de llamar a OpenAI para
 * cualquiera de los shots pendientes: se suma el costo estimado de TODOS
 * los shots que haría falta generar y se valida contra el ledger
 * persistido ANTES de la primera llamada — así nunca se generan 2 de 3 y
 * se descubre a mitad de camino que el lote entero iba a exceder el tope.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImageProvider } from "@/lib/providers/types";
import { openaiImageProvider } from "@/lib/providers/image/openai";
import { validateVisualAssetBuffer } from "../visual-asset-validation";
import { buildVisualTestV2Manifest, toImageGenerationRequest, type VisualTestV2ManifestEntry } from "./visual-test-v2";
import { assertValidVisualTestV2Manifest } from "./visual-test-v2-runtime";
import {
  assertCanSpend,
  recordSpend,
  totalSpentUsd,
  spentUsdByCategory,
  VIDEO_001_HARD_STOP_USD,
  VISUAL_TEST_V2_MAX_USD,
} from "./video-cost-guard";
import {
  readVisualTestV2Ledger,
  writeVisualTestV2Ledger,
  readVisualTestV2ShotRecord,
  writeVisualTestV2ShotRecord,
  validateExistingVisualTestV2Image,
  uploadVisualTestV2Image,
  visualTestV2ImagePath,
  computeChecksumSha256,
  VISUAL_TEST_V2_STORAGE_BUCKET,
  type ImageGenRecord,
} from "./visual-test-v2-storage";

/** Cierre explícito: exactamente estos 3 shots, en este orden — ningún otro id es alcanzable desde este mecanismo. */
export const VISUAL_TEST_V2_REAL_SHOT_IDS = ["b1-s4", "b4-s2", "b8-s5"] as const;

export { VISUAL_TEST_V2_REAL_CONFIRM_VALUE } from "./visual-test-v2-real-confirm";

export class VisualTestV2UncertainCostStateError extends Error {
  constructor(public readonly shotIds: string[]) {
    super(
      `Visual Test V2 REAL: ${shotIds.join(", ")} tiene(n) un registro en estado STARTED sin COMPLETED válido — ` +
        `consumo incierto. No se reintenta automáticamente: revisa el dashboard de OpenAI y, solo si confirmas que ` +
        `NO se cobró, borra manualmente ese registro en Storage antes de reintentar.`,
    );
    this.name = "VisualTestV2UncertainCostStateError";
  }
}

export type VisualTestV2RealShotResult = {
  shotId: string;
  status: "reused" | "generated";
  costUsd: number;
  storagePath: string;
};

export type VisualTestV2RealResult = {
  videoId: string;
  shots: VisualTestV2RealShotResult[];
  totalSpentThisRunUsd: number;
  ledgerTotalSpentUsd: number;
  ledgerVisualTestV2SpentUsd: number;
  maxTotalUsd: number;
  hardStopUsd: number;
  paidApisCalled: boolean;
};

function nowIso(): string {
  return new Date().toISOString();
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function shotOrderIndex(shotId: string): number {
  const i = (VISUAL_TEST_V2_REAL_SHOT_IDS as readonly string[]).indexOf(shotId);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

export async function runVisualTestV2RealGeneration(
  supabase: SupabaseClient,
  bucket: string = VISUAL_TEST_V2_STORAGE_BUCKET,
  imageProvider: ImageProvider = openaiImageProvider,
): Promise<VisualTestV2RealResult> {
  const manifest = buildVisualTestV2Manifest();
  assertValidVisualTestV2Manifest(manifest);
  const videoId = manifest.videoId;

  // Orden fijo y cerrado — nunca depende de ningún input del cliente.
  const shots: VisualTestV2ManifestEntry[] = VISUAL_TEST_V2_REAL_SHOT_IDS.map((shotId) => {
    const entry = manifest.shots.find((s) => s.shotId === shotId);
    if (!entry) {
      throw new Error(`Visual Test V2 REAL: el manifest no contiene el shot esperado "${shotId}".`);
    }
    return entry;
  });

  const existingRecords = new Map<string, ImageGenRecord | undefined>();
  for (const entry of shots) {
    existingRecords.set(entry.shotId, await readVisualTestV2ShotRecord(supabase, bucket, videoId, entry.idempotencyKey));
  }

  const uncertain = shots.filter((entry) => existingRecords.get(entry.shotId)?.status === "STARTED");
  if (uncertain.length > 0) {
    throw new VisualTestV2UncertainCostStateError(uncertain.map((s) => s.shotId));
  }

  const toGenerate: VisualTestV2ManifestEntry[] = [];
  const reused: VisualTestV2RealShotResult[] = [];
  for (const entry of shots) {
    const record = existingRecords.get(entry.shotId);
    const valid = record?.status === "COMPLETED" && (await validateExistingVisualTestV2Image(supabase, bucket, record));
    if (valid && record) {
      reused.push({ shotId: entry.shotId, status: "reused", costUsd: 0, storagePath: record.storagePath! });
    } else {
      toGenerate.push(entry);
    }
  }

  if (toGenerate.length === 0) {
    const ledger = await readVisualTestV2Ledger(supabase, bucket, videoId);
    return {
      videoId,
      shots: reused,
      totalSpentThisRunUsd: 0,
      ledgerTotalSpentUsd: totalSpentUsd(ledger),
      ledgerVisualTestV2SpentUsd: spentUsdByCategory(ledger, "visual_test_v2"),
      maxTotalUsd: VISUAL_TEST_V2_MAX_USD,
      hardStopUsd: VIDEO_001_HARD_STOP_USD,
      paidApisCalled: false,
    };
  }

  if (!imageProvider.isAvailable()) {
    throw new Error("Visual Test V2 REAL: OPENAI_API_KEY no está configurada en este entorno.");
  }

  const projectedCostUsd = round4(toGenerate.reduce((sum, e) => sum + e.estimatedCostUsd, 0));
  let ledger = await readVisualTestV2Ledger(supabase, bucket, videoId);
  // Lanza VideoCostGuardExceededError si excedería el tope de $0.50 (categoría visual_test_v2) o el
  // hard stop de $3.00 (VIDEO #001) — ANTES de llamar a OpenAI para cualquiera de los shots pendientes.
  assertCanSpend(ledger, "visual_test_v2", projectedCostUsd);

  const generated: VisualTestV2RealShotResult[] = [];
  let totalSpentThisRunUsd = 0;

  for (const entry of toGenerate) {
    const startedRecord: ImageGenRecord = {
      idempotencyKey: entry.idempotencyKey,
      shotId: entry.shotId,
      status: "STARTED",
      createdAtIso: nowIso(),
      updatedAtIso: nowIso(),
    };
    await writeVisualTestV2ShotRecord(supabase, bucket, videoId, startedRecord);

    const asset = await imageProvider.generateImage(toImageGenerationRequest(entry));

    const validation = validateVisualAssetBuffer(asset.buffer, asset.mimeType);
    if (!validation.valid) {
      throw new Error(
        `Visual Test V2 REAL: OpenAI devolvió un archivo inválido para "${entry.shotId}": ${validation.reason}`,
      );
    }

    const path = visualTestV2ImagePath(videoId, entry.shotId, entry.idempotencyKey, asset.extension);
    await uploadVisualTestV2Image(supabase, bucket, path, asset.buffer, asset.mimeType);
    const checksum = computeChecksumSha256(asset.buffer);

    const completedRecord: ImageGenRecord = {
      ...startedRecord,
      status: "COMPLETED",
      storagePath: path,
      checksumSha256: checksum,
      mimeType: asset.mimeType,
      extension: asset.extension,
      widthPx: asset.width,
      heightPx: asset.height,
      provider: imageProvider.name,
      model: asset.model,
      quality: entry.quality,
      costUsd: asset.costUsd,
      updatedAtIso: nowIso(),
    };
    await writeVisualTestV2ShotRecord(supabase, bucket, videoId, completedRecord);

    ledger = recordSpend(ledger, "visual_test_v2", asset.costUsd, `Visual Test V2 REAL — ${entry.shotId}`);
    await writeVisualTestV2Ledger(supabase, bucket, ledger);

    totalSpentThisRunUsd = round4(totalSpentThisRunUsd + asset.costUsd);
    generated.push({ shotId: entry.shotId, status: "generated", costUsd: asset.costUsd, storagePath: path });
  }

  const allShots = [...reused, ...generated].sort((a, b) => shotOrderIndex(a.shotId) - shotOrderIndex(b.shotId));

  return {
    videoId,
    shots: allShots,
    totalSpentThisRunUsd,
    ledgerTotalSpentUsd: totalSpentUsd(ledger),
    ledgerVisualTestV2SpentUsd: spentUsdByCategory(ledger, "visual_test_v2"),
    maxTotalUsd: VISUAL_TEST_V2_MAX_USD,
    hardStopUsd: VIDEO_001_HARD_STOP_USD,
    paidApisCalled: generated.length > 0,
  };
}
