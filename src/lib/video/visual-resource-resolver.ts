import { RecraftStyleMissingError } from "@/lib/video/recraft-reel";
import { regenerationCanFix, type GeneratedImageQc } from "@/lib/video/long-form/generated-image-qc";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GenerativeAsset, ImageGenerationRequest, ImageProvider } from "@/lib/providers/image";
import type { StoryboardScene } from "./storyboard/types";
import { generatedImageObjectPrefix } from "./visual-resource-planner";
import { validateVisualAssetBuffer } from "./visual-asset-validation";
import { guardPaidCall, type LedgerStore } from "@/lib/paid-calls/gate";

/**
 * Parte con I/O real del planificador visual — separada de
 * visual-resource-planner.ts (puro, sin red) para poder probar la
 * POLÍTICA sin mockear Supabase, y mockear Supabase sin repetir la
 * política. Nunca decide POR SU CUENTA si debe generar — solo ejecuta la
 * decisión que ya tomó decideResourceStrategy().
 *
 * Idempotencia: antes de llamar al proveedor, busca si YA existe un
 * archivo `scene-{n}-generated.*` para este requestId (list() por
 * prefijo, sin asumir la extensión — OpenAI real devuelve .png, el
 * fixture .svg). Si existe, lo reutiliza (costo $0, cero llamadas) — así
 * un reintento del mismo job después de un fallo POSTERIOR (p. ej. falla
 * el render, no la generación) nunca vuelve a facturar la misma escena.
 *
 * Nunca cae a otro proveedor de pago si este falla — solo relanza el
 * error para que el llamador (generate-video.ts) use stock (gratis) como
 * único fallback, nunca otro proveedor pagado en silencio.
 */

export type GeneratedImageOutcome = {
  status: "reused" | "generated";
  url: string;
  path: string;
  costUsd: number;
  bufferBytes: number;
  provider: string;
  model?: string;
  width?: number;
  height?: number;
  /** Recraft: style_id used or created by this image (absent when reused from Storage). */
  styleId?: string;
  providerJobId?: string;
};

const IMAGE_EXT = "(?:png|jpe?g|webp|svg)";
const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Recraft (R1): the style_id travels IN the image object name, written by the same upload as the paid bytes. */
export const styleTaggedObjectName = (key: string, styleId: string | undefined, extension: string) =>
  styleId ? `${key}.style-${styleId}.${extension}` : `${key}.${extension}`;

export async function findExistingGeneratedImage(
  supabase: SupabaseClient,
  bucket: string,
  requestId: string,
  sceneIndex: number,
  objectKey?: string,
  options: { strict?: boolean } = {},
): Promise<{ path: string; styleId?: string } | null> {
  const prefix = objectKey ?? generatedImageObjectPrefix(sceneIndex);
  const { data, error } = await supabase.storage.from(bucket).list(requestId, { search: prefix });
  if (error || !data) {
    // R2: with a per-video style a failed lookup is NOT "nothing exists" — never treat it as permission to pay again.
    if (options.strict) throw new Error(`No se pudo comprobar en Storage si la imagen pagada de ${prefix} ya existe (${error?.message ?? "sin datos"}); no se genera otra.`);
    return null;
  }
  // Only image objects named exactly `<key>.<ext>` or `<key>.style-<id>.<ext>`: metadata/sidecar files, other scenes
  // (scene-1 vs scene-10) or partial names never count as the paid image.
  const re = new RegExp(`^${escapeRe(prefix)}(?:\\.style-([A-Za-z0-9-]{8,64}))?\\.${IMAGE_EXT}$`, "i");
  for (const f of data) {
    const m = re.exec(f.name);
    if (m) return { path: `${requestId}/${f.name}`, ...(m[1] ? { styleId: m[1] } : {}) };
  }
  return null;
}

