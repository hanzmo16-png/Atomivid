"use server";

import { recordingFormat, recordingPath, RECORDING_BUCKET, MAX_AVATAR_PHOTO_BYTES, MAX_RECORDING_BYTES } from "@/lib/video/avatar/recording";
import { measureNarrationSeconds } from "@/lib/video/avatar/measure-narration";
import { randomUUID } from "node:crypto";
import { canPrepareAvatar } from "@/lib/video/avatar/private-access";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { getAvatarProvider, AvatarProviderError, type AvatarJobStatus } from "@/lib/providers/avatar";
import { getVoiceProvider } from "@/lib/providers/voice";
import { validatePhotoBuffer } from "@/lib/video/avatar/photo-validation";
import { recordAvatarNarrationTts } from "@/lib/billing/usage";
import {
  avatarStatusFromProviderStatus,
  isAvatarConsentGiven,
  resolveMode,
  validateCommonFields,
  validateNewAvatarSubmission,
} from "./validation";
import { parseSelection } from "@/lib/video/audiovisual/catalog";
import { isMissingColumnError } from "@/lib/video/audiovisual/persistence";
import { profileAvailabilityByDuration } from "@/lib/video/audiovisual/readiness";

const AVATAR_UPLOADS_BUCKET = "avatar-uploads";
// Cuenta de caracteres razonable para un guion de narración leído por un
// avatar — mismo orden de magnitud que MAX_TOPIC_LENGTH del resto del
// formulario, generoso para varios minutos hablados sin ser ilimitado.
const MAX_AVATAR_TTS_TEXT_LENGTH = 2000;
/**
 * Versión del texto de consentimiento vigente (src/app/terms/page.tsx,
 * sección #avatar-consent) — se guarda junto con cada avatar para poder
 * saber, si el texto cambia más adelante, bajo qué versión aceptó cada
 * usuario. Actualizar este valor si ese texto cambia de forma sustantiva.
 */
const AVATAR_CONSENT_POLICY_VERSION = "2026-09-17";

