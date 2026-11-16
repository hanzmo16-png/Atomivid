import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { TtsProvider } from "@/lib/podcast/v3/pipeline";
import { realTts } from "@/lib/podcast/v3/adapters";
import { espeakVoice } from "@/lib/podcast/v2/espeak-provider";
import { VOICE_PRESETS, voicePreset } from "./model";

/**
 * Proveedor de voz de Audio Podcast Studio. Reutiliza los adaptadores existentes sin modificarlos:
 *  - «fixture»: espeak-ng local (gratis, sin red). `espeakVoice` se niega a funcionar en producción (VERCEL/NODE_ENV).
 *  - «elevenlabs»: el adaptador real de Podcast (`realTts`). Solo con AUDIO_STUDIO_PAID_TTS=1 y voz configurada;
 *    en 1.0 ese interruptor no está activado en ningún entorno: la generación real queda pendiente de autorización.
 */
export type StudioVoice = { provider: TtsProvider; mode: "fixture" | "elevenlabs"; voiceIdFor(preset: string): string };

export type VoiceAvailability = { ok: true; voice: StudioVoice } | { ok: false; reason: string };

export const PAID_BLOCKED =
  "La generación real con ElevenLabs no está habilitada en Audio Podcast Studio 1.0. Requiere una autorización de gasto posterior; no se hizo ninguna llamada ni cargo.";

const isProduction = (env: Record<string, string | undefined>) => !!env.VERCEL || env.NODE_ENV === "production";

/** Voz espeak distinta y fija por perfil; las femeninas usan el perfil femenino. */
function fixtureProfile(preset: string): number {
  const v = voicePreset(preset);
  if (!v) return 0;
  const sameGender = VOICE_PRESETS.filter((p) => p.gender === v.gender);
  return v.gender === "femenina" ? 1 : sameGender.indexOf(v) === 0 ? 0 : 2;
}

export function fixtureVoice(opts: { fail?: (text: string) => void } = {}): StudioVoice {
  const calls: { voiceId: string; text: string }[] = [];
  return {
    mode: "fixture",
    voiceIdFor: (preset) => `fixture-${preset}`,
    provider: {
      name: "fixture-espeak", label: "mock", model: "espeak-ng", usdFor: () => 0,
      async synth(text, voiceId, dest) {
        const preset = voiceId.replace(/^fixture-/, "");
        opts.fail?.(text);
        const v = espeakVoice(voiceId, null, calls as never, () => fixtureProfile(preset));
        const r = await v.synthesize(text, "es", 1);
        await writeFile(dest, r.audioBuffer);
        return { actualUsd: 0 };
      },
    },
  };
}

export function voiceAvailability(env: Record<string, string | undefined> = process.env): VoiceAvailability {
  if (env.AUDIO_STUDIO_VOICE === "fixture" && !isProduction(env)) {
    // Inyección de fallo SOLO en pruebas locales: un texto con la marca simula un error del proveedor.
    const failMark = env.AUDIO_STUDIO_FIXTURE_FAIL_MARK;
    return { ok: true, voice: fixtureVoice({ fail: failMark ? (t) => { if (t.includes(failMark)) throw new Error("Proveedor de voz no disponible (simulado)."); } : undefined }) };
  }
  if (env.AUDIO_STUDIO_PAID_TTS === "1") {
    const map = parseVoiceMap(env.AUDIO_STUDIO_ELEVENLABS_VOICES);
    if (!map) return { ok: false, reason: "Falta configurar las voces de ElevenLabs del estudio. No se hizo ningún cargo." };
    return { ok: true, voice: { mode: "elevenlabs", provider: realTts("es"), voiceIdFor: (preset) => map[preset] ?? "" } };
  }
  return { ok: false, reason: PAID_BLOCKED };
}

/** «perfil=voiceId,perfil=voiceId»; exige una voz válida por cada perfil del catálogo. */
export function parseVoiceMap(raw: string | undefined): Record<string, string> | null {
  if (!raw) return null;
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [k, v] = pair.split("=").map((x) => x?.trim());
    if (k && v && voicePreset(k) && /^[A-Za-z0-9]{8,64}$/.test(v)) out[k] = v;
  }
  return VOICE_PRESETS.every((p) => out[p.id]) ? out : null;
}

/** Clave de caché de una intervención: mismo proveedor, modelo, voz y texto ⇒ mismo audio (nunca se paga dos veces). */
export function segmentKey(provider: string, model: string, voiceId: string, text: string): string {
  return createHash("sha256").update(JSON.stringify([provider, model, voiceId, text])).digest("hex");
}
