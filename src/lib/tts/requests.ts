/**
 * «Texto a voz» — crear y reintentar piezas (SOLO servidor). Las acciones
 * de la página son envoltorios finos de esto para poder probarlo sin Next.
 *
 * - Doble envío: el formulario trae un client_request_id (uuid generado al
 *   abrirlo). La tabla lo hace único por usuaria: el segundo envío devuelve
 *   la MISMA pieza, no crea otra ni la vuelve a encolar.
 * - Límites: por pieza y por mes (caracteres), validados aquí con el
 *   consumo real guardado, nunca con lo que diga el navegador.
 * - Voz: catálogo o «Mi voz» propia, con la propiedad comprobada.
 * - Si no se puede encolar, la pieza queda «failed» con un mensaje claro y
 *   se puede reintentar (nada se cobró).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseVoiceChoice, serializeVoiceChoice } from "@/lib/voices/catalog";
import { resolveCatalogVoice, resolveVoiceChoice, VoiceUnavailableError } from "@/lib/voices/resolve";
import { voiceCostUsd } from "@/lib/video/audiovisual/paid-costs";
import { estimateSeconds, formatCount, monthStartIso, monthlyCharactersUsed, validateTtsInput } from "./segment";
import { isLongPiece, type TtsLimitProfile } from "./limits";
import { parseMusicChoice, type MusicChoice } from "./music-beds";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TTS_DISPATCH_FAILED_MESSAGE = "No se pudo poner en cola. No se cobró nada: puedes reintentar.";
export const MIX_DISPATCH_FAILED_MESSAGE = "No se pudo poner en cola la versión con música. La narración está lista; puedes reintentar.";
export const LONG_PILOT_BUSY_MESSAGE = "Ya hay un episodio largo en preparación. Espera a que termine: los episodios largos se generan de uno en uno para no agotar la cuenta de voz compartida.";

export type TtsLimitsConfig = { maxCharsPerPiece: number; maxCharsPerUserMonth: number };

export async function charactersUsedThisMonth(service: SupabaseClient, userId: string, now = new Date()): Promise<number> {
  const { data, error } = await service
    .from("tts_jobs")
    .select("characters, status, segments_done")
    .eq("user_id", userId)
    .gte("created_at", monthStartIso(now));
  if (error) throw new Error(`No se pudo leer tu consumo: ${error.message}`);
  return monthlyCharactersUsed((data ?? []) as { characters: number; status: string; segments_done: number | null }[]);
}

export async function createTtsRequest(input: {
  service: SupabaseClient;
  userId: string;
  form: { title: unknown; script: unknown; language: unknown; voice: unknown; clientRequestId: unknown; music?: unknown };
  /** Límites de esta cuenta (limits.ts). `general` = máximo por pieza general: por encima, la pieza es un episodio largo del piloto. */
  limits: TtsLimitsConfig | TtsLimitProfile;
  generalMaxCharsPerPiece?: number;
  /** Acompañamiento musical habilitado (TTS_MUSIC_ENABLED). Sin él, toda pieza es «Sin música». */
  musicEnabled?: boolean;
  /** Solo episodios largos: saldo del proveedor para rechazar antes de encolar lo que no cabe (null = no se pudo consultar; el worker vuelve a comprobar). */
  providerQuota?: () => Promise<{ remaining: number } | null>;
  dispatch: (jobId: string) => Promise<void>;
}): Promise<{ ok: true; jobId: string; duplicate: boolean } | { ok: false; error: string }> {
  const { service, userId, form } = input;
  const clientRequestId = typeof form.clientRequestId === "string" ? form.clientRequestId.trim().toLowerCase() : "";
  if (!UUID.test(clientRequestId)) return { ok: false, error: "Recarga la página e inténtalo de nuevo." };

  // Doble envío: si ya existe, se devuelve la misma pieza sin tocarla.
  const existing = await service.from("tts_jobs").select("id").eq("user_id", userId).eq("client_request_id", clientRequestId).maybeSingle<{ id: string }>();
  if (existing.error) return { ok: false, error: "No se pudo comprobar la pieza. Intenta de nuevo." };
  if (existing.data) return { ok: true, jobId: existing.data.id, duplicate: true };

  let used: number;
  try {
    used = await charactersUsedThisMonth(service, userId);
  } catch {
    return { ok: false, error: "No se pudo comprobar tu consumo del mes. Intenta de nuevo." };
  }
  const valid = validateTtsInput(form, { ...input.limits, usedThisMonth: used });
  if (!valid.ok) return valid;

  const choice = parseVoiceChoice(form.voice);
  if (!choice) return { ok: false, error: "Elige una voz válida." };
  let music: MusicChoice = "none";
  if (input.musicEnabled && form.music !== undefined && form.music !== null && form.music !== "") {
    const parsed = parseMusicChoice(form.music);
    if (!parsed) return { ok: false, error: "Elige un acompañamiento válido." };
    music = parsed;
  }
  const generalMax = input.generalMaxCharsPerPiece ?? input.limits.maxCharsPerPiece;
  const long = isLongPiece(valid.characters, generalMax);
  if (long && input.providerQuota) {
    const quota = await input.providerQuota().catch(() => null);
    const reserve = "providerReserveChars" in input.limits ? input.limits.providerReserveChars : 0;
    if (quota && quota.remaining - reserve < valid.characters) {
      return { ok: false, error: `El servicio de voz no tiene caracteres suficientes ahora para este texto (quedan ${formatCount(Math.max(0, quota.remaining - reserve))} disponibles). No se creó la pieza.` };
    }
  }
  let voiceLabel: string;
  try {
    const voice =
      choice.kind === "catalog"
        ? resolveCatalogVoice(choice.id, valid.input.language)
        : await resolveVoiceChoice({ service, userId, choice, language: valid.input.language });
    voiceLabel = voice.label;
  } catch (err) {
    return { ok: false, error: err instanceof VoiceUnavailableError ? err.message : "No se pudo comprobar la voz elegida. Intenta de nuevo." };
  }

  const inserted = await service
    .from("tts_jobs")
    .insert({
      user_id: userId,
      client_request_id: clientRequestId,
      title: valid.input.title,
      language: valid.input.language,
      voice_choice: serializeVoiceChoice(choice),
      voice_label: voiceLabel,
      script: valid.input.script,
      characters: valid.characters,
      segments_total: valid.segments.length,
      status: "queued",
      estimated_seconds: estimateSeconds(valid.segments),
      estimated_usd: Math.round(voiceCostUsd(valid.characters) * 10000) / 10000,
      // La base de datos vuelve a aplicar el límite mensual con un bloqueo por usuaria (dos envíos a la vez no lo superan).
      max_chars_per_month: input.limits.maxCharsPerUserMonth,
      max_chars_per_piece: input.limits.maxCharsPerPiece,
      // Episodio largo del piloto: la base admite uno solo en cola o en proceso en toda la cuenta.
      long_pilot: long,
      music_choice: music,
      mix_status: music === "none" ? null : "pending",
    })
    .select("id")
    .single<{ id: string }>();
  if (inserted.error) {
    if (/tts_monthly_limit/.test(inserted.error.message ?? "")) return { ok: false, error: "Con esta pieza superarías tus caracteres de Texto a voz de este mes." };
    if (/characters_within_piece_limit/.test(inserted.error.message ?? "")) return { ok: false, error: "El texto supera el máximo por pieza de tu cuenta." };
    // Carrera entre dos envíos simultáneos del mismo formulario: gana uno, el otro recibe la misma pieza.
    if (inserted.error.code === "23505") {
      const again = await service.from("tts_jobs").select("id").eq("user_id", userId).eq("client_request_id", clientRequestId).maybeSingle<{ id: string }>();
      if (again.data) return { ok: true, jobId: again.data.id, duplicate: true };
      if (long) return { ok: false, error: LONG_PILOT_BUSY_MESSAGE };
    }
    return { ok: false, error: "No se pudo guardar la pieza. Intenta de nuevo." };
  }

  const jobId = inserted.data.id;
  await dispatchOrFail(service, jobId, input.dispatch);
  return { ok: true, jobId, duplicate: false };
}

