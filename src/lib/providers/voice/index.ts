import { requireRealProvider } from "../production";
import type { VoiceProvider } from "../types";
import { realVoiceProvider, realVoiceProviderFor } from "./real";
import { fixtureVoiceProvider } from "./fixture";

export function getVoiceProvider(voiceId?: string): VoiceProvider {
  const requested = process.env.VOICE_PROVIDER?.trim();
  requireRealProvider("voice", (!requested || requested === "elevenlabs") && Boolean(process.env.ELEVENLABS_API_KEY?.trim()));
  if (process.env.VOICE_PROVIDER === "fixture") return fixtureVoiceProvider;
  const real = voiceId ? realVoiceProviderFor(voiceId) : realVoiceProvider;
  if (process.env.VOICE_PROVIDER === "elevenlabs") return real;
  return process.env.ELEVENLABS_API_KEY ? real : fixtureVoiceProvider;
}

export type { VoiceProvider, VoiceResult, WordTiming } from "../types";
