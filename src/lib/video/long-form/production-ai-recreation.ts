/**
 * Generación REAL de los shots AI_RECREATION de VIDEO #001 (Göbekli
 * Tepe) para la producción completa — reutiliza, SIN modificar:
 *   - El "style composer" del Visual Test V2 (composePrompt/
 *     VIDEO_001_VISUAL_STYLE, visual-test-v2.ts) — mismo estilo aprobado.
 *   - La identidad/idempotencia/checksum/cost-guard ya construidos para
 *     los 3 shots aprobados (visual-test-v2.ts/visual-test-v2-storage.ts/
 *     video-cost-guard.ts).
 *
 * Los 3 shots YA aprobados (b1-s4, b4-s2, b8-s5) NUNCA se recalculan
 * desde el storyboard aquí — su identidad/registro ya existe en Supabase
 * (fue calculada por buildVisualTestV2Manifest(), con un texto de prompt
 * DISTINTO — aunque temáticamente equivalente — al `queryOrPrompt` del
 * storyboard). Se leen tal cual con el mecanismo ya existente
 * (readVisualTestV2ShotRecord + validateExistingVisualTestV2Image); si
 * cualquiera de los 3 no valida, esta función NUNCA intenta regenerarlo
 * — lanza y detiene todo el lote (ver ProductionApprovedAssetInvalidError).
 *
 * Los shots AI_RECREATION restantes (identificados en tiempo de
 * ejecución por `shot.source === "generated"` sobre los Shot[] ya
 * construidos desde el storyboard real — ver storyboard-shots.ts
 * `sourceFor()`) se identifican con una identidad NUEVA calculada aquí:
 * mismo modelo/tamaño/calidad que el Visual Test V2, mismo negativo
 * compartido (el storyboard no tiene negativePrompt por shot), y el
 * prompt de escena = `shot.visualIntent` (que ya es el `queryOrPrompt`
 * real del storyboard — texto YA aprobado, nunca inventado aquí) con el
 * marcador de referencia "— ESTILO COMPARTIDO..." quitado antes de
 * componer el estilo real (el marcador es solo una nota de producción
 * pidiendo aplicar el Visual Bible, no el texto de estilo en sí).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImageProvider } from "@/lib/providers/types";
import { validateVisualAssetBuffer } from "../visual-asset-validation";
import type { Shot } from "./types";
import {
  buildVisualTestV2Manifest,
  composePrompt,
  computeIdempotencyKey,
  VIDEO_001_VISUAL_STYLE,
  VISUAL_TEST_V2_MODEL,
  VISUAL_TEST_V2_SIZE,
  VISUAL_TEST_V2_QUALITY,
  VISUAL_TEST_V2_ESTIMATED_COST_PER_IMAGE_USD,
} from "./visual-test-v2";
import { VISUAL_TEST_V2_REAL_SHOT_IDS } from "./visual-test-v2-real";
import {
  readVisualTestV2ShotRecord,
  writeVisualTestV2ShotRecord,
  validateExistingVisualTestV2Image,
  uploadVisualTestV2Image,
  visualTestV2ImagePath,
  readVisualTestV2Ledger,
  writeVisualTestV2Ledger,
  computeChecksumSha256,
  VISUAL_TEST_V2_STORAGE_BUCKET,
  type ImageGenRecord,
} from "./visual-test-v2-storage";
import { assertCanSpend, recordSpend, totalSpentUsd, VIDEO_001_HARD_STOP_USD } from "./video-cost-guard";

/** Nota de producción del storyboard que pide aplicar el estilo compartido — se quita antes de componer el estilo real (composePrompt ya lo aplica explícitamente). */
const STYLE_MARKER_PATTERN = /\s*—\s*ESTILO COMPARTIDO.*$/i;

export type ProductionAiRecreationEntry = {
  shotId: string;
  beatId: string;
  prompt: string;
  negativePrompt: string;
  model: string;
  size: string;
  quality: string;
  aspectRatio: "16:9";
  estimatedCostUsd: number;
  idempotencyKey: string;
};

/**
 * Construye la identidad/manifest de UN shot AI_RECREATION nuevo (no uno
 * de los 3 ya aprobados) a partir del Shot[] real ya construido desde el
 * storyboard — reutiliza el texto de escena EXACTO del storyboard
 * (`shot.visualIntent`), solo quitando el marcador de referencia al
 * Visual Bible antes de componer el estilo real.
 */
