/**
 * Entrega idempotente del MP4 final de Long Form (P0 2026-09-25).
 *
 * - Salida CANÓNICA por solicitud (no por intento): `${requestId}/output/final.mp4`.
 * - Estado durable al lado: `${requestId}/state/output.json` — métricas del
 *   archivo renderizado y del entregado, método/bitácora de subida, fallo
 *   con diagnosticId. Es el log de admin (el worker silencia la consola).
 * - Preflight de tamaño con el archivo YA renderizado: nunca se re-renderiza
 *   ni se llama a un proveedor por un problema de tamaño; si Storage no lo
 *   acepta se ajusta desde ese mismo archivo (output-policy.ts).
 * - Reconciliación: si un intento anterior ya subió la salida (p. ej. la
 *   subida funcionó y falló la actualización de la fila), un reintento la
 *   reutiliza sin renderizar nada.
 * - En cualquier fallo el archivo renderizado se conserva en
 *   LONG_FORM_OUTPUT_KEEP_DIR (render.yml lo publica como artifact).
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  configuredStorageMaxBytes,
  decideOutputFit,
  LONG_FORM_ENCODING_PROFILE,
  LONG_FORM_OUTPUT_POLICY,
  LongFormOutputError,
  type OutputFitDecision,
} from "./output-policy";
import { probeOutput, sha256File, transcodeToFit, type OutputMediaMetrics } from "./output-media";
import { OutputUploadError, uploadOutputFile, type UploadAttemptLog } from "./output-upload";
import { generateDiagnosticId } from "../render-error";

export const OUTPUT_BUCKET = "videos";
export const canonicalOutputPath = (requestId: string) => `${requestId}/output/final.mp4`;
export const outputStatePath = (requestId: string) => `${requestId}/state/output.json`;

export type LongFormOutputState = {
  version: 1;
  requestId: string;
  status: "UPLOADED" | "FAILED";
  objectPath: string;
  attempt: number | null;
  profile: string;
  delivery?: "as_rendered" | "size_fit";
  rendered?: OutputMediaMetrics;
  delivered?: OutputMediaMetrics;
  sha256?: string;
  ceilingBytes?: number | null;
  fit?: OutputFitDecision;
  uploadMethod?: "resumable" | "standard";
  uploadAttempts?: UploadAttemptLog[];
  timingsMs?: { probe?: number; fit?: number; upload?: number };
  /** Costos de generation_costs ya registrados para esta salida (una sola vez). */
  costsRecorded?: boolean;
  failure?: { category: string; diagnosticId: string; detail: Record<string, unknown> };
  keptLocalCopy?: string | null;
  updatedAtIso: string;
};

export type OutputFinalizeDeps = {
  probe: (filePath: string) => Promise<OutputMediaMetrics>;
  transcode: (input: { sourcePath: string; outputPath: string; videoKbps: number; audioKbps: number }) => Promise<void>;
  upload: (objectPath: string, filePath: string) => Promise<{ method: "resumable" | "standard"; attempts: UploadAttemptLog[] }>;
  readState: (requestId: string) => Promise<LongFormOutputState | null>;
  writeState: (state: LongFormOutputState) => Promise<void>;
  /** Tamaño del objeto en Storage, o null si no existe. */
  objectSize: (objectPath: string) => Promise<number | null>;
  sha256: (filePath: string) => Promise<string>;
  keepDir?: string | null;
  storageMaxBytes?: number | null;
  now?: () => number;
};