export async function resolveGeneratedImageForScene({
  supabase,
  bucket,
  requestId,
  artifactPrefix = requestId,
  sceneIndex,
  scene,
  imageProvider,
  remainingBudgetUsd,
  signedUrlTtlSeconds,
  ledger,
  objectKey,
  style,
  qc,
}: {
  supabase: SupabaseClient;
  bucket: string;
  requestId: string;
  artifactPrefix?: string;
  disableProviderRetries?: boolean;
  sceneIndex: number;
  scene: StoryboardScene;
  imageProvider: ImageProvider;
  remainingBudgetUsd: number;
  signedUrlTtlSeconds: number;
  /**
   * Puerta de llamadas pagadas (PI V2 B1, RB-01). Obligatoria para un proveedor real: la fila
   * de `pi_paid_operations` se escribe antes del HTTP; COMMITTED sin objeto en Storage no
   * vuelve a generar. El fixture (sin red, sin costo) no pasa por ella.
   */
  ledger?: LedgerStore;
  /**
   * Anexo C1: a second image for the same scene (the Director's fill of one shot) needs its own object name and its
   * own ledger row; otherwise it would collide with the scene's image (reused, or a COMMITTED row refusing to pay
   * again). Absent = the scene image, exactly as before. Reuse on retry keeps working with the key.
   */
  objectKey?: string;
  /** Per-video style (Recraft). Part of the ledger fingerprint so a different style never reuses a paid row. */
  style?: ImageGenerationRequest["style"];
  /** Video's policy when fal created its style without returning a style_id (see recraft-reel.ts). */
  onMissingStyleId?: "stop" | "same_references";
  /** Automatic check of a generated image (generated-image-qc.ts). A rejected image is paid and kept apart, never used. */
  qc?: (asset: GenerativeAsset) => Promise<GeneratedImageQc>;
}): Promise<GeneratedImageOutcome> {
  const existing = await findExistingGeneratedImage(supabase, bucket, artifactPrefix, sceneIndex, objectKey, { strict: Boolean(style) });
  if (existing && style) {
    // R1: an already-paid image must hand back the style it used/created before the next scene is allowed to run.
    // An image stored without style_id (fal returned none): reusable as is; whether the VIDEO may continue is the
    // caller's coherence policy (resolveRecraftReelScene). It is never paid again.
    if (!existing.styleId && style.styleId) {
      throw new Error(`La imagen pagada ${existing.path} no conserva su style_id y el video ya usa otro: incompatibilidad, no se reutiliza ni se genera otra.`);
    }
    if (style.styleId && style.styleId !== existing.styleId) {
      throw new Error(`La imagen pagada ${existing.path} usa otro estilo que el del video: incompatibilidad, no se reutiliza ni se genera otra.`);
    }
  }
  if (existing) {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(existing.path, signedUrlTtlSeconds);
    if (error || !data) {
      throw new Error(`No se pudo firmar la URL del recurso generado reutilizado (${existing.path}): ${error?.message ?? "desconocido"}`);
    }
    return {
      status: "reused",
      url: data.signedUrl,
      path: existing.path,
      costUsd: 0,
      bufferBytes: 0,
      provider: imageProvider.name,
      ...(existing.styleId ? { styleId: existing.styleId } : {}),
    };
  }

  const request: ImageGenerationRequest = {
    disableRetries: true,
    prompt: scene.imagePrompt,
    negativePrompt: scene.negativePrompt,
    aspectRatio: "9:16" as const,
    maxCostUsd: remainingBudgetUsd,
    ...(style ? { style } : {}),
  };
  const twoPhase = Boolean(imageProvider.submitImage && imageProvider.resumeImage);
  const store = async (asset: GenerativeAsset) => {
    // Nunca confiar en que "la llamada no lanzó" ya implica "es un archivo
    // usable" — se valida ANTES de subir nada a Storage.
    const validation = validateVisualAssetBuffer(asset.buffer, asset.mimeType);
    if (!validation.valid) {
      throw new Error(`El proveedor de imagen "${imageProvider.name}" devolvió un archivo inválido: ${validation.reason}`);
    }

    const key = objectKey ?? generatedImageObjectPrefix(sceneIndex);
    // "Generated" is not "approved": a measurable defect keeps the paid image out of the video. It is stored apart (the
    // durable marker that this scene needs its one regeneration) and settled as paid; the caller regenerates.
    const verdict = qc ? await qc(asset) : undefined;
    if (verdict && !verdict.passed) {
      const rejectedPath = `${artifactPrefix}/${QC_REJECTED_DIR}/${key}.${asset.extension}`;
      const { error: rejectedError } = await supabase.storage.from(bucket).upload(rejectedPath, asset.buffer, { contentType: asset.mimeType, upsert: true });
      if (rejectedError) throw new Error(`No se pudo guardar la imagen rechazada por el control (${rejectedPath}): ${rejectedError.message}`);
      return { asset, path: rejectedPath, rejected: verdict };
    }
    const path = `${artifactPrefix}/${style ? styleTaggedObjectName(key, asset.styleId, asset.extension) : `${key}.${asset.extension}`}`;
    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(path, asset.buffer, { contentType: asset.mimeType, upsert: true });
    if (uploadError) {
      throw new Error(`No se pudo subir la imagen generada (${path}): ${uploadError.message}`);
    }
    return { asset, path, rejected: undefined as GeneratedImageQc | undefined };
  };
  const generateAndStore = async () => store(await imageProvider.generateImage(request));

  let asset: Awaited<ReturnType<typeof generateAndStore>>["asset"];
  let path: string;
  let rejected: GeneratedImageQc | undefined;
  if (imageProvider.name === "fixture" || !ledger) {
    if (imageProvider.name !== "fixture") {
      throw new Error(`Imagen generada para la escena ${sceneIndex}: proveedor real "${imageProvider.name}" sin puerta de llamadas pagadas — no se llama.`);
    }
    ({ asset, path, rejected } = await generateAndStore());
  } else {
    const guarded = await guardPaidCall<{ asset: Awaited<ReturnType<typeof generateAndStore>>["asset"]; path: string; rejected?: GeneratedImageQc }>(
      ledger,
      {
        projectId: requestId,
        shotId: `image:${objectKey ?? `scene-${sceneIndex}`}`,
        provider: imageProvider.name,
        model: imageProvider.name,
        method: "generate_image",
        inputFingerprint: style
          ? { prompt: request.prompt, negativePrompt: request.negativePrompt ?? null, aspectRatio: request.aspectRatio,
              // R2: stable identity of the paid scene. The per-video style moves from references (first scene) to the
              // style_id fal returned; that switch must NOT open a second ledger key for the same scene. Compatibility
              // of the stored image with the video's style is checked on reuse (style-tagged object name).
              style: "recraft-video-style", match: style.match ?? null }
          : { prompt: request.prompt, negativePrompt: request.negativePrompt ?? null, aspectRatio: request.aspectRatio },
        // Two-phase providers price BEFORE submit (estimateCostUsd): that exact estimate is what the ledger reserves
        // and the reel total cap (pi_submit_with_supply) admits or refuses before fal is called.
        reservedUsd: Math.max(0, twoPhase && imageProvider.estimateCostUsd ? imageProvider.estimateCostUsd(request) : remainingBudgetUsd),
      },
      {
        ...(twoPhase ? {
          // fal request_id is recorded in the ledger (PROVIDER_JOB_RECORDED) BEFORE polling; after an interruption the
          // next attempt resumes the SAME request_id and never submits again.
          submit: async () => imageProvider.submitImage!(request),
          resume: async (providerJobId: string) => {
            const r = await store(await imageProvider.resumeImage!(providerJobId, request));
            return { result: r, costUsd: r.asset.costUsd, resultRef: r.path, providerJobId };
          },
        } : {}),
        call: async () => {
          const r = await generateAndStore();
          return { result: r, costUsd: r.asset.costUsd, resultRef: r.path };
        },
        // `findExistingGeneratedImage` ya se consultó arriba: llegar aquí con COMMITTED significa
        // que el objeto pagado no está en Storage. No se genera de nuevo.
        load: async () => null,
        // El proveedor de imagen ya reintenta UNA vez por su cuenta ante un rechazo explícito
        // (openai.ts MAX_RETRIES); la puerta no añade otro para no superar un reintento.
        maxRejectedRetries: 0,
      },
    );
    ({ asset, path, rejected } = guarded.result);
  }
  if (rejected) throw new GeneratedImageRejectedError(sceneIndex, rejected, asset.styleId, asset.providerJobId);

  const { data, error: signError } = await supabase.storage.from(bucket).createSignedUrl(path, signedUrlTtlSeconds);
  if (signError || !data) {
    throw new Error(`No se pudo firmar la URL de la imagen generada (${path}): ${signError?.message ?? "desconocido"}`);
  }

  return {
    status: "generated",
    url: data.signedUrl,
    path,
    costUsd: asset.costUsd,
    bufferBytes: asset.buffer.byteLength,
    provider: imageProvider.name,
    model: asset.model,
    width: asset.width,
    height: asset.height,
    styleId: asset.styleId,
    providerJobId: asset.providerJobId,
  };
}

