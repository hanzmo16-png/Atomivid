import fs from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GeneratedScript, ScriptLanguage } from "@/lib/providers/types";
import { AvatarProviderError } from "@/lib/providers/types";
import { getAvatarProvider } from "@/lib/providers/avatar";
import { getVoiceProvider } from "@/lib/providers/voice";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { LOUDNESS_TARGET, masterAudioLoudness } from "@/lib/video/audio-master";
import { recordVideoGeneration } from "@/lib/billing/usage";
import type { RenderStage } from "@/lib/video/stages";
import path from "node:path";
import os from "node:os";

const STORAGE_BUCKET = "videos";
// Mismo TTL que el resto del pipeline (generate-video.ts) para assets
// intermedios firmados — el audio de narración solo necesita vivir el
// tiempo que el proveedor de avatar tarda en descargarlo, nunca público.
const NARRATION_SIGNED_URL_TTL_SECONDS = 60 * 60;

type AvatarRow = {
  id: string;
  user_id: string;
  status: string;
  consent_given: boolean;
  provider_avatar_id: string | null;
  provider: string;
};

export class AvatarPipelineError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "mode_disabled"
      | "avatar_not_found"
      | "avatar_not_owned"
      | "consent_missing"
      | "avatar_not_ready"
      | "provider_unavailable"
      | "narration_failed"
      | "attempt_blocked"
      | "duration_exceeded"
      | "provider_error",
  ) {
    super(message);
    this.name = "AvatarPipelineError";
  }
}

type OnProgress = (stage: RenderStage) => void | Promise<void>;

/**
 * Etapa 2 del pipeline PARA EL MODO AVATAR — contraparte de
 * generateVideoFromScript() (modo visual). No busca footage por separado:
 * el proveedor de avatar genera video con labios sincronizados a partir
 * del guion — sintetizando la voz él mismo, o animando los labios contra
 * un audio que YA sintetizamos nosotros con nuestro propio ElevenLabs
 * (ver `audioUrl` más abajo — confirmado soportado por D-ID, la voz queda
 * consistente con el modo visual en vez de depender de la síntesis
 * interna, distinta, de cada proveedor).
 *
 * LIMITACIÓN CONOCIDA (documentada, no oculta): a diferencia del modo
 * visual, esta primera versión NO superpone subtítulos ni mezcla música
 * de fondo sobre el video del proveedor de avatar — el video final viene
 * con su propio audio ya sincronizado (voz + labios) directamente del
 * proveedor, y este no devuelve los timestamps por palabra que
 * buildCaptions() necesita para generar subtítulos reales sin
 * inventarlos. Esto es así sin importar si la voz vino de nuestro
 * ElevenLabs (audioUrl) o de la síntesis interna del proveedor (voiceId)
 * — solo se aplica mastering de loudness al audio que ya trae el video.
 * Music/subtítulos para modo avatar quedan para una iteración posterior.
 *
 * Verificaciones, EN ORDEN, antes de llamar a cualquier proveedor —
 * cualquier fallo aquí nunca gasta un crédito:
 *  1. AVATAR_MODE_ENABLED=true.
 *  2. El avatar existe Y pertenece al mismo usuario de la solicitud
 *     (nunca confía en el avatarId recibido sin verificar dueño).
 *  3. avatars.consent_given = true.
 *  4. avatars.status no es 'failed' ni 'deleted'.
 *  5. El proveedor resuelto está disponible (isAvailable()).
 *  6. La narración estimada no excede MAX_AVATAR_DURATION_SECONDS.
 *
 * Idempotencia: si la solicitud YA tiene un avatar_provider_video_job_id
 * de un intento anterior, se consulta su estado en vez de volver a pedir
 * un video nuevo — un reintento causado por un fallo DESPUÉS de crear el
 * video (p. ej. la descarga o la subida a Storage) nunca vuelve a
 * facturar la generación en sí.
 */
