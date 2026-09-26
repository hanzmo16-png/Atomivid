/**
 * Recuperación MANUAL de una operación pagada con resultado incierto (o
 * pagada sin resultado guardado). Nunca se invoca de forma automática.
 *
 * Una operación incierta deja DOS bloqueos coherentes: su entrada en el
 * registro de gasto (paid-ledger.ts) y su estado propio en Storage (marcador
 * de imagen de visual-resource-resolver.ts o registro de voz de
 * voice-cache.ts). Reconocer solo el registro no desbloquea nada: el
 * resolver o el caché se siguen deteniendo. Esta función los libera juntos:
 *
 *  1. Comprueba que hay algo que recuperar (entrada no liberada; el archivo
 *     no existe ya — si existe, se reutiliza sin pagar y no hace falta).
 *  2. Comprueba PRESUPUESTO: comprometido (que ya incluye el intento
 *     anterior) + la reserva de otro intento ≤ tope. Si no cabe, no cambia
 *     nada.
 *  3. Libera el estado de Storage (marcador/registro → «released», con el
 *     estado previo y la nota del operador).
 *  4. Reconoce la entrada del registro: su gasto SIGUE contando y el
 *     siguiente intento hace una reserva nueva, así ambos quedan sumados.
 *
 * Idempotente: repetirla tras un fallo parcial completa lo que faltó.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { PaidBudgetExceededError, type PaidEntry, type PaidLedger } from "./paid-ledger";
import { isStorageNotFound, readJsonState, writeJsonState, StorageStateUnknownError } from "./storage-state";
import { findExistingGeneratedImage, generatedImageMarkerPath, type GeneratedImageMarker } from "../visual-resource-resolver";
import type { VoiceCacheRecord } from "./voice-cache";
import { scriptGenerationReserveUsd } from "./paid-costs";
import { blockingScriptEntries } from "./script-ledger";
import { animationMarkerPath, type AnimationMarker } from "./animated-clip";
import { createHash } from "node:crypto";

export class RecoveryRefusedError extends Error {
  constructor(public readonly key: string, detail: string) {
    super(`No se recuperó «${key}»: ${detail}. No se cambió nada.`);
    this.name = "RecoveryRefusedError";
  }
}

export type RecoveryResult = {
  key: string;
  kind: PaidEntry["kind"];
  /** Estado de Storage que se liberó (o null si la operación no tiene, p. ej. guion). */
  released: { path: string; previousStatus: string } | null;
  acknowledged: boolean;
  committedUsd: number;
  retryReserveUsd: number;
  capUsd: number;
};

function splitScopedKey(key: string): { requestId: string; id: string } {
  const body = key.slice(key.indexOf(":") + 1);
  const cut = body.lastIndexOf("/");
  if (cut <= 0) throw new RecoveryRefusedError(key, "clave con formato desconocido");
  return { requestId: body.slice(0, cut), id: body.slice(cut + 1) };
}