export function supabaseOutputDeps(supabase: SupabaseClient, env: Record<string, string | undefined> = process.env): OutputFinalizeDeps {
  const storage = () => supabase.storage.from(OUTPUT_BUCKET);
  return {
    probe: probeOutput,
    transcode: transcodeToFit,
    sha256: sha256File,
    upload: (objectPath, filePath) =>
      uploadOutputFile(
        { bucket: OUTPUT_BUCKET, objectPath, filePath, contentType: "video/mp4" },
        {
          supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL ?? "",
          serviceKey: env.SUPABASE_SERVICE_ROLE_KEY ?? "",
          disableResumable: !(env.NEXT_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL) || !env.SUPABASE_SERVICE_ROLE_KEY,
          standardUpload: async (p, buffer, contentType) => {
            const { error } = await storage().upload(p, buffer, { contentType, upsert: true });
            if (!error) return { error: null };
            const status = Number((error as { status?: number; statusCode?: string }).status ?? (error as { statusCode?: string }).statusCode);
            return { error: { message: error.message, status: Number.isFinite(status) ? status : null } };
          },
        },
      ),
    readState: async (requestId) => {
      const { data, error } = await storage().download(outputStatePath(requestId));
      if (error || !data) return null;
      const text = await data.text();
      return text ? (JSON.parse(text) as LongFormOutputState) : null;
    },
    writeState: async (state) => {
      const { error } = await storage().upload(outputStatePath(state.requestId), Buffer.from(JSON.stringify(state, null, 2)), {
        contentType: "application/json",
        upsert: true,
      });
      if (error) throw new Error(`output_state_write_failed: ${error.message}`);
    },
    objectSize: async (objectPath) => {
      const dir = path.posix.dirname(objectPath);
      const name = path.posix.basename(objectPath);
      const { data, error } = await storage().list(dir, { limit: 100, search: name });
      if (error) throw new Error(`output_list_failed: ${error.message}`);
      const entry = (data ?? []).find((e) => e.name === name && e.id !== null);
      if (!entry) return null;
      return Number((entry.metadata as { size?: number } | null)?.size ?? 0);
    },
    keepDir: env.LONG_FORM_OUTPUT_KEEP_DIR?.trim() || null,
    storageMaxBytes: configuredStorageMaxBytes(env),
  };
}

/**
 * ¿Ya hay una salida entregada para esta solicitud? Si sí, devuelve su
 * ruta — el llamador termina la solicitud sin renderizar nada. Un objeto
 * de Storage solo existe una vez completa su subida (estándar o TUS), así
 * que su presencia en la ruta canónica basta aunque el estado no se haya
 * podido escribir.
 */
export async function reconcileExistingOutput(requestId: string, deps: Pick<OutputFinalizeDeps, "readState" | "objectSize">): Promise<{ videoPath: string; state: LongFormOutputState | null } | null> {
  const objectPath = canonicalOutputPath(requestId);
  const state = await deps.readState(requestId).catch(() => null);
  const size = await deps.objectSize(objectPath);
  if (size === null || size <= 0) return null;
  if (state?.status === "UPLOADED" && state.delivered && state.delivered.bytes !== size) return null;
  return { videoPath: objectPath, state };
}

async function keepCopy(filePath: string, keepDir: string | null | undefined, requestId: string): Promise<string | null> {
  if (!keepDir) return null;
  try {
    await fs.mkdir(keepDir, { recursive: true });
    const target = path.join(keepDir, `${requestId}-${path.basename(filePath)}`);
    await fs.copyFile(filePath, target);
    return target;
  } catch {
    return null;
  }
}

/**
 * Entrega el archivo ya renderizado en `filePath` a la ruta canónica.
 * Nunca re-renderiza ni llama a proveedores. Lanza LongFormOutputError
 * (mensaje seguro para el cliente + detalle de admin en el estado) si no
 * se pudo entregar; el archivo local se conserva para recuperarlo.
 */