export async function generateAvatarVideo({
  supabase,
  requestId,
  userId,
  script,
  avatarId,
  voiceId,
  language = "es",
  existingProviderVideoJobId,
  onProgress,
}: {
  supabase: SupabaseClient;
  requestId: string;
  userId: string;
  script: GeneratedScript;
  avatarId: string;
  voiceId?: string;
  language?: ScriptLanguage;
  /** Job del proveedor ya creado en un intento anterior (idempotencia) — ver comentario de arriba. */
  existingProviderVideoJobId?: string | null;
  onProgress?: OnProgress;
}): Promise<{ videoPath: string }> {
  const flags = getFeatureFlags();
  if (!flags.avatarModeEnabled) {
    throw new AvatarPipelineError("El modo avatar no está habilitado (AVATAR_MODE_ENABLED=false).", "mode_disabled");
  }

  const { data: avatar } = await supabase
    .from("avatars")
    .select("id, user_id, status, consent_given, provider_avatar_id, provider")
    .eq("id", avatarId)
    .maybeSingle<AvatarRow>();

  if (!avatar) {
    throw new AvatarPipelineError(`El avatar ${avatarId} no existe.`, "avatar_not_found");
  }
  // Nunca confiar en que avatarId pertenece al usuario solo porque vino en
  // la solicitud — se verifica explícitamente contra la fila real.
  if (avatar.user_id !== userId) {
    throw new AvatarPipelineError("El avatar no pertenece al usuario de esta solicitud.", "avatar_not_owned");
  }
  if (!avatar.consent_given) {
    throw new AvatarPipelineError("Falta el consentimiento del propietario de la fotografía.", "consent_missing");
  }
  if (avatar.status === "failed" || avatar.status === "deleted") {
    throw new AvatarPipelineError(`El avatar está en estado "${avatar.status}", no se puede usar.`, "avatar_not_ready");
  }

  const provider = getAvatarProvider();
  if (!provider.isAvailable()) {
    throw new AvatarPipelineError(`El proveedor de avatar "${provider.name}" no está disponible (¿falta la clave?).`, "provider_unavailable");
  }

  const fullText = script.segments.map((s) => s.text).join(" ");

  // Límite de duración explícito (independiente del tope de caracteres
  // que cada proveedor pueda imponer por su cuenta) — mismo criterio de
  // estimación (palabras/2.5s) que ya usa cada proveedor para el costo,
  // para no gastar ni un segundo de proveedor en un guion desproporcionado.
  const estimatedNarrationSeconds = Math.max(1, fullText.split(/\s+/).filter(Boolean).length / 2.5);
  if (estimatedNarrationSeconds > flags.maxAvatarDurationSeconds) {
    throw new AvatarPipelineError(
      `La narración estimada (${estimatedNarrationSeconds.toFixed(1)}s) excede el máximo permitido (MAX_AVATAR_DURATION_SECONDS=${flags.maxAvatarDurationSeconds}s).`,
      "duration_exceeded",
    );
  }

  // Exigir el avatar creado antes de consumir narración.
  const providerAvatarId = avatar.provider_avatar_id;
  if (!providerAvatarId) {
    throw new AvatarPipelineError(
      "El avatar todavía no terminó de crearse en el proveedor — vuelve a intentar cuando su estado sea 'ready'.",
      "avatar_not_ready",
    );
  }

  if (existingProviderVideoJobId) {
    // Idempotencia: ya se pidió un video en un intento anterior — se
    // consulta su estado en vez de gastar otra vez.
    const status = await provider.checkVideoStatus(existingProviderVideoJobId);
    if (status !== "completed") {
      throw new AvatarPipelineError(
        `El video anterior (job ${existingProviderVideoJobId}) sigue en estado "${status}" — no se solicita uno nuevo para evitar cobrar dos veces.`,
        "provider_error",
      );
    }
    // El proveedor no expone "recuperar el resultado ya completado" de
    // forma separada en esta interfaz — si llega aquí es porque ya se
    // procesó (rama no alcanzable en el fixture/heygen actuales, dejada
    // explícita para el siguiente proveedor que sí lo permita).
    throw new AvatarPipelineError(
      "El video ya se completó en un intento anterior pero no se pudo recuperar su resultado — revisa manualmente antes de reintentar.",
      "provider_error",
    );
  }

  // Durable compare-and-set: only one worker may consume providers for this
  // request, including after crashes/timeouts. Never clear this automatically.
  // Missing migration or database error fails closed before voice consumption.
  const { data: claimed, error: claimError } = await supabase
    .from("video_requests")
    .update({ avatar_generation_started_at: new Date().toISOString() })
    .eq("id", requestId)
    .eq("user_id", userId)
    .is("avatar_generation_started_at", null)
    .is("avatar_provider_video_job_id", null)
    .select("id")
    .maybeSingle();
  if (claimError || !claimed) {
    throw new AvatarPipelineError(
      "No se pudo reservar un intento único. Revisa el intento anterior antes de volver a generar.",
      "attempt_blocked",
    );
  }

  let storageBytes = 0;

  await onProgress?.("voice");

  // La narración propia es obligatoria: un fallo no debe activar TTS
  // interno del proveedor ni cambiar la voz o el consumo silenciosamente.
  const voiceProvider = getVoiceProvider();
  let audioUrl: string | undefined;
  try {
    const voiceResult = await voiceProvider.synthesize(fullText, language);
    const narrationPath = `${requestId}/avatar-narration.${voiceResult.extension}`;
    const { error: narrationUploadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(narrationPath, voiceResult.audioBuffer, { contentType: voiceResult.mimeType, upsert: true });
    if (narrationUploadError) {
      throw new Error(`No se pudo subir el audio de narración: ${narrationUploadError.message}`);
    }
    const { data: signedNarration, error: signError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(narrationPath, NARRATION_SIGNED_URL_TTL_SECONDS);
    if (signError || !signedNarration) {
      throw new Error(`No se pudo firmar la URL de la narración: ${signError?.message ?? "desconocido"}`);
    }
    audioUrl = signedNarration.signedUrl;
    storageBytes += voiceResult.audioBuffer.byteLength;
  } catch {
    // No propagar errores que puedan contener URLs firmadas o credenciales.
    throw new AvatarPipelineError(
      "No se pudo preparar la narración propia. No se solicitó el video de avatar.",
      "narration_failed",
    );
  }

  await onProgress?.("render");
  const renderStartedAt = Date.now();

  let asset: Awaited<ReturnType<typeof provider.generateVideo>>;
  try {
    asset = await provider.generateVideo({
      providerAvatarId,
      script: fullText,
      audioUrl,
      voiceId,
      language,
      maxCostUsd: flags.maxAvatarCostUsd,
      onJobCreated: async (providerJobId) => {
        const { data, error } = await supabase
          .from("video_requests")
          .update({ avatar_provider_video_job_id: providerJobId, avatar_render_status: "processing" })
          .eq("id", requestId)
          .eq("user_id", userId)
          .select("id")
          .maybeSingle();
        if (error || !data) {
          throw new AvatarPipelineError(
            "El proveedor aceptó el intento, pero no se pudo guardar su identificador. No vuelvas a generar.",
            "attempt_blocked",
          );
        }
      },
    });
  } catch (err) {
    if (err instanceof AvatarProviderError) {
      throw new AvatarPipelineError(`${provider.name}: ${err.message}`, "provider_error");
    }
    throw err;
  }
  const renderMs = Date.now() - renderStartedAt;

  // Guarda el job id INMEDIATAMENTE (antes de procesar el resultado) — si
  // algo falla después (descarga/mastering/subida), el próximo intento
  // debe saber que el video YA se generó y no pedir otro.
  await supabase
    .from("video_requests")
    .update({ avatar_provider_video_job_id: asset.providerJobId, avatar_render_status: "completed" })
    .eq("id", requestId);

  // Mastering de loudness — mismo criterio que el modo visual: si ffmpeg
  // no está disponible, se sube sin normalizar en vez de fallar todo.
  await onProgress?.("uploading");
  const rawPath = path.join(os.tmpdir(), `atomivid-avatar-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
  await fs.writeFile(rawPath, asset.buffer);
  storageBytes += asset.buffer.byteLength;

  let outputPath = rawPath;
  try {
    const masteredPath = rawPath.replace(/\.mp4$/, ".mastered.mp4");
    const mastering = await masterAudioLoudness(rawPath, masteredPath);
    outputPath = masteredPath;
    console.log("[atomivid:avatar-audio] masterización de loudness", JSON.stringify({ requestId, target: LOUDNESS_TARGET, ...mastering }));
  } catch (err) {
    console.warn(
      `[atomivid:avatar-audio] ${requestId} — no se pudo masterizar el loudness (¿falta ffmpeg?), se sube el video sin normalizar:`,
      err instanceof Error ? err.message : err,
    );
  }

  const videoBuffer = await fs.readFile(outputPath);
  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(`${requestId}/final.mp4`, videoBuffer, { contentType: "video/mp4", upsert: true });
  if (uploadError) {
    throw new Error(`No se pudo subir el video de avatar: ${uploadError.message}`);
  }

  await fs.unlink(rawPath).catch(() => {});
  if (outputPath !== rawPath) {
    await fs.unlink(outputPath).catch(() => {});
  }

  await recordVideoGeneration(supabase, requestId, {
    voiceProvider: provider.name,
    voiceCharacters: fullText.length,
    footageProvider: "none",
    footageCount: 0,
    musicProvider: "none",
    videoDurationSeconds: asset.durationSeconds ?? 0,
    renderMs,
    storageBytes,
    creativeLayer: {
      avatarProvider: provider.name,
      avatarProviderJobId: asset.providerJobId,
      avatarCostUsd: asset.costUsd,
    },
  }).catch((err) => {
    console.warn(`No se pudo registrar el costo de avatar de ${requestId}:`, err);
  });

  return { videoPath: `${requestId}/final.mp4` };
}