export async function recoverPaidOperation({
  supabase,
  bucket,
  ledger,
  key,
  note,
  capUsd,
}: {
  supabase: SupabaseClient;
  bucket: string;
  ledger: PaidLedger;
  key: string;
  /** Qué revisó el operador (obligatorio: queda en el registro y en el estado liberado). */
  note: string;
  /** Tope adicional (p. ej. el de la muestra); se usa el menor entre este y el del registro. */
  capUsd?: number;
}): Promise<RecoveryResult> {
  if (!note.trim()) throw new RecoveryRefusedError(key, "falta la nota del operador");
  if (key.startsWith("script:")) return recoverScriptGroup({ ledger, key, note, capUsd });
  const entry = ledger.latest(key);
  if (!entry) throw new RecoveryRefusedError(key, "no existe en el registro de gasto");
  if (entry.status === "released") throw new RecoveryRefusedError(key, "se liberó con costo cero; no está bloqueada");

  const ledgerCap = ledger.snapshot().capUsd;
  const caps = [ledgerCap, capUsd].filter((c): c is number => c !== undefined);
  if (caps.length === 0) throw new RecoveryRefusedError(key, "el registro no tiene tope; sin tope no se autoriza otro intento pagado");
  const cap = Math.min(...caps);
  const committedUsd = ledger.summary().committedUsd;
  const retryReserveUsd = entry.reserveUsd;
  if (committedUsd + retryReserveUsd > cap + 1e-9) {
    throw new PaidBudgetExceededError(
      `No se recuperó «${key}»: otro intento reservaría US$${retryReserveUsd.toFixed(4)} y el comprometido (incluido el intento anterior) es US$${committedUsd.toFixed(4)} de un tope de US$${cap.toFixed(2)}. No se cambió nada.`,
    );
  }

  const nowIso = new Date().toISOString();
  let released: RecoveryResult["released"] = null;
  if (entry.kind === "image") {
    const { requestId, id: prefix } = splitScopedKey(key);
    if (await findExistingGeneratedImage(supabase, bucket, requestId, 0, prefix)) {
      throw new RecoveryRefusedError(key, "la imagen ya está guardada; el próximo intento la reutiliza sin pagar");
    }
    const path = generatedImageMarkerPath(requestId, prefix);
    const marker = await readJsonState<GeneratedImageMarker>(supabase, bucket, path, `el marcador de «${prefix}»`);
    if (marker.kind === "found" && marker.data.status !== "released") {
      await writeJsonState(supabase, bucket, path, {
        ...marker.data,
        status: "released",
        previousStatus: marker.data.status,
        recoveredAtIso: nowIso,
        note: `recuperación manual: ${note}`.slice(0, 300),
      } satisfies GeneratedImageMarker);
      released = { path, previousStatus: marker.data.status };
    }
  } else if (entry.kind === "voice" || entry.kind === "voice_retime") {
    const { requestId, id: cacheKey } = splitScopedKey(key);
    const path = `${requestId}/state/voice/${cacheKey}.json`;
    const record = await readJsonState<VoiceCacheRecord>(supabase, bucket, path, "la narración guardada");
    if (record.kind === "found" && record.data.status === "completed" && (await completedAudioIntact(supabase, bucket, record.data))) {
      throw new RecoveryRefusedError(key, "la narración está guardada y verificada; el próximo intento la reutiliza sin pagar");
    }
    if (record.kind === "found" && record.data.status !== "released") {
      await writeJsonState(supabase, bucket, path, {
        ...record.data,
        status: "released",
        previousStatus: record.data.status,
        recoveredAtIso: nowIso,
        updatedAtIso: nowIso,
        note: `recuperación manual: ${note}`.slice(0, 300),
      } satisfies VoiceCacheRecord);
      released = { path, previousStatus: record.data.status };
    }
  } else if (entry.kind === "video") {
    // Clip de «Animación IA» (animated-clip.ts). Una operación aceptada cuyo
    // sondeo se cortó NO se recupera: el próximo intento la reanuda sin crear
    // otra ni volver a pagarla.
    const { requestId, id: prefix } = splitScopedKey(key);
    const path = animationMarkerPath(requestId, prefix);
    const marker = await readJsonState<AnimationMarker>(supabase, bucket, path, `el marcador de «${prefix}»`);
    if (marker.kind === "found" && marker.data.status === "submitted") {
      throw new RecoveryRefusedError(key, `la operación ${marker.data.operationName ?? ""} puede reanudarse; reintenta la producción (no se crea otra ni se paga dos veces)`);
    }
    const listed = await supabase.storage.from(bucket).list(requestId, { search: prefix });
    if (listed.error || !listed.data) throw new StorageStateUnknownError(`la animación «${prefix}»`, listed.error?.message ?? "listado vacío");
    if (listed.data.some((f) => f.name.startsWith(prefix) && f.name.endsWith(".mp4"))) {
      throw new RecoveryRefusedError(key, "el clip ya está guardado; el próximo intento lo reutiliza sin pagar");
    }
    if (marker.kind === "found" && marker.data.status !== "released") {
      await writeJsonState(supabase, bucket, path, {
        ...marker.data,
        status: "released",
        previousStatus: marker.data.status,
        recoveredAtIso: nowIso,
        updatedAtIso: nowIso,
        note: `recuperación manual: ${note}`.slice(0, 300),
      } satisfies AnimationMarker);
      released = { path, previousStatus: marker.data.status };
    }
  }

  const acknowledged = entry.acknowledgedAtIso ? false : await ledger.acknowledge(key, note);
  return { key, kind: entry.kind, released, acknowledged, committedUsd: ledger.summary().committedUsd, retryReserveUsd, capUsd: cap };
}

async function completedAudioIntact(supabase: SupabaseClient, bucket: string, record: VoiceCacheRecord): Promise<boolean> {
  if (!record.audioPath || !record.audioSha256) return false;
  const { data, error } = await supabase.storage.from(bucket).download(record.audioPath);
  if (error || !data) {
    if (error && isStorageNotFound(error)) return false;
    throw new StorageStateUnknownError("el audio de la narración guardada", error?.message ?? "vacío");
  }
  return createHash("sha256").update(Buffer.from(await data.arrayBuffer())).digest("hex") === record.audioSha256;
}

/**
 * Guion: una generación son VARIAS llamadas (borrador, correcciones de
 * longitud, reintentos), cada una con su entrada. `key` es el grupo (p. ej.
 * «script:samples/audiovisual/horror») o una llamada concreta; se reconocen
 * todas las entradas del grupo que siguen bloqueando. No hay estado en
 * Storage que liberar: el guion solo se guarda si la generación terminó.
 * Presupuesto: comprometido + el peor caso de una generación nueva.
 */
async function recoverScriptGroup({ ledger, key, note, capUsd }: { ledger: PaidLedger; key: string; note: string; capUsd?: number }): Promise<RecoveryResult> {
  const blocking = blockingScriptEntries(ledger, key);
  if (blocking.length === 0) throw new RecoveryRefusedError(key, "no hay llamadas de guion bloqueadas en ese grupo");
  const caps = [ledger.snapshot().capUsd, capUsd].filter((c): c is number => c !== undefined);
  if (caps.length === 0) throw new RecoveryRefusedError(key, "el registro no tiene tope; sin tope no se autoriza otro intento pagado");
  const cap = Math.min(...caps);
  const committedUsd = ledger.summary().committedUsd;
  const retryReserveUsd = scriptGenerationReserveUsd();
  if (committedUsd + retryReserveUsd > cap + 1e-9) {
    throw new PaidBudgetExceededError(
      `No se recuperó «${key}»: una generación nueva reservaría hasta US$${retryReserveUsd.toFixed(4)} y el comprometido (incluidos los intentos anteriores) es US$${committedUsd.toFixed(4)} de un tope de US$${cap.toFixed(2)}. No se cambió nada.`,
    );
  }
  let acknowledged = false;
  for (const e of blocking) acknowledged = (await ledger.acknowledge(e.key, note)) || acknowledged;
  return { key, kind: "script", released: null, acknowledged, committedUsd: ledger.summary().committedUsd, retryReserveUsd, capUsd: cap };
}
