"use server";
import { gatedVoiceSynthesize } from "@/lib/paid-calls/gated-providers";
import { supabaseLedgerStore } from "@/lib/paid-calls/supabase-ledger-store";
import { supabaseResultStore } from "@/lib/paid-calls/result-store";
import { getVoiceIdentity } from "@/lib/ai/voice";
import { getPricingConfig } from "@/lib/billing/pricing";
import { SupplyUnavailableError } from "@/lib/supply/policy";

import { recordingFormat, recordingPath, RECORDING_BUCKET, MAX_AVATAR_PHOTO_BYTES, MAX_RECORDING_BYTES } from "@/lib/video/avatar/recording";
import { measureNarrationSeconds } from "@/lib/video/avatar/measure-narration";
import { avatarDurationError } from "@/lib/video/avatar/duration";
import { randomUUID } from "node:crypto";
import { createdUrl, formErrorUrl, requestIdForSubmission } from "@/lib/video/submission-key";
import { CLAIM_MESSAGES, createAvatarOnce, isDuplicateUpload, photoClaimPath } from "@/lib/video/avatar/new-photo-claim";
import { canPrepareAvatar } from "@/lib/video/avatar/private-access";
import { redirect } from "next/navigation";
import { checkProductionForRequest } from "@/lib/supply/production-check";
import { formProduction, type ScriptChoice } from "@/lib/video/form-production";
import { MAX_NARRATION_CHARS } from "@/lib/video/narration-fit";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { getAvatarProvider, type AvatarJobStatus } from "@/lib/providers/avatar";
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