export function buildProductionAiRecreationEntry(
  shot: Pick<Shot, "id" | "beatId" | "visualIntent">,
): ProductionAiRecreationEntry {
  const sceneText = shot.visualIntent.replace(STYLE_MARKER_PATTERN, "").trim();
  if (!sceneText) {
    throw new Error(`buildProductionAiRecreationEntry: shot "${shot.id}" no tiene texto de escena después de quitar el marcador de estilo.`);
  }
  const prompt = composePrompt(sceneText);
  const negativePrompt = VIDEO_001_VISUAL_STYLE.sharedNegative;
  const idempotencyKey = computeIdempotencyKey({
    shotId: shot.id,
    model: VISUAL_TEST_V2_MODEL,
    size: VISUAL_TEST_V2_SIZE,
    quality: VISUAL_TEST_V2_QUALITY,
    prompt,
    negativePrompt,
  });
  return {
    shotId: shot.id,
    beatId: shot.beatId,
    prompt,
    negativePrompt,
    model: VISUAL_TEST_V2_MODEL,
    size: VISUAL_TEST_V2_SIZE,
    quality: VISUAL_TEST_V2_QUALITY,
    aspectRatio: "16:9",
    estimatedCostUsd: VISUAL_TEST_V2_ESTIMATED_COST_PER_IMAGE_USD,
    idempotencyKey,
  };
}

/** true si el shot es uno de los 3 YA aprobados y generados vía Visual Test V2 (identidad ajena, nunca recalculada aquí). */
export function isApprovedVisualTestV2Shot(shotId: string): boolean {
  return (VISUAL_TEST_V2_REAL_SHOT_IDS as readonly string[]).includes(shotId);
}

export class ProductionApprovedAssetInvalidError extends Error {
  constructor(public readonly shotIds: string[]) {
    super(
      `Producción real de VIDEO #001: el/los shot(s) ya aprobado(s) ${shotIds.join(", ")} no tienen un asset ` +
        `COMPLETED válido en Storage (falta, archivo dañado, o checksum no coincide). NUNCA se regeneran ` +
        `automáticamente — requiere revisión manual antes de continuar.`,
    );
    this.name = "ProductionApprovedAssetInvalidError";
  }
}

export class ProductionAiRecreationUncertainCostStateError extends Error {
  constructor(public readonly shotIds: string[]) {
    super(
      `Producción real de VIDEO #001: ${shotIds.join(", ")} tiene(n) un registro en estado STARTED sin COMPLETED ` +
        `válido — consumo incierto. No se reintenta automáticamente: revisa el dashboard de OpenAI y, solo si ` +
        `confirmas que NO se cobró, borra manualmente ese registro en Storage antes de reintentar.`,
    );
    this.name = "ProductionAiRecreationUncertainCostStateError";
  }
}

export type ResolvedAiRecreationImage = {
  shotId: string;
  buffer: Buffer;
  mimeType: string;
  extension: string;
  costUsd: number;
  reused: boolean;
};

/**
 * Resuelve TODOS los shots AI_RECREATION presentes en `shots` (identificados
 * por `shot.source === "generated"`, sin asumir un conteo fijo) — los 3 ya
 * aprobados se REUTILIZAN leyendo su registro/checksum existente (nunca se
 * recalculan ni se regeneran), y el resto se genera o reutiliza con la
 * misma identidad/cost-guard/idempotencia que el Visual Test V2, usando el
 * MISMO ledger durable de Supabase (categoría "production", respeta el
 * hard stop total de $3.00 VIDEO #001 incluyendo lo ya gastado).
 *
 * Devuelve un buffer real por shot (no solo una URL) para que el llamador
 * pueda subirlo con su propio uploader/pathPrefix, igual que
 * resolveGeneratedImage() en asset-resolver.ts.
 */