async function dispatchOrFail(service: SupabaseClient, jobId: string, dispatch: (jobId: string) => Promise<void>) {
  try {
    await dispatch(jobId);
  } catch (err) {
    console.error(`[atomivid:tts] no se pudo encolar ${jobId}:`, err instanceof Error ? err.message : err);
    await service
      .from("tts_jobs")
      .update({ status: "failed", error_message: TTS_DISPATCH_FAILED_MESSAGE, updated_at: new Date().toISOString() })
      .eq("id", jobId)
      .eq("status", "queued");
  }
}

/** Reintento de una pieza fallida PROPIA: failed → queued (condicional) y se vuelve a encolar. Lo ya generado se reutiliza. */
export async function retryTtsRequest(input: {
  service: SupabaseClient;
  userId: string;
  jobId: unknown;
  dispatch: (jobId: string) => Promise<void>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const jobId = typeof input.jobId === "string" ? input.jobId : "";
  if (!UUID.test(jobId)) return { ok: false, error: "Pieza no válida." };
  const { data, error } = await input.service
    .from("tts_jobs")
    .update({ status: "queued", error_message: null, updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("user_id", input.userId)
    .eq("status", "failed")
    .select("id")
    .maybeSingle();
  if (error?.code === "23505") return { ok: false, error: LONG_PILOT_BUSY_MESSAGE };
  if (error) return { ok: false, error: "No se pudo reintentar. Intenta de nuevo." };
  if (!data) return { ok: false, error: "Esa pieza no existe, no es tuya o no está fallida." };
  await dispatchOrFail(input.service, jobId, input.dispatch);
  return { ok: true };
}

/**
 * Preparar, reintentar o cambiar la versión con música de una pieza PROPIA
 * ya narrada. Nunca vuelve a sintetizar la voz: el worker mezcla la
 * narración guardada. Solo Suspenso o Documental; la narración sin música
 * siempre está disponible. Condicional: si ya hay una mezcla en cola o en
 * proceso, no se encola otra (doble clic).
 */
export async function requestTtsMix(input: {
  service: SupabaseClient;
  userId: string;
  jobId: unknown;
  music: unknown;
  dispatch: (jobId: string) => Promise<void>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const jobId = typeof input.jobId === "string" ? input.jobId : "";
  if (!UUID.test(jobId)) return { ok: false, error: "Pieza no válida." };
  const music = parseMusicChoice(input.music);
  if (!music || music === "none") return { ok: false, error: "Elige Suspenso o Documental." };
  const read = await input.service
    .from("tts_jobs")
    .select("id, user_id, status, mix_status, audio_path")
    .eq("id", jobId)
    .maybeSingle<{ id: string; user_id: string; status: string; mix_status: string | null; audio_path: string | null }>();
  if (read.error) return { ok: false, error: "No se pudo leer la pieza. Intenta de nuevo." };
  const row = read.data;
  if (!row || row.user_id !== input.userId) return { ok: false, error: "Esa pieza no existe o no es tuya." };
  if (row.status !== "completed" || !row.audio_path) return { ok: false, error: "La narración todavía no está lista." };
  if (row.mix_status === "pending" || row.mix_status === "processing") return { ok: false, error: "La versión con música ya se está preparando." };
  let update = input.service
    .from("tts_jobs")
    .update({ music_choice: music, mix_status: "pending", mix_error: null, updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("user_id", input.userId)
    .eq("status", "completed");
  update = row.mix_status === null ? update.is("mix_status", null) : update.eq("mix_status", row.mix_status);
  const { data, error } = await update.select("id").maybeSingle();
  if (error || !data) return { ok: false, error: "No se pudo preparar la versión con música. Intenta de nuevo." };
  try {
    await input.dispatch(jobId);
  } catch (err) {
    console.error(`[atomivid:tts] no se pudo encolar la mezcla ${jobId}:`, err instanceof Error ? err.message : err);
    await input.service
      .from("tts_jobs")
      .update({ mix_status: "failed", mix_error: MIX_DISPATCH_FAILED_MESSAGE, updated_at: new Date().toISOString() })
      .eq("id", jobId)
      .eq("mix_status", "pending");
  }
  return { ok: true };
}
