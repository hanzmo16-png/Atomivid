/**
 * Storage DURABLE para clips resueltos por el AI Video Pipeline
 * (ai-video-resolver.ts) — P1 dejó esto deliberadamente pendiente ("Storage
 * real para clips resueltos"); P2A lo implementa reutilizando el MISMO
 * bucket Supabase Storage ("videos") y el MISMO patrón ya probado en
 * producción por visual-test-v2-storage.ts (idempotencia por
 * checksum/registro JSON, STARTED antes de generar, COMPLETED con checksum
 * después de subir, validación por checksum al reutilizar) — nunca se
 * inventa infraestructura nueva.
 *
 * A diferencia de visual-test-v2-storage.ts (específico de imágenes del
 * Visual Test V2 de OpenAI), este módulo es GENÉRICO por diseño: no importa
 * nada de runway.ts ni de ningún proveedor concreto — recibe un
 * `ResolvedAiVideoClip` (la forma que YA devuelve ai-video-resolver.ts para
 * CUALQUIER VideoProvider) y no le importa si vino del fixture, de Runway,
 * o de un proveedor futuro. Esto es lo que permite conectar Luma/Veo/otro
 * sin tocar este archivo (ver P2A sección 3).
 *
 * El flujo "provider temporary URL -> download -> validate -> upload
 * Atomivid Storage -> canonical asset reference" que pide P2A sección 11 ya
 * está resuelto en dos mitades: la descarga+validación YA ocurre dentro de
 * VideoProvider.generateVideo() + ai-video-validation.ts (ver
 * ai-video-resolver.ts) — este módulo cubre la segunda mitad, upload +
 * referencia canónica, sobre un buffer que YA se validó.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import type { ResolvedAiVideoClip } from "./ai-video-resolver";

/** Mismo bucket que ya usa el resto de Long Form (visual-test-v2-storage.ts, generate-video.ts) — nunca un bucket nuevo. */
export const AI_VIDEO_STORAGE_BUCKET = "videos";

export function computeAiVideoChecksumSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Ruta determinística: incluye videoId (o benchmarkId), shotId y un idempotencyKey — nunca colisiona entre dos generaciones distintas del mismo shot con distinto contenido. */
export function aiVideoClipStoragePath(scopeId: string, shotId: string, idempotencyKey: string, extension: string): string {
  return `long-form/${scopeId}/ai-video/${shotId}-${idempotencyKey}.${extension}`;
}

/** FAILED = fallo TERMINAL del proveedor para ese shot (p. ej. moderación): un reintento nunca reenvía, cae directo al fallback. */
export type AiVideoClipRecordStatus = "STARTED" | "COMPLETED" | "FAILED";

export type AiVideoClipRecord = {
  idempotencyKey: string;
  scopeId: string;
  shotId: string;
  status: AiVideoClipRecordStatus;
  storagePath?: string;
  checksumSha256?: string;
  mimeType?: string;
  extension?: string;
  durationSeconds?: number;
  widthPx?: number;
  heightPx?: number;
  provider?: string;
  model?: string;
  providerJobId?: string;
  costUsd?: number;
  executionMode?: "simulation" | "real";
  createdAtIso: string;
  updatedAtIso: string;
};

function recordPath(scopeId: string, idempotencyKey: string): string {
  return `long-form/${scopeId}/state/ai-video/${idempotencyKey}.json`;
}

async function downloadJson<T>(supabase: SupabaseClient, bucket: string, path: string): Promise<T | undefined> {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) return undefined;
  const text = await data.text();
  if (!text) return undefined;
  return JSON.parse(text) as T;
}

async function uploadJson(supabase: SupabaseClient, bucket: string, path: string, value: unknown): Promise<void> {
  const body = Buffer.from(JSON.stringify(value, null, 2));
  const { error } = await supabase.storage.from(bucket).upload(path, body, { contentType: "application/json", upsert: true });
  if (error) throw new Error(`No se pudo guardar el registro de clip de video-IA en Storage ("${path}"): ${error.message}`);
}

export async function readAiVideoClipRecord(
  supabase: SupabaseClient,
  bucket: string,
  scopeId: string,
  idempotencyKey: string,
): Promise<AiVideoClipRecord | undefined> {
  return downloadJson<AiVideoClipRecord>(supabase, bucket, recordPath(scopeId, idempotencyKey));
}

export async function writeAiVideoClipRecord(supabase: SupabaseClient, bucket: string, record: AiVideoClipRecord): Promise<void> {
  await uploadJson(supabase, bucket, recordPath(record.scopeId, record.idempotencyKey), record);
}