/**
 * One Recraft scene of a Reel, exactly as generate-video.ts runs it: resolve (reuse / resume / pay once) and, when the
 * video had no style_id yet, persist the one this image created BEFORE the next scene runs. Returns the style the next
 * scene must use. Exported so the multi-scene interruption sequence is tested on the production code path.
 */
export async function resolveRecraftReelScene(
  args: Omit<Parameters<typeof resolveGeneratedImageForScene>[0], "style" | "objectKey"> & {
    style: NonNullable<ImageGenerationRequest["style"]>;
    match?: "precise" | "flexible" | null;
    onStyleId?: (styleId: string) => Promise<void>;
  },
): Promise<{ generated: GeneratedImageOutcome; nextStyle: NonNullable<ImageGenerationRequest["style"]> }> {
  const { match, onStyleId, onMissingStyleId = "stop", ...rest } = args;
  let style = args.style;
  const key = `scene-${rest.sceneIndex}-recraft`;
  const regenKey = `${key}-r1`;
  const artifactPrefix = rest.artifactPrefix ?? rest.requestId;
  // A scene whose image the automatic check rejected regenerates ONCE under its own key (own ledger row); a second
  // rejection stops the Reel (never a third image, never stock). The rejected objects are the durable markers.
  const rejectedKeys = await rejectedQcKeys(rest.supabase, rest.bucket, artifactPrefix, key);
  if (rejectedKeys.has(regenKey)) throw new GeneratedImageRejectedError(rest.sceneIndex, { passed: false, checks: [] });
  let generated: GeneratedImageOutcome;
  const adopt = async (styleId: string | undefined) => {
    if (style.styleId || !styleId) return;
    await onStyleId?.(styleId);
    style = { styleId, ...(match ? { match } : {}) };
  };
  try {
    generated = await resolveGeneratedImageForScene({ ...rest, style, onMissingStyleId, objectKey: rejectedKeys.has(key) ? regenKey : key });
  } catch (err) {
    if (!(err instanceof GeneratedImageRejectedError) || rejectedKeys.has(key)) throw err;
    // Framing/size defects come from the provider's output size: a regeneration would pay again for the same defect.
    if (!regenerationCanFix(err.qc)) throw new GeneratedImageRejectedError(err.sceneIndex, err.qc, err.styleId, err.providerJobId, false);
    // The rejected image's style is valid (the defect is in the frame): keep it for the regeneration.
    await adopt(err.styleId);
    generated = await resolveGeneratedImageForScene({ ...rest, style, onMissingStyleId, objectKey: regenKey });
  }
  if (style.styleId) return { generated, nextStyle: style };
  if (!generated.styleId) {
    // fal returned no style_id (optional in its schema). The paid image is stored and kept; coherence policy decides.
    if (onMissingStyleId === "same_references") return { generated, nextStyle: style };
    throw new RecraftStyleMissingError(generated.providerJobId);
  }
  await adopt(generated.styleId);
  return { generated, nextStyle: style };
}

