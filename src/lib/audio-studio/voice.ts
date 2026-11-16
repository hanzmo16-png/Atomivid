import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { TtsProvider } from "@/lib/podcast/v3/pipeline";
import { buildTtsRequest } from "@/lib/ai/voice";
import { espeakVoice } from "@/lib/podcast/v2/espeak-provider";
import { DEFAULT_TTS_MODEL, ttsModel, VOICE_PRESETS, voicePreset, type TtsModelId } from "./model";

/**
 * Proveedor de voz de Audio Podcast Studio, por modelo.
 *  - «fixture»: espeak-ng local (gratis, sin red). `espeakVoice` se niega a funcionar en producción (VERCEL/NODE_ENV).
 *    Se identifica con el modelo elegido para que la caché de cada modelo quede separada también en pruebas.
 *  - «elevenlabs»: adaptador aislado del estudio que reutiliza `buildTtsRequest` (sin modificarlo) con el model_id
 *    elegido y SOLO los ajustes de voz admitidos por ese modelo. Requiere AUDIO_STUDIO_PAID_TTS=1 y el mapa de voces:
 *    ese interruptor no está activado en ningún entorno; la generación real queda pendiente de autorización.
 */
export type StudioVoice = { mode: "fixture" | "elevenlabs"; provider(model: TtsModelId): TtsProvider; voiceIdFor(preset: string): string };

export type VoiceAvailability = { ok: true; voice: StudioVoice } | { ok: false; reason: string };

export const PAID_BLOCKED =
  "La generación real con ElevenLabs no está habilitada en Audio Podcast Studio 1.0. Requiere una autorización de gasto posterior; no se hizo ninguna llamada ni cargo.";

const isProduction = (env: Record<string, string | undefined>) => !!env.VERCEL || env.NODE_ENV === "production";

/** Ajustes base del estudio (los mismos valores de la voz del producto). Cada modelo recibe solo los suyos. */
export const BASE_VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0.2, use_speaker_boost: true } as const;

/** Ajustes que se envían para un modelo (los no comprobados para ese modelo no se envían). */
export function settingsFor(model: TtsModelId): Record<string, number | boolean> {
  const allowed = ttsModel(model)?.voiceSettings ?? ttsModel(DEFAULT_TTS_MODEL)!.voiceSettings;
  return Object.fromEntries(allowed.map((k) => [k, BASE_VOICE_SETTINGS[k]]));
}

/** Voz espeak distinta y fija por perfil; las femeninas usan el perfil femenino. */
function fixtureProfile(preset: string): number {
  const v = voicePreset(preset);
  if (!v) return 0;
  const sameGender = VOICE_PRESETS.filter((p) => p.gender === v.gender);
  return v.gender === "femenina" ? 1 : sameGender.indexOf(v) === 0 ? 0 : 2;
}

export function fixtureVoice(opts: { fail?: (text: string, model: TtsModelId) => void; calls?: { model: TtsModelId; voiceId: string; text: string }[] } = {}): StudioVoice {
  const log: { voiceId: string; text: string }[] = [];
  return {
    mode: "fixture",
    voiceIdFor: (preset) => `fixture-${preset}`,
    provider: (model) => ({
      name: "fixture-espeak", label: "mock", model, usdFor: () => 0,
      async synth(text, voiceId, dest) {
        const preset = voiceId.replace(/^fixture-/, "");
        opts.fail?.(text, model);
        opts.calls?.push({ model, voiceId, text });
        const v = espeakVoice(voiceId, null, log as never, () => fixtureProfile(preset));
        const r = await v.synthesize(text, "es", 1);
        await writeFile(dest, r.audioBuffer);
        return { actualUsd: 0 };
      },
    }),
  };
}

export class StudioProviderRejected extends Error { constructor(m: string) { super(m); this.name = "ProviderRejectedError"; } }
export const TTS_TIMEOUT_MS = 180_000;

/**
 * Adaptador real (ElevenLabs) por modelo. `rate` es la tarifa de la autorización (USD/1K); el costo de cada llamada se
 * calcula con ella. Un rechazo HTTP (no se generó nada) se distingue de un fallo de red/tiempo (resultado incierto).
 */
export function elevenLabsProvider(model: TtsModelId, rate: number, opts: { apiKey?: string; fetchImpl?: typeof fetch } = {}): TtsProvider {
  const usdFor = (n: number) => Math.ceil((n / 1000) * rate * 1e4) / 1e4;
  return {
    name: "elevenlabs", label: "real adapter (untested live)", model, usdFor,
    async synth(text, voiceId, dest) {
      const apiKey = opts.apiKey ?? process.env.ELEVENLABS_API_KEY ?? "";
      if (!apiKey) throw new StudioProviderRejected("Falta la credencial de ElevenLabs en el servidor. No se hizo ningún cargo.");
      const req = buildTtsRequest({ text, voiceId, modelId: model, voiceSettings: settingsFor(model), apiKey });
      const res = await (opts.fetchImpl ?? fetch)(req.url, { ...req.init, signal: AbortSignal.timeout(TTS_TIMEOUT_MS) });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new StudioProviderRejected(`ElevenLabs (${model}) respondió ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as { audio_base64?: string };
      if (!data.audio_base64) throw new Error("ElevenLabs no devolvió audio.");
      await writeFile(dest, Buffer.from(data.audio_base64, "base64"));
      return { actualUsd: usdFor(text.length) };
    },
  };
}

export function voiceAvailability(env: Record<string, string | undefined> = process.env, rateFor: (model: TtsModelId) => number = () => 0.2): VoiceAvailability {
  if (env.AUDIO_STUDIO_VOICE === "fixture" && !isProduction(env)) {
    // Inyección de fallo SOLO en pruebas locales: un texto con la marca simula un error del proveedor.
    const failMark = env.AUDIO_STUDIO_FIXTURE_FAIL_MARK;
    return { ok: true, voice: fixtureVoice({ fail: failMark ? (t) => { if (t.includes(failMark)) throw new Error("Proveedor de voz no disponible (simulado)."); } : undefined }) };
  }
  if (env.AUDIO_STUDIO_PAID_TTS === "1") {
    const map = parseVoiceMap(env.AUDIO_STUDIO_ELEVENLABS_VOICES);
    if (!map) return { ok: false, reason: "Falta configurar las voces de ElevenLabs del estudio. No se hizo ningún cargo." };
    return { ok: true, voice: { mode: "elevenlabs", provider: (model) => elevenLabsProvider(model, rateFor(model)), voiceIdFor: (preset) => map[preset] ?? "" } };
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

/**
 * Clave de caché de una intervención: proveedor + modelo + voz + texto + ajustes de síntesis. Cualquier diferencia es
 * otra síntesis (nunca se reutiliza audio de otro modelo o con otros ajustes); igualdad ⇒ nunca se paga dos veces.
 */
export function segmentKey(provider: string, model: string, voiceId: string, text: string, settings: Record<string, unknown> = {}): string {
  const sorted = Object.fromEntries(Object.entries(settings).sort(([a], [b]) => a.localeCompare(b)));
  return createHash("sha256").update(JSON.stringify([provider, model, voiceId, text, sorted])).digest("hex");
}