export async function deleteAiVideoClipRecord(supabase: SupabaseClient, bucket: string, scopeId: string, idempotencyKey: string): Promise<void> {
  const { error } = await supabase.storage.from(bucket).remove([recordPath(scopeId, idempotencyKey)]);
  if (error) throw new Error(`No se pudo borrar el registro de clip de video-IA ("${recordPath(scopeId, idempotencyKey)}"): ${error.message}`);
}

/** Descarga el clip del record y valida checksum — nunca confía ciegamente en status COMPLETED (mismo criterio que validateExistingVisualTestV2Image). */
export async function validateExistingAiVideoClip(supabase: SupabaseClient, bucket: string, record: AiVideoClipRecord): Promise<boolean> {
  if (!record.storagePath || !record.checksumSha256) return false;
  const { data, error } = await supabase.storage.from(bucket).download(record.storagePath);
  if (error || !data) return false;
  const buffer = Buffer.from(await data.arrayBuffer());
  if (buffer.byteLength === 0) return false;
  return computeAiVideoChecksumSha256(buffer) === record.checksumSha256;
}

export async function uploadAiVideoClipBuffer(
  supabase: SupabaseClient,
  bucket: string,
  path: string,
  buffer: Buffer,
  contentType: string,
): Promise<void> {
  const { error } = await supabase.storage.from(bucket).upload(path, buffer, { contentType, upsert: true });
  if (error) throw new Error(`No se pudo subir el clip de video-IA a Storage ("${path}"): ${error.message}`);
}

export type CanonicalAiVideoAssetReference = {
  bucket: string;
  storagePath: string;
  checksumSha256: string;
};

/**
 * Sube un `ResolvedAiVideoClip` (YA validado por ai-video-validation.ts,
 * ver ai-video-resolver.ts) a Storage y devuelve su referencia canónica —
 * la pieza que P1 dejó pendiente. Idempotente por checksum: si el mismo
 * `idempotencyKey` ya tiene un registro COMPLETED válido, lo reutiliza sin
 * volver a subir nada.
 */
export async function resolveAiVideoStorageAsset(
  supabase: SupabaseClient,
  clip: ResolvedAiVideoClip,
  params: { scopeId: string; idempotencyKey: string; executionMode: "simulation" | "real"; bucket?: string },
): Promise<CanonicalAiVideoAssetReference> {
  const bucket = params.bucket ?? AI_VIDEO_STORAGE_BUCKET;

  const existing = await readAiVideoClipRecord(supabase, bucket, params.scopeId, params.idempotencyKey);
  if (existing?.status === "COMPLETED" && (await validateExistingAiVideoClip(supabase, bucket, existing))) {
    return { bucket, storagePath: existing.storagePath!, checksumSha256: existing.checksumSha256! };
  }

  const nowIso = new Date().toISOString();
  // Conserva provider/providerJobId en el STARTED: si la subida de abajo
  // falla, el siguiente intento debe REANUDAR esa operación ya pagada, no
  // ver un STARTED sin id y reenviar una generación nueva.
  await writeAiVideoClipRecord(supabase, bucket, {
    idempotencyKey: params.idempotencyKey,
    scopeId: params.scopeId,
    shotId: clip.shotId,
    status: "STARTED",
    provider: clip.provider,
    providerJobId: clip.providerJobId ?? existing?.providerJobId,
    executionMode: params.executionMode,
    createdAtIso: existing?.createdAtIso ?? nowIso,
    updatedAtIso: nowIso,
  });

  const path = aiVideoClipStoragePath(params.scopeId, clip.shotId, params.idempotencyKey, clip.extension);
  await uploadAiVideoClipBuffer(supabase, bucket, path, clip.buffer, clip.mimeType);
  const checksum = computeAiVideoChecksumSha256(clip.buffer);

  await writeAiVideoClipRecord(supabase, bucket, {
    idempotencyKey: params.idempotencyKey,
    scopeId: params.scopeId,
    shotId: clip.shotId,
    status: "COMPLETED",
    storagePath: path,
    checksumSha256: checksum,
    mimeType: clip.mimeType,
    extension: clip.extension,
    durationSeconds: clip.durationSeconds,
    widthPx: clip.widthPx,
    heightPx: clip.heightPx,
    provider: clip.provider,
    model: clip.model,
    providerJobId: clip.providerJobId,
    costUsd: clip.costUsd,
    executionMode: params.executionMode,
    createdAtIso: existing?.createdAtIso ?? nowIso,
    updatedAtIso: new Date().toISOString(),
  });

  return { bucket, storagePath: path, checksumSha256: checksum };
}