export async function resolveProductionAiRecreationImages(
  supabase: SupabaseClient,
  shots: Pick<Shot, "id" | "beatId" | "visualIntent" | "source">[],
  imageProvider: ImageProvider,
  bucket: string = VISUAL_TEST_V2_STORAGE_BUCKET,
): Promise<Map<string, ResolvedAiRecreationImage>> {
  const aiShots = shots.filter((s) => s.source === "generated");
  const videoId = buildVisualTestV2Manifest().videoId;

  const approvedShotIds = aiShots.map((s) => s.id).filter(isApprovedVisualTestV2Shot);
  const newShots = aiShots.filter((s) => !isApprovedVisualTestV2Shot(s.id));

  const results = new Map<string, ResolvedAiRecreationImage>();

  // --- 1. Los 3 ya aprobados: SOLO lectura/reuso, nunca regeneración. ---
  const approvedManifest = buildVisualTestV2Manifest();
  const invalidApproved: string[] = [];
  for (const shotId of approvedShotIds) {
    const entry = approvedManifest.shots.find((s) => s.shotId === shotId);
    if (!entry) {
      invalidApproved.push(shotId);
      continue;
    }
    const record = await readVisualTestV2ShotRecord(supabase, bucket, videoId, entry.idempotencyKey);
    const valid = record?.status === "COMPLETED" && (await validateExistingVisualTestV2Image(supabase, bucket, record));
    if (!valid || !record) {
      invalidApproved.push(shotId);
      continue;
    }
    const { data, error } = await supabase.storage.from(bucket).download(record.storagePath!);
    if (error || !data) {
      invalidApproved.push(shotId);
      continue;
    }
    const buffer = Buffer.from(await data.arrayBuffer());
    results.set(shotId, {
      shotId,
      buffer,
      mimeType: record.mimeType ?? "image/png",
      extension: record.extension ?? "png",
      costUsd: 0,
      reused: true,
    });
  }
  if (invalidApproved.length > 0) {
    throw new ProductionApprovedAssetInvalidError(invalidApproved);
  }

  if (newShots.length === 0) {
    return results;
  }

  // --- 2. Shots AI_RECREATION nuevos: identidad propia, generar-o-reutilizar. ---
  const newEntries = newShots.map((s) => buildProductionAiRecreationEntry(s));

  const existingRecords = new Map<string, ImageGenRecord | undefined>();
  for (const entry of newEntries) {
    existingRecords.set(entry.shotId, await readVisualTestV2ShotRecord(supabase, bucket, videoId, entry.idempotencyKey));
  }

  const uncertain = newEntries.filter((e) => existingRecords.get(e.shotId)?.status === "STARTED");
  if (uncertain.length > 0) {
    throw new ProductionAiRecreationUncertainCostStateError(uncertain.map((e) => e.shotId));
  }

  const toGenerate: ProductionAiRecreationEntry[] = [];
  for (const entry of newEntries) {
    const record = existingRecords.get(entry.shotId);
    const valid = record?.status === "COMPLETED" && (await validateExistingVisualTestV2Image(supabase, bucket, record));
    if (valid && record) {
      const { data, error } = await supabase.storage.from(bucket).download(record.storagePath!);
      if (error || !data) {
        toGenerate.push(entry);
        continue;
      }
      const buffer = Buffer.from(await data.arrayBuffer());
      results.set(entry.shotId, {
        shotId: entry.shotId,
        buffer,
        mimeType: record.mimeType ?? "image/png",
        extension: record.extension ?? "png",
        costUsd: 0,
        reused: true,
      });
    } else {
      toGenerate.push(entry);
    }
  }

  if (toGenerate.length === 0) {
    return results;
  }

  if (!imageProvider.isAvailable()) {
    throw new Error("Producción real de VIDEO #001: OPENAI_API_KEY no está configurada en este entorno.");
  }

  const projectedCostUsd = round4(toGenerate.reduce((sum, e) => sum + e.estimatedCostUsd, 0));
  let ledger = await readVisualTestV2Ledger(supabase, bucket, videoId);
  // Mismo ledger durable que ya tiene los $0.1681 del Visual Test V2 — el hard stop de $3.00
  // se valida sobre el TOTAL acumulado real, nunca desde $0. Categoría "production" (no
  // "visual_test_v2"): no aplica el tope de $0.50 de esa categoría, solo el hard stop total.
  assertCanSpend(ledger, "production", projectedCostUsd);

  for (const entry of toGenerate) {
    const startedRecord: ImageGenRecord = {
      idempotencyKey: entry.idempotencyKey,
      shotId: entry.shotId,
      status: "STARTED",
      createdAtIso: new Date().toISOString(),
      updatedAtIso: new Date().toISOString(),
    };
    await writeVisualTestV2ShotRecord(supabase, bucket, videoId, startedRecord);

    const asset = await imageProvider.generateImage({
      prompt: entry.prompt,
      negativePrompt: entry.negativePrompt,
      aspectRatio: entry.aspectRatio,
      maxCostUsd: VIDEO_001_HARD_STOP_USD - totalSpentUsd(ledger),
    });

    const validation = validateVisualAssetBuffer(asset.buffer, asset.mimeType);
    if (!validation.valid) {
      throw new Error(`Producción real de VIDEO #001: OpenAI devolvió un archivo inválido para "${entry.shotId}": ${validation.reason}`);
    }

    const path = visualTestV2ImagePath(videoId, entry.shotId, entry.idempotencyKey, asset.extension);
    await uploadVisualTestV2Image(supabase, bucket, path, asset.buffer, asset.mimeType);
    const checksum = computeChecksumSha256(asset.buffer);

    await writeVisualTestV2ShotRecord(supabase, bucket, videoId, {
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
      updatedAtIso: new Date().toISOString(),
    });

    ledger = recordSpend(ledger, "production", asset.costUsd, `Producción REAL VIDEO #001 — imagen ${entry.shotId}`);
    await writeVisualTestV2Ledger(supabase, bucket, ledger);

    results.set(entry.shotId, {
      shotId: entry.shotId,
      buffer: asset.buffer,
      mimeType: asset.mimeType,
      extension: asset.extension,
      costUsd: asset.costUsd,
      reused: false,
    });
  }

  return results;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
