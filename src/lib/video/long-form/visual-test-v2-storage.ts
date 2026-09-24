/**
 * Persistencia DURABLE (Supabase Storage) para la generación REAL del
 * Visual Test V2 — el filesystem de Vercel es efímero (no sobrevive entre
 * invocaciones ni deployments), así que el ledger de costo y el registro
 * por shot que ya usaba disco local en el CLI (video-cost-guard.ts,
 * tts-cache.ts) necesitan un equivalente durable aquí. Reutiliza la
 * infraestructura EXISTENTE de ATOMIVID: el mismo bucket "videos" que ya
 * usa src/lib/video/visual-resource-resolver.ts para subir imágenes
 * reales generadas con este mismo proveedor OpenAI (ver generate-video.ts,
 * STORAGE_BUCKET) — no se crea ningún bucket ni tabla nueva.
 *
 * Este módulo es SOLO I/O (sin decisiones de negocio) — la lógica de
 * cuándo reutilizar/generar/abortar vive en visual-test-v2-real.ts, igual
 * que video-cost-guard.ts separa sus funciones puras de sus funciones de
 * disco.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { emptyLedger, type CostLedger } from "./video-cost-guard";

// Definida aquí en vez de importada de tts-cache.ts a propósito: ese
// módulo trae funciones de disco local (existsSync/mkdirSync/...)
// pensadas para el CLI, y este archivo SÍ se empaqueta en rutas de
// Vercel (route.ts) — importar tts-cache.ts entero arrastraría ese
// código de disco al bundle server-side sin necesidad, y dispara el
// warning de "tracing" de Next.js sobre archivos difíciles de acotar
// estáticamente. La función en sí es trivial (SHA-256 de un Buffer) —
// no vale la pena esa dependencia solo por 3 líneas.
export function computeChecksumSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Mismo bucket que ya usa Shorts/Avatar para imágenes generadas reales (generate-video.ts, STORAGE_BUCKET = "videos") — reutilizado, no un bucket nuevo. */
export const VISUAL_TEST_V2_STORAGE_BUCKET = "videos";

function ledgerPath(videoId: string): string {
  return `long-form/${videoId}/state/cost-ledger.json`;
}

function shotRecordPath(videoId: string, idempotencyKey: string): string {
  return `long-form/${videoId}/state/visual-test-v2/${idempotencyKey}.json`;
}

export function visualTestV2ImagePath(videoId: string, shotId: string, idempotencyKey: string, extension: string): string {
  return `long-form/${videoId}/visual-test-v2/${shotId}-${idempotencyKey}.${extension}`;
}

export type ImageGenRecordStatus = "STARTED" | "COMPLETED";

export type ImageGenRecord = {
  idempotencyKey: string;
  shotId: string;
  status: ImageGenRecordStatus;
  storagePath?: string;
  checksumSha256?: string;
  mimeType?: string;
  extension?: string;
  widthPx?: number;
  heightPx?: number;
  provider?: string;
  model?: string;
  quality?: string;
  costUsd?: number;
  createdAtIso: string;
  updatedAtIso: string;
};

async function downloadJson<T>(supabase: SupabaseClient, bucket: string, path: string): Promise<T | undefined> {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) return undefined;
  const text = await data.text();
  if (!text) return undefined;
  return JSON.parse(text) as T;
}

async function uploadJson(supabase: SupabaseClient, bucket: string, path: string, value: unknown): Promise<void> {
  const body = Buffer.from(JSON.stringify(value, null, 2));
  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, body, { contentType: "application/json", upsert: true });
  if (error) {
    throw new Error(`No se pudo guardar el estado de Visual Test V2 en Storage ("${path}"): ${error.message}`);
  }
}

export async function readVisualTestV2Ledger(supabase: SupabaseClient, bucket: string, videoId: string): Promise<CostLedger> {
  const ledger = await downloadJson<CostLedger>(supabase, bucket, ledgerPath(videoId));
  return ledger ?? emptyLedger(videoId);
}

export async function writeVisualTestV2Ledger(supabase: SupabaseClient, bucket: string, ledger: CostLedger): Promise<void> {
  await uploadJson(supabase, bucket, ledgerPath(ledger.videoId), ledger);
}

export async function readVisualTestV2ShotRecord(
  supabase: SupabaseClient,
  bucket: string,
  videoId: string,
  idempotencyKey: string,
): Promise<ImageGenRecord | undefined> {
  return downloadJson<ImageGenRecord>(supabase, bucket, shotRecordPath(videoId, idempotencyKey));
}

export async function writeVisualTestV2ShotRecord(
  supabase: SupabaseClient,
  bucket: string,
  videoId: string,
  record: ImageGenRecord,
): Promise<void> {
  await uploadJson(supabase, bucket, shotRecordPath(videoId, record.idempotencyKey), record);
}

/**
 * Borra el registro STARTED/COMPLETED de un shot — usado SOLO cuando se
 * sabe con certeza que no hubo gasto real (p. ej. un STARTED escrito
 * antes de una llamada que la propia API rechazó por moderación antes de
 * generar nada, nunca para limpiar un STARTED de origen incierto como un
 * crash de red). Sin esto, un STARTED huérfano bloquearía cualquier
 * reintento futuro con el mismo idempotencyKey para siempre, aunque el
 * costo real haya sido cero.
 */
export async function deleteVisualTestV2ShotRecord(
  supabase: SupabaseClient,
  bucket: string,
  videoId: string,
  idempotencyKey: string,
): Promise<void> {
  const { error } = await supabase.storage.from(bucket).remove([shotRecordPath(videoId, idempotencyKey)]);
  if (error) {
    throw new Error(`No se pudo borrar el registro de Storage ("${shotRecordPath(videoId, idempotencyKey)}"): ${error.message}`);
  }
}

/**
 * Descarga el archivo del record y valida que exista, no esté vacío, y su
 * checksum en vivo coincida con el registrado — nunca confía ciegamente
 * en un status COMPLETED (mismo criterio que validateCachedAudioFile en
 * tts-cache.ts).
 */
export async function validateExistingVisualTestV2Image(
  supabase: SupabaseClient,
  bucket: string,
  record: ImageGenRecord,
): Promise<boolean> {
  if (!record.storagePath || !record.checksumSha256) return false;
  const { data, error } = await supabase.storage.from(bucket).download(record.storagePath);
  if (error || !data) return false;
  const buffer = Buffer.from(await data.arrayBuffer());
  if (buffer.byteLength === 0) return false;
  return computeChecksumSha256(buffer) === record.checksumSha256;
}

export async function uploadVisualTestV2Image(
  supabase: SupabaseClient,
  bucket: string,
  path: string,
  buffer: Buffer,
  contentType: string,
): Promise<void> {
  const { error } = await supabase.storage.from(bucket).upload(path, buffer, { contentType, upsert: true });
  if (error) {
    throw new Error(`No se pudo subir la imagen generada a Storage ("${path}"): ${error.message}`);
  }
}