export async function finalizeLongFormOutput(
  input: { requestId: string; attempt: number | null; filePath: string; profile?: string },
  deps: OutputFinalizeDeps,
): Promise<{ videoPath: string; state: LongFormOutputState }> {
  const profile = input.profile ?? LONG_FORM_ENCODING_PROFILE.id;
  const now = deps.now ?? Date.now;
  const objectPath = canonicalOutputPath(input.requestId);
  const diagnosticId = generateDiagnosticId();
  const policy = LONG_FORM_OUTPUT_POLICY;
  const timingsMs: LongFormOutputState["timingsMs"] = {};
  const uploadAttempts: UploadAttemptLog[] = [];
  const created: string[] = [];
  let rendered: OutputMediaMetrics | undefined;
  let delivered: OutputMediaMetrics | undefined;
  let fit: OutputFitDecision | undefined;
  let ceilingBytes: number | null = null;

  const fail = async (category: LongFormOutputError["category"], detail: Record<string, unknown>): Promise<never> => {
    const keptLocalCopy = await keepCopy(input.filePath, deps.keepDir, input.requestId);
    const state: LongFormOutputState = {
      version: 1,
      requestId: input.requestId,
      status: "FAILED",
      objectPath,
      attempt: input.attempt,
      profile,
      rendered,
      delivered,
      ceilingBytes,
      fit,
      uploadAttempts,
      timingsMs,
      failure: { category, diagnosticId, detail },
      keptLocalCopy,
      updatedAtIso: new Date(now()).toISOString(),
    };
    await deps.writeState(state).catch(() => {});
    for (const p of created) await fs.unlink(p).catch(() => {});
    throw new LongFormOutputError(category, diagnosticId, { ...detail, stage: "upload", requestId: input.requestId, bytes: rendered?.bytes ?? null, keptLocalCopy });
  };

  const t = now();
  try {
    rendered = await deps.probe(input.filePath);
  } catch (err) {
    return fail("output_invalid", { reason: "ffprobe_failed", message: err instanceof Error ? err.message.slice(0, 300) : String(err) });
  }
  timingsMs.probe = now() - t;
  if (!(rendered.bytes > 0) || !(rendered.durationSeconds > 0) || !rendered.videoCodec) {
    return fail("output_invalid", { reason: "empty_or_unreadable", rendered });
  }

  const fitFrom = async (ceiling: number, reason: string): Promise<string> => {
    ceilingBytes = ceiling;
    let decision = decideOutputFit({ bytes: rendered!.bytes, durationSeconds: rendered!.durationSeconds, ceilingBytes: ceiling });
    fit = decision;
    if (decision.action === "too_large") return fail("too_large", { reason, ceilingBytes: ceiling, requiredVideoKbps: decision.requiredVideoKbps, rendered });
    if (decision.action === "upload") return input.filePath;
    const fitPath = input.filePath.replace(/(\.mp4)?$/, ".fit.mp4");
    created.push(fitPath);
    const tf = now();
    // Hasta 2 pasadas: si el 2-pass se pasa del techo, una más al 85%.
    for (let pass = 0; pass < 2; pass++) {
      try {
        await deps.transcode({ sourcePath: input.filePath, outputPath: fitPath, videoKbps: decision.targetVideoKbps, audioKbps: decision.audioKbps });
        delivered = await deps.probe(fitPath);
      } catch (err) {
        return fail("output_invalid", { reason: "size_fit_transcode_failed", message: err instanceof Error ? err.message.slice(0, 300) : String(err) });
      }
      if (delivered.bytes <= ceiling) break;
      const tighter = Math.floor(decision.targetVideoKbps * 0.85);
      if (pass === 1 || tighter < policy.minFitVideoKbps) {
        return fail("too_large", { reason: "size_fit_overshoot", ceilingBytes: ceiling, delivered });
      }
      decision = { ...decision, targetVideoKbps: tighter };
      fit = decision;
    }
    timingsMs.fit = (timingsMs.fit ?? 0) + (now() - tf);
    if (Math.abs(delivered!.durationSeconds - rendered!.durationSeconds) > 0.5) {
      return fail("output_invalid", { reason: "size_fit_duration_mismatch", rendered, delivered });
    }
    return fitPath;
  };

  // Preflight: techo conocido (configurado) o el de la política (1 GiB).
  const configured = deps.storageMaxBytes ?? null;
  let uploadPath = await fitFrom(Math.min(policy.policyMaxBytes, configured ?? Number.POSITIVE_INFINITY), "preflight");
  if (uploadPath === input.filePath) {
    delivered = rendered;
    fit = { action: "upload" };
  }

  let method: "resumable" | "standard" | undefined;
  const tryUpload = async (): Promise<OutputUploadError | null> => {
    const tu = now();
    try {
      const res = await deps.upload(objectPath, uploadPath);
      uploadAttempts.push(...res.attempts);
      method = res.method;
      return null;
    } catch (err) {
      if (err instanceof OutputUploadError) {
        uploadAttempts.push(...err.log);
        return err;
      }
      return new OutputUploadError("unknown", null, err instanceof Error ? err.message : String(err), 1);
    } finally {
      timingsMs.upload = (timingsMs.upload ?? 0) + (now() - tu);
    }
  };

  let uploadError = await tryUpload();
  // Storage rechazó por tamaño un archivo que no se ajustó: ajustar al techo
  // demostrado (o configurado) desde el MISMO archivo y subir una vez más.
  if (uploadError?.category === "size_rejected" && uploadPath === input.filePath) {
    const ceiling = Math.min(configured ?? policy.demonstratedStorageMaxBytes, rendered.bytes - 1);
    uploadPath = await fitFrom(ceiling, "storage_size_rejected");
    uploadError = await tryUpload();
  }
  if (uploadError) {
    return fail(uploadError.category, { reason: "upload_failed", status: uploadError.status, detail: uploadError.detail.slice(0, 300), attempts: uploadError.attempts, ceilingBytes });
  }

  const state: LongFormOutputState = {
    version: 1,
    requestId: input.requestId,
    status: "UPLOADED",
    objectPath,
    attempt: input.attempt,
    profile,
    delivery: uploadPath === input.filePath ? "as_rendered" : "size_fit",
    rendered,
    delivered,
    sha256: await deps.sha256(uploadPath).catch(() => undefined),
    ceilingBytes,
    fit,
    uploadMethod: method,
    uploadAttempts,
    timingsMs,
    costsRecorded: false,
    updatedAtIso: new Date(now()).toISOString(),
  };
  // El objeto ya está en Storage: un fallo al escribir el estado no invalida
  // la entrega (la reconciliación verifica el objeto directamente).
  await deps.writeState(state).catch(() => {});
  for (const p of created) await fs.unlink(p).catch(() => {});
  return { videoPath: objectPath, state };
}

