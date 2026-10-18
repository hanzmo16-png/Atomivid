import { generateToneWav } from "../wav";
import type { VoiceProvider, WordTiming } from "../types";
import { WORDS_PER_SECOND } from "@/lib/video/script-pacing";
import { ProviderRejectedError } from "@/lib/paid-calls/errors";

let synthesizeCalls = 0;
/**
 * T40 (local E2E only): FIXTURE_VOICE_FAIL=<http status>[@<n>] makes the synthetic provider refuse exactly like the real
 * adapter does on an HTTP error (ProviderRejectedError, a pre-acceptance refusal): on every call, or only on the n-th
 * call of this process. Fixture providers are refused in production (isProductionRuntime), so this can never run there.
 */
function injectedFailure(call: number): string | null {
  const m = /^([1-5]\d{2})(?:@([1-9]\d*))?$/.exec(process.env.FIXTURE_VOICE_FAIL ?? "");
  if (!m) return null;
  return m[2] === undefined || Number(m[2]) === call ? m[1] : null;
}

/**
 * T44 correction 1 (local E2E only): FIXTURE_VOICE_WORD_SECONDS="<i>:<s>,<i>-<j>:<s>" gives words i (or i..j, global
 * word index over the whole narration) a duration of s seconds. Fixture providers are refused in production.
 */
function wordSecondsOverrides(): Map<number, number> {
  const out = new Map<number, number>();
  for (const part of (process.env.FIXTURE_VOICE_WORD_SECONDS ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?:(\d+(?:\.\d+)?)$/.exec(part);
    if (!m) continue;
    const from = Number(m[1]), to = m[2] === undefined ? from : Number(m[2]), s = Number(m[3]);
    if (!(s > 0)) continue;
    for (let i = from; i <= to; i++) out.set(i, s);
  }
  return out;
}

// Proveedor determinístico (sin red): genera un tono en vez de narración
// real, pero con timestamps por palabra realistas — sirve para probar
// sincronía de subtítulos/escenas y el render completo sin ELEVENLABS_API_KEY.
//
// WORDS_PER_SECOND se importa de script-pacing.ts (antes era una constante
// local duplicada, también en 2.6) — con dos copias independientes de la
// misma constante, actualizar una sin la otra desincroniza cuánto texto
// genera el guion fixture de cuánto tarda en "narrarlo" el timing fixture,
// produciendo una duración simulada muy alejada de la pedida (detectado
// al correr test:pipeline tras recalibrar script-pacing.ts: un video de
// 75s pedidos terminó con 150s reales, el doble). Nunca afectó a
// producción real (ElevenLabs mide el timing real, no lo estima), pero sí
// hacía que las pruebas locales con fixtures no fueran representativas.
export const fixtureVoiceProvider: VoiceProvider = {
  name: "fixture",
  async synthesize(text, _language, speed = 1) {
    const status = injectedFailure(++synthesizeCalls);
    if (status) throw new ProviderRejectedError(`ElevenLabs respondió ${status}: Service Unavailable (fixture)`);
    const wordsRaw = text.split(/\s+/).filter(Boolean);
    // Simula el efecto de `speed` (ver VoiceProvider.synthesize en
    // providers/types.ts): más rápido → cada palabra dura menos.
    const wordDuration = 1 / WORDS_PER_SECOND / speed;
    const overrides = wordSecondsOverrides();

    // T44 correction 1 (local E2E only): some words may be given a different real duration (FIXTURE_VOICE_WORD_SECONDS)
    // so a claim can be narrated in under 250 ms; the timestamps stay contiguous and monotonic like a real provider's.
    let cursor = 0;
    const words: WordTiming[] = wordsRaw.map((w, i) => {
      const d = overrides.get(i) ?? wordDuration;
      const t = { text: w, startSeconds: cursor, endSeconds: cursor + d };
      cursor += d;
      return t;
    });

    const durationSeconds = words.length > 0 ? words[words.length - 1].endSeconds : 1;
    const audioBuffer = generateToneWav({ durationSeconds, frequencyHz: 220, amplitude: 0.15 });

    return { audioBuffer, durationSeconds, words, mimeType: "audio/wav", extension: "wav" };
  },
};