const AVATAR_UPLOADS_BUCKET = "avatar-uploads";
// Cuenta de caracteres razonable para un guion de narración leído por un
// avatar — mismo orden de magnitud que MAX_TOPIC_LENGTH del resto del
// formulario, generoso para varios minutos hablados sin ser ilimitado.
const MAX_AVATAR_TTS_TEXT_LENGTH = MAX_NARRATION_CHARS;
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

  // Checklist antes de generar (2026-10-18): the SAME validation the live checklist shows
  // (form-production.ts), enforced here so a direct POST cannot skip it. Nothing is paid by creating.
  const form = formProduction({ mode, topic, style, durationSeconds, language,
    scriptChoice: String(formData.get("script_choice") ?? "generated") as ScriptChoice,
    ownText: String(formData.get(mode === "visual" ? "own_script_text" : "avatar_tts_text") ?? ""),
    adaptAccepted: formData.get("adapt_accepted") === "on",
    avatarNarrationSource: String(formData.get("narration_source") ?? "tts"),
    maxAvatarSeconds: flags.maxAvatarDurationSeconds });
  if (form.inputError) redirect(`/dashboard/new?error=${encodeURIComponent(form.inputError)}`);
  if (form.fit && !form.fit.allowed) redirect(`/dashboard/new?error=${encodeURIComponent(form.fit.message)}`);

  // The request id comes from the draft key the browser shares between its tabs, the verified user and the
  // intent (submission-key.ts): a double click, a resend, a second tab or a re-submit after a lost response is
  // recognised here, before any paid call, and the primary key stays the authority on a race (23505).
  const { requestId, draftKey } = await requestIdForSubmission(user.id, formData);
  const created = createdUrl(draftKey);
  {
    const { data: existing } = await createServiceClient().from("video_requests").select("id").eq("id", requestId).eq("user_id", user.id).maybeSingle();
    if (existing) redirect(created);
  }

  if (mode === "visual") {
    // Only the server can insert requests. Never let a browser write output paths,
    // paid-production approvals or worker state through the Data API.
    // «Usar mi propio guion»: the text is stored now, split into scenes without changing a word; the first
    // paid step (POST /script) only adds the visuals of each scene.
    const { error } = await createServiceClient().from("video_requests").insert({
      id: requestId,
      user_id: user.id,
      topic,
      style,
      duration_seconds: durationSeconds,
      language,
      mode: "visual",
      status: "pending",
      script_json: form.draft,
    });

    if (error) {
      // A concurrent identical submit lost the insert race: the request exists, nothing was paid.
      if (error.code === "23505") redirect(created);
      redirect(`/dashboard/new?error=${encodeURIComponent(error.message)}`);
    }

    redirect(created);
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
  // Control de costos (2026-10-18, corrección 2): requestId (above) is derived from the draft key shared by
  // the browser's tabs, the user and the intent, so a repeat is recognised before any paid call (the voice
  // below is keyed by it in the ledger) and collides on insert.
  // QA blocker real (2026-09-25, Android/Samsung): un límite combinado
  // foto+audio <= 3 MB (heredado de la prueba privada D-ID) rechazaba una
  // grabación real de ~45s recién terminada. Foto y audio ahora se validan
  // por separado, cada uno con su propio límite realista (recording.ts) —
  // nunca se suman entre sí.
  const narrationSource = String(formData.get("narration_source") ?? "tts");
  if (!["tts", "recording", "tts_text"].includes(narrationSource)) redirect("/dashboard/new?error=Fuente+de+voz+inválida");
  if (narrationSource === "tts") {
    const durationError = avatarDurationError(durationSeconds, flags.maxAvatarDurationSeconds);
    if (durationError) redirect(`/dashboard/new?error=${encodeURIComponent(durationError)}`);
  }
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
  // con esta función). Una grabación no medible o demasiado larga se
  // rechaza antes de subirla o crear el avatar. El worker vuelve a medir
  // el archivo guardado antes de solicitar un video al proveedor.
  let ttsTextForSynthesis: string | undefined;
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
      redirect("/dashboard/new?error=No+se+pudo+comprobar+la+duración+de+tu+audio.+Usa+otra+grabación.+No+se+ha+solicitado+el+avatar.");
    }
    const durationError = avatarDurationError(measuredDurationSeconds, flags.maxAvatarDurationSeconds);
    if (durationError) redirect(`/dashboard/new?error=${encodeURIComponent(durationError)}`);
  } else if (narrationSource === "tts_text") {
    // Counted and validated exactly as the form showed it (form-production.ts → narration-fit.ts): the
    // normalised text is what is narrated and billed; the fit (already enforced above) used the slow end.
    const ttsText = form.stats?.text ?? "";
    if (!ttsText) redirect("/dashboard/new?error=Escribe+el+texto+que+quieres+narrar");
    if (ttsText.length > MAX_AVATAR_TTS_TEXT_LENGTH) {
      redirect(`/dashboard/new?error=${encodeURIComponent(`El texto no puede superar ${MAX_AVATAR_TTS_TEXT_LENGTH} caracteres`)}`);
    }
    // Control de costos (2026-10-18): the whole production (plan, voice and avatar capacity) is checked
    // here, before anything paid or provider-side happens; nothing is reserved by this check.
    const preCheck = await checkProductionForRequest({ service: createServiceClient(), user, ownerId: user.id, stage: form.stage,
      request: form.request, fit: form.fit });
    if (preCheck.outcome !== "ready") redirect(`/dashboard/new?error=${encodeURIComponent(`${preCheck.title} ${preCheck.message} ${preCheck.next}`)}`);
    // Se valida ahora, pero se sintetiza solo después de comprobar que el avatar
    // existente es utilizable o que la fotografía nueva pudo crear un avatar ready.
    // Así un POST viejo/manipulado, una foto inválida o un fallo del proveedor de
    // avatar no puede consumir ElevenLabs antes de ser rechazado.
    ttsTextForSynthesis = ttsText;
  }
  const photoFileForSizeCheck = formData.get("avatar_photo");
  if (!String(formData.get("existing_avatar_id") ?? "").trim() && photoFileForSizeCheck instanceof File && photoFileForSizeCheck.size > MAX_AVATAR_PHOTO_BYTES) {
    redirect(`/dashboard/new?error=${encodeURIComponent(`La fotografía supera el límite permitido (${Math.round(MAX_AVATAR_PHOTO_BYTES / 1024 / 1024)} MB).`)}`);
  }

  const existingAvatarId = String(formData.get("existing_avatar_id") ?? "").trim();

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
    // Corrección 2 (residual A): the photo path IS the claim of this request (new-photo-claim.ts). It is taken
    // before createAvatar, so a second identical submit (another tab, a resend) never creates a second avatar.
    const photoPath = photoClaimPath(user.id, requestId, format);
    const claim = await createAvatarOnce({
      async upload(path) {
        const { error } = await service.storage.from(AVATAR_UPLOADS_BUCKET).upload(path, photoBuffer, { contentType: file.type, upsert: false });
        return error ? { ok: false, duplicate: isDuplicateUpload(error as { message?: string; statusCode?: string }), message: error.message } : { ok: true };
      },
      async findAvatarByPhoto(path) {
        const { data } = await service.from("avatars").select("id, status").eq("user_id", user.id).eq("source_photo_path", path)
          .maybeSingle<{ id: string; status: string }>();
        return data ?? null;
      },
      async claimCreatedAt(path) {
        const name = path.slice(path.indexOf("/") + 1);
        const { data } = await service.storage.from(AVATAR_UPLOADS_BUCKET).list(user.id, { search: name, limit: 1 });
        const created = data?.find(o => o.name === name)?.created_at;
        return created ? new Date(created) : null;
      },
      async removePhoto(path) {
        await service.storage.from(AVATAR_UPLOADS_BUCKET).remove([path]);
      },
      async createAvatar() {
        const provider = getAvatarProvider();
        if (!provider.isAvailable() || provider.name !== flags.avatarProvider) throw new Error("El proveedor de avatar no está configurado.");
        const result = await provider.createAvatar({ photoBuffer, mimeType: file.type, consentGiven: true });
        return { providerAvatarId: result.providerAvatarId, providerJobId: result.providerJobId, status: result.status, providerName: provider.name };
      },
      // Server-owned write (migration 20261009040743 revokes client-role writes on avatars);
      // user_id comes from the verified session above, never from the form.
      async insertAvatar(p, path) {
        const { data } = await service.from("avatars").insert({
          user_id: user.id,
          name: avatarName,
          provider: p.providerName,
          provider_avatar_id: p.providerAvatarId,
          provider_job_id: p.providerJobId ?? null,
          source_photo_path: path,
          status: avatarStatusFromProviderStatus(p.status as AvatarJobStatus),
          consent_given: true,
          consent_given_at: new Date().toISOString(),
          consent_policy_version: AVATAR_CONSENT_POLICY_VERSION,
        }).select("id, status").single<{ id: string; status: string }>();
        return data ?? null;
      },
    }, photoPath);

    if (claim.kind === "upload_failed") redirect(formErrorUrl(`No se pudo subir la fotografía: ${claim.message}`));
    if (claim.kind === "provider_failed") redirect(formErrorUrl(claim.message));
    if (claim.kind === "in_flight" || claim.kind === "not_recorded") redirect(formErrorUrl(CLAIM_MESSAGES[claim.kind]));
    // Stale: only a NEW draft (the form rotates the key on `reset`) can create another avatar, by a deliberate submit.
    if (claim.kind === "stale") redirect(formErrorUrl(CLAIM_MESSAGES.stale, draftKey));
    if (claim.avatar.status !== "ready") {
      // Limitación conocida (documentada en docs/AVATAR_MODE.md): esta
      // primera versión no encola un seguimiento en segundo plano del
      // estado de creación del avatar en el proveedor — si no queda listo
      // de inmediato (el fixture y, según lo confirmado, "photo avatar" de
      // HeyGen sí responden de inmediato), no se puede usar todavía.
      redirect(
        "/dashboard/new?error=El+avatar+sigue+procesándose+en+el+proveedor%2C+inténtalo+de+nuevo+en+unos+minutos",
      );
    }
    avatarId = claim.avatar.id;
  }


  if (ttsTextForSynthesis) {
    try {
      // Operación potencialmente pagada: ocurre solo cuando avatarId ya apunta a
      // un avatar ready y comprobado. Para una fotografía nueva, el avatar creado
      // queda guardado y reutilizable aunque la síntesis falle después.
      const service = createServiceClient();
      const voiceResult = await gatedVoiceSynthesize({ requestId, ledger: supabaseLedgerStore(service),
        results: supabaseResultStore(service), voiceProvider: getVoiceProvider(),
        voiceIdentity: getVoiceIdentity(language as "es" | "en"),
        estimatedCostUsd: ttsTextForSynthesis.length / 1000 * getPricingConfig().elevenLabsUsdPer1kChars,
      }, ttsTextForSynthesis, language as "es" | "en");
      recording = { audioBuffer: voiceResult.audioBuffer, extension: voiceResult.extension, mimeType: voiceResult.mimeType };
      narrationSourceForDb = "tts";
      await recordAvatarNarrationTts(createServiceClient(), requestId, {
        voiceProvider: getVoiceProvider().name,
        characters: ttsTextForSynthesis.length,
      }).catch(() => {});
      try {
        measuredDurationSeconds = await measureNarrationSeconds(voiceResult.audioBuffer);
      } catch {
        // No bloquea: la duración estimada ya pasó el límite antes de crear el avatar.
      }
    } catch (error) {
      if (error instanceof SupplyUnavailableError) redirect(`/dashboard/new?error=${encodeURIComponent(error.customerMessage)}`);
      redirect("/dashboard/new?error=No+se+pudo+generar+la+voz+a+partir+del+texto.+Tu+avatar+queda+guardado+para+reintentar.");
    }
  }
  const audioPath = recording ? recordingPath(user.id, requestId, recording.extension) : null;
  if (recording && audioPath) {
    const { error: audioError } = await createServiceClient().storage.from(RECORDING_BUCKET)
      .upload(audioPath, recording.audioBuffer, { contentType: recording.mimeType, upsert: false });
    if (audioError) {
      // A concurrent identical submit already stored this audio (same id → same path) and created the request.
      const { data: winner } = await createServiceClient().from("video_requests").select("id").eq("id", requestId).eq("user_id", user.id).maybeSingle();
      if (winner) redirect(created);
      redirect("/dashboard/new?error=No+se+pudo+guardar+la+grabación+privada");
    }
  }
  const { error } = await createServiceClient().from("video_requests").insert({
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
    // La UI no ofrece una voz hasta que exista catálogo autorizado y el pipeline pueda aplicarla de verdad.
    avatar_voice_id: null,
    idempotency_key: randomUUID(),
    status: recording ? "script_ready" : "pending",
  });

  if (error) {
    // Lost the insert race to an identical submit: that request owns the audio at this path; never remove it.
    if (error.code === "23505") redirect(created);
    if (audioPath) await createServiceClient().storage.from(RECORDING_BUCKET).remove([audioPath]).catch(() => {});
    redirect(`/dashboard/new?error=${encodeURIComponent(error.message)}`);
  }

  redirect(created);
}