export async function createVideoRequest(formData: FormData) {
  const topic = String(formData.get("topic") ?? "").trim();
  const style = String(formData.get("style") ?? "").trim();
  const durationSeconds = Number(formData.get("duration_seconds"));
  const language = String(formData.get("language") ?? "es").trim();
  const rawMode = String(formData.get("mode") ?? "visual").trim();

  const commonError = validateCommonFields({ topic, style, durationSeconds, language });
  if (commonError) {
    redirect(`/dashboard/new?error=${encodeURIComponent(commonError)}`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Nunca confiar en el <select>/radio del cliente para decidir si el modo
  // avatar está disponible — se re-verifica en el servidor. AVATAR_MODE_ENABLED
  // es el interruptor GLOBAL de rollout (apagado en producción a la fecha de
  // este comentario); canPrepareAvatar(user) es la cuenta beta privada — igual
  // que la prueba D-ID legacy, esa cuenta nunca dependió de ese flag global
  // para poder probar el modo avatar. Blocker real de QA (2026-09-25): con
  // AVATAR_MODE_ENABLED apagado, esta cuenta se quedó sin poder enviar
  // mode=avatar aunque sí tuviera acceso privado — un POST manual de
  // cualquier otra cuenta con mode=avatar se sigue tratando como modo
  // inválido exactamente igual que antes.
  const flags = getFeatureFlags();
  const avatarModeUiEnabled = flags.avatarModeEnabled || canPrepareAvatar(user);
  const modeResult = resolveMode(rawMode, avatarModeUiEnabled);
  if (!modeResult.ok) {
    redirect(`/dashboard/new?error=${encodeURIComponent(modeResult.error)}`);
  }
  const mode = modeResult.mode;

  if (mode === "avatar" && !canPrepareAvatar(user)) {
    redirect("/dashboard/new?error=Esta+prueba+privada+no+está+disponible+para+tu+cuenta");
  }

  if (mode === "visual") {
    // Dirección audiovisual (solo Reels, solo con el flag encendido): se
    // valida aquí, nunca se confía en las tarjetas del cliente. Con el flag
    // apagado la solicitud se crea exactamente como antes.
    let audiovisualSelection: Record<string, unknown> | undefined;
    if (flags.audiovisualProfilesEnabled) {
      const parsed = parseSelection({
        profile: formData.get("av_profile"),
        intent: formData.get("av_intent"),
        music: formData.get("av_music"),
        pace: formData.get("av_pace"),
      });
      if (!parsed.ok) {
        redirect(`/dashboard/new?error=${encodeURIComponent(parsed.error)}`);
      }
      // Un perfil ilustrado sin generación/presupuesto no se acepta: se
      // avisa ahora en vez de fallar al producir.
      const availability = profileAvailabilityByDuration([durationSeconds])[durationSeconds]?.[parsed.selection.profile];
      if (availability && !availability.ok) {
        redirect(`/dashboard/new?error=${encodeURIComponent("Esa dirección visual no está disponible para este video. Elige otra.")}`);
      }
      audiovisualSelection = parsed.selection;
    }

    const { error } = await supabase.from("video_requests").insert({
      user_id: user.id,
      topic,
      style,
      duration_seconds: durationSeconds,
      language,
      mode: "visual",
      status: "pending",
      ...(audiovisualSelection ? { audiovisual_selection: audiovisualSelection } : {}),
    });

    if (error) {
      // Nunca crear la solicitud sin la dirección elegida (eso cambiaría en
      // silencio lo que el cliente pidió): si falta la migración 0020, se dice.
      const message = isMissingColumnError(error)
        ? "La dirección audiovisual todavía no está disponible. Intenta más tarde."
        : error.message;
      redirect(`/dashboard/new?error=${encodeURIComponent(message)}`);
    }

    redirect("/dashboard?created=1");
  }

  // --- Modo avatar -------------------------------------------------------
  // El consentimiento se re-verifica aquí — el atributo "required" del
  // checkbox en el cliente es solo una ayuda de UX, nunca la fuente de
  // verdad. Se exige tanto al reusar un avatar existente como al subir
  // uno nuevo (la UI muestra el checkbox en ambos casos).
  if (!isAvatarConsentGiven(formData.get("avatar_consent"))) {
    redirect("/dashboard/new?error=Debes+aceptar+el+consentimiento+del+modo+avatar");
  }

  // Generado aquí (no al final) para poder asociar el costo real de una
  // síntesis TTS (si aplica, ver más abajo) con la MISMA solicitud que se
  // inserta al final de esta función — nunca un id descartable.
  const requestId = randomUUID();

  // QA blocker real (2026-09-25, Android/Samsung): un límite combinado
  // foto+audio <= 3 MB (heredado de la prueba privada D-ID) rechazaba una
  // grabación real de ~45s recién terminada. Foto y audio ahora se validan
  // por separado, cada uno con su propio límite realista (recording.ts) —
  // nunca se suman entre sí.
  const narrationSource = String(formData.get("narration_source") ?? "tts");
  if (!["tts", "recording", "tts_text"].includes(narrationSource)) redirect("/dashboard/new?error=Fuente+de+voz+inválida");
  const audioFile = formData.get("recorded_audio");
  let recording: { audioBuffer: Buffer; extension: string; mimeType: string } | undefined;
  // "own_audio" cubre tanto grabar como subir un archivo (mismo mecanismo,
  // sin costo de síntesis para nosotros); "tts" es la única fuente con
  // costo real de ElevenLabs — ver avatar_narration_source en generation_costs.
  let narrationSourceForDb: "own_audio" | "tts" | null = null;
  // Contrato de duración (RC QA 2026-09-25): para "recording"/"tts_text" la
  // duración efectiva del video es la duración REAL del audio, nunca el
  // objetivo 30/60/90 del selector (que para estas dos fuentes ni siquiera
  // se muestra en el formulario — ver NewVideoForm.tsx). Se mide aquí con
  // el mismo mecanismo ya probado en producción por preparation.ts (la
  // prueba privada D-ID, que ya guarda `duration_seconds: Math.ceil(seconds)`
  // con esta función) — puramente informativo (Historial, "Revisar
  // grabación"); la validación que sí bloquea la generación si excede
  // MAX_AVATAR_DURATION_SECONDS ocurre de forma autoritativa en
  // pipeline.ts, que vuelve a medir el archivo ya guardado.
  let measuredDurationSeconds: number | undefined;
  if (narrationSource === "recording") {
    // Antes esto solo se permitía para "did"/"fixture" — un resabio de
    // cuando HeyGen todavía no soportaba audio propio. pipeline.ts YA
    // admite recordedAudioPath con HeyGen (ver generateAvatarVideo); esa
    // restricción bloqueaba "Grabar mi voz"/"Subir audio" para el
    // proveedor que es el default real (AVATAR_PROVIDER=heygen).
    if (!(audioFile instanceof File) || !audioFile.size) redirect("/dashboard/new?error=Selecciona+tu+grabación");
    if (audioFile.size > MAX_RECORDING_BYTES) {
      redirect(`/dashboard/new?error=${encodeURIComponent(`El audio supera el límite permitido (${Math.round(MAX_RECORDING_BYTES / 1024 / 1024)} MB). Puedes volver a grabarlo o subir otro.`)}`);
    }
    try {
      const audioBuffer = Buffer.from(await audioFile.arrayBuffer());
      recording = { audioBuffer, ...recordingFormat(audioBuffer) };
      narrationSourceForDb = "own_audio";
    } catch {
      redirect("/dashboard/new?error=No+se+pudo+leer+el+audio.+Usa+M4A,+MP3+o+WAV.");
    }
    try {
      measuredDurationSeconds = await measureNarrationSeconds(recording.audioBuffer);
    } catch {
      // No bloquea la creación — solo se pierde el número informativo
      // preciso y se cae al valor del selector como aproximación.
    }
  } else if (narrationSource === "tts_text") {
    const ttsText = String(formData.get("avatar_tts_text") ?? "").trim();
    if (!ttsText) redirect("/dashboard/new?error=Escribe+el+texto+que+quieres+narrar");
    if (ttsText.length > MAX_AVATAR_TTS_TEXT_LENGTH) {
      redirect(`/dashboard/new?error=${encodeURIComponent(`El texto no puede superar ${MAX_AVATAR_TTS_TEXT_LENGTH} caracteres`)}`);
    }
    try {
      // Reutiliza el mismo provider ElevenLabs que ya usa Reel para
      // narración — nunca un cliente/pipeline TTS paralelo.
      const voiceResult = await getVoiceProvider().synthesize(ttsText, language as "es" | "en");
      recording = { audioBuffer: voiceResult.audioBuffer, extension: voiceResult.extension, mimeType: voiceResult.mimeType };
      narrationSourceForDb = "tts";
      // Costo real registrado AHORA (momento de la síntesis) — pipeline.ts
      // nunca vuelve a llamar a ElevenLabs para una solicitud con
      // recorded_audio_path ya presente (idempotente), así que este es el
      // único lugar donde se genera y se cobra este audio.
      await recordAvatarNarrationTts(createServiceClient(), requestId, {
        voiceProvider: getVoiceProvider().name,
        characters: ttsText.length,
      }).catch(() => {});
      try {
        measuredDurationSeconds = await measureNarrationSeconds(voiceResult.audioBuffer);
      } catch {
        // Igual que en "recording": no bloquea, solo se pierde el número informativo preciso.
      }
    } catch {
      redirect("/dashboard/new?error=No+se+pudo+generar+la+voz+a+partir+del+texto.+Intenta+de+nuevo.");
    }
  }
  const photoFileForSizeCheck = formData.get("avatar_photo");
  if (!String(formData.get("existing_avatar_id") ?? "").trim() && photoFileForSizeCheck instanceof File && photoFileForSizeCheck.size > MAX_AVATAR_PHOTO_BYTES) {
    redirect(`/dashboard/new?error=${encodeURIComponent(`La fotografía supera el límite permitido (${Math.round(MAX_AVATAR_PHOTO_BYTES / 1024 / 1024)} MB).`)}`);
  }

  const existingAvatarId = String(formData.get("existing_avatar_id") ?? "").trim();
  const avatarVoiceId = String(formData.get("avatar_voice_id") ?? "").trim() || undefined;

  let avatarId: string;

  if (existingAvatarId) {
    // Se reusa un avatar ya creado — se verifica que exista y que
    // pertenezca al usuario (la policy de RLS de "avatars" ya limita el
    // select a las filas propias, pero se comprueba explícitamente en vez
    // de asumirlo solo por la ausencia de error).
    const { data: avatar } = await supabase
      .from("avatars")
      .select("id, status, provider")
      .eq("id", existingAvatarId)
      .maybeSingle<{ id: string; status: string; provider: string }>();

    if (!avatar || avatar.status !== "ready") {
      redirect("/dashboard/new?error=El+avatar+seleccionado+no+está+disponible");
    }
    // Defensa en profundidad (QA real, 2026-09-25): page.tsx ya solo lista
    // avatares del proveedor actual, pero esto evita el mismo fallo —
    // descubierto muy tarde, dentro de pipeline.ts, ya con la solicitud
    // creada — ante un POST directo o una pestaña vieja con la lista sin
    // filtrar todavía cargada.
    if (avatar.provider !== flags.avatarProvider) {
      redirect("/dashboard/new?error=Ese+avatar+fue+creado+con+otro+proveedor.+Elige+otro+o+sube+una+fotografía+nueva.");
    }
    avatarId = avatar.id;
  } else {
    // Se sube una fotografía nueva.
    const photo = formData.get("avatar_photo");
    const avatarName = String(formData.get("avatar_name") ?? "").trim();

    const newAvatarError = validateNewAvatarSubmission({
      hasPhotoFile: photo instanceof File,
      photoSizeBytes: photo instanceof File ? photo.size : 0,
      avatarName,
    });
    if (newAvatarError) {
      redirect(`/dashboard/new?error=${encodeURIComponent(newAvatarError)}`);
    }

    const file = photo as File;
    const photoBuffer = Buffer.from(await file.arrayBuffer());
    const validation = validatePhotoBuffer(photoBuffer, file.type);
    if (!validation.valid) {
      redirect(`/dashboard/new?error=${encodeURIComponent(`Fotografía inválida: ${validation.reason}`)}`);
    }
    const { format } = validation;

    // El bucket "avatar-uploads" es privado y sin policies de cliente (ver
    // migración 0011) — la subida solo puede hacerse con la service role,
    // nunca con el cliente autenticado por el usuario.
    const service = createServiceClient();
    const photoPath = `${user.id}/${randomUUID()}.${format}`;
    const { error: uploadError } = await service.storage
      .from(AVATAR_UPLOADS_BUCKET)
      .upload(photoPath, photoBuffer, { contentType: file.type, upsert: false });
    if (uploadError) {
      redirect(`/dashboard/new?error=${encodeURIComponent(`No se pudo subir la fotografía: ${uploadError.message}`)}`);
    }

    let providerAvatarId: string;
    let providerJobId: string | undefined;
    let providerStatus: AvatarJobStatus;
    let providerName: string;
    try {
      const provider = getAvatarProvider();
      if (!provider.isAvailable() || provider.name !== flags.avatarProvider) throw new Error("El proveedor de avatar no está configurado.");
      providerName = provider.name;
      const result = await provider.createAvatar({ photoBuffer, mimeType: file.type, consentGiven: true });
      providerAvatarId = result.providerAvatarId;
      providerJobId = result.providerJobId;
      providerStatus = result.status;
    } catch (err) {
      // La fotografía ya se subió — se limpia para no dejar un archivo
      // huérfano si el proveedor rechaza la creación del avatar.
      await service.storage.from(AVATAR_UPLOADS_BUCKET).remove([photoPath]).catch(() => {});
      const message =
        err instanceof AvatarProviderError
          ? err.message
          : err instanceof Error
            ? err.message
            : "No se pudo crear el avatar en el proveedor";
      redirect(`/dashboard/new?error=${encodeURIComponent(message)}`);
    }

    const { data: inserted, error: insertError } = await supabase
      .from("avatars")
      .insert({
        user_id: user.id,
        name: avatarName,
        provider: providerName,
        provider_avatar_id: providerAvatarId,
        provider_job_id: providerJobId ?? null,
        source_photo_path: photoPath,
        status: avatarStatusFromProviderStatus(providerStatus),
        consent_given: true,
        consent_given_at: new Date().toISOString(),
        consent_policy_version: AVATAR_CONSENT_POLICY_VERSION,
      })
      .select("id, status")
      .single<{ id: string; status: string }>();

    if (insertError || !inserted) {
      await service.storage.from(AVATAR_UPLOADS_BUCKET).remove([photoPath]).catch(() => {});
      redirect(
        `/dashboard/new?error=${encodeURIComponent(`No se pudo guardar el avatar: ${insertError?.message ?? "error desconocido"}`)}`,
      );
    }
    if (inserted.status !== "ready") {
      // Limitación conocida (documentada en docs/AVATAR_MODE.md): esta
      // primera versión no encola un seguimiento en segundo plano del
      // estado de creación del avatar en el proveedor — si no queda listo
      // de inmediato (el fixture y, según lo confirmado, "photo avatar" de
      // HeyGen sí responden de inmediato), no se puede usar todavía.
      redirect(
        "/dashboard/new?error=El+avatar+sigue+procesándose+en+el+proveedor%2C+inténtalo+de+nuevo+en+unos+minutos",
      );
    }
    avatarId = inserted.id;
  }

  const audioPath = recording ? recordingPath(user.id, requestId, recording.extension) : null;
  if (recording && audioPath) {
    const { error: audioError } = await createServiceClient().storage.from(RECORDING_BUCKET)
      .upload(audioPath, recording.audioBuffer, { contentType: recording.mimeType, upsert: false });
    if (audioError) redirect("/dashboard/new?error=No+se+pudo+guardar+la+grabación+privada");
  }
  const { error } = await supabase.from("video_requests").insert({
    id: requestId,
    recorded_audio_path: audioPath,
    avatar_narration_source: narrationSourceForDb,
    script_json: recording
      ? {
          title: topic,
          segments: [{
            text: narrationSourceForDb === "tts"
              ? "[Se utilizará el audio generado con IA a partir del texto que escribiste, sin sintetizar otra voz.]"
              : "[Se utilizará tu grabación completa, sin sintetizar otra voz.]",
            visualQuery: "avatar",
          }],
        }
      : null,
    user_id: user.id,
    topic,
    style,
    // "recording"/"tts_text": duración REAL medida del audio (ver arriba).
    // "tts" (guion generado): el objetivo 30/60/90 elegido, sin cambios —
    // ese selector sí representa la duración objetivo del guion en ese caso.
    duration_seconds: measuredDurationSeconds !== undefined ? Math.ceil(measuredDurationSeconds) : durationSeconds,
    language,
    mode: "avatar",
    avatar_id: avatarId,
    avatar_voice_id: recording ? null : avatarVoiceId ?? null,
    idempotency_key: randomUUID(),
    status: recording ? "script_ready" : "pending",
  });

  if (error) {
    if (audioPath) await createServiceClient().storage.from(RECORDING_BUCKET).remove([audioPath]).catch(() => {});
    redirect(`/dashboard/new?error=${encodeURIComponent(error.message)}`);
  }

  redirect("/dashboard?created=1");
}