/** Marca los costos como registrados (idempotencia de generation_costs). */
export async function markOutputCostsRecorded(state: LongFormOutputState, deps: Pick<OutputFinalizeDeps, "writeState">, now: () => number = Date.now): Promise<void> {
  await deps.writeState({ ...state, costsRecorded: true, updatedAtIso: new Date(now()).toISOString() }).catch(() => {});
}

/**
 * Implementación en memoria (pruebas / inyección de fallos): Storage en un
 * Map, sin ffprobe/ffmpeg — `probe` lee el tamaño real del archivo y usa
 * `durationSeconds` fijo; `transcode` escribe un archivo del tamaño que
 * produciría el bitrate pedido.
 */
export function memoryOutputDeps(opts: {
  durationSeconds?: number;
  /** Techo del Storage simulado (bytes); por encima → rechazo por tamaño. */
  storageLimitBytes?: number;
  /** Falla transitoria en las primeras N subidas. */
  transientUploadFailures?: number;
  failWriteState?: boolean;
} = {}) {
  const objects = new Map<string, number>();
  const states = new Map<string, LongFormOutputState>();
  const calls = { upload: 0, transcode: 0, probe: 0 };
  let transientLeft = opts.transientUploadFailures ?? 0;
  const durationSeconds = opts.durationSeconds ?? 300;
  const deps: OutputFinalizeDeps = {
    async probe(filePath) {
      calls.probe += 1;
      const bytes = (await fs.stat(filePath)).size;
      return {
        bytes,
        durationSeconds,
        width: 1920,
        height: 1080,
        fps: 30,
        videoCodec: "h264",
        audioCodec: "aac",
        totalKbps: Math.round((bytes * 8) / durationSeconds / 1000),
        videoKbps: null,
        audioKbps: null,
      };
    },
    async transcode({ outputPath, videoKbps, audioKbps }) {
      calls.transcode += 1;
      const bytes = Math.round(((videoKbps + audioKbps) * 1000 * durationSeconds) / 8);
      await fs.writeFile(outputPath, Buffer.alloc(bytes));
    },
    async upload(objectPath, filePath) {
      calls.upload += 1;
      const bytes = (await fs.stat(filePath)).size;
      if (transientLeft > 0) {
        transientLeft -= 1;
        throw new OutputUploadError("transient", 503, "Service Unavailable", 4, [{ method: "resumable", attempt: 4, ok: false, category: "transient", status: 503 }]);
      }
      if (opts.storageLimitBytes !== undefined && bytes > opts.storageLimitBytes) {
        throw new OutputUploadError("size_rejected", 413, "The object exceeded the maximum allowed size", 1, [{ method: "resumable", attempt: 1, ok: false, category: "size_rejected", status: 413 }]);
      }
      objects.set(objectPath, bytes);
      return { method: "resumable", attempts: [{ method: "resumable", attempt: 1, ok: true, offset: bytes }] };
    },
    async readState(requestId) {
      return states.get(requestId) ?? null;
    },
    async writeState(state) {
      if (opts.failWriteState) throw new Error("state write failed");
      states.set(state.requestId, structuredClone(state));
    },
    async objectSize(objectPath) {
      return objects.get(objectPath) ?? null;
    },
    async sha256() {
      return "memory-sha256";
    },
    keepDir: null,
    storageMaxBytes: null,
  };
  return { deps, objects, states, calls };
}