export const QC_REJECTED_DIR = "qc-rejected";
/** Keys of this scene already rejected by the automatic check (objects under `${prefix}/qc-rejected/`). Fail-closed. */
async function rejectedQcKeys(supabase: SupabaseClient, bucket: string, artifactPrefix: string, key: string): Promise<Set<string>> {
  const { data, error } = await supabase.storage.from(bucket).list(`${artifactPrefix}/${QC_REJECTED_DIR}`, { search: key });
  if (error) throw new Error(`No se pudo comprobar el control de imagen de ${key}; no se genera otra.`);
  const re = new RegExp(`^(${escapeRe(key)}(?:-r1)?)\\.${IMAGE_EXT}$`, "i");
  return new Set((data ?? []).map((f) => re.exec(f.name)?.[1]).filter((k): k is string => Boolean(k)));
}

/** A generated image failed the automatic check (and, for a regeneration, so did that one). Customer-safe, support. */
export class GeneratedImageRejectedError extends Error {
  readonly customerMessage: string;
  readonly retryable = false;
  constructor(readonly sceneIndex: number, readonly qc: GeneratedImageQc, readonly styleId?: string, readonly providerJobId?: string,
    /** False when no regeneration was paid because it could not fix the defect (framing/size). */
    readonly regenerated = true) {
    const detail = qc.checks.filter((c) => !c.ok).map((c) => c.detail).join("; ");
    const text = `La imagen generada de la escena ${sceneIndex + 1} no pasó el control automático${detail ? ` (${detail})` : ""}${regenerated ? " ni tras regenerarla una vez" : "; el defecto viene del tamaño que entrega el proveedor, así que no se pagó otra generación"}. Se detuvo el Reel sin sustituir imágenes; lo ya pagado se conserva y soporte revisa el caso.`;
    super(text);
    this.name = "GeneratedImageRejectedError";
    this.customerMessage = text;
  }
}
