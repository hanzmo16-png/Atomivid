import { requireRealProvider } from "../production";
import type { VoiceProvider } from "../types";
import { realVoiceProvider } from "./real";
import { fixtureVoiceProvider } from "./fixture";

export function getVoiceProvider(): VoiceProvider {
  const requested = process.env.VOICE_PROVIDER?.trim();
  requireRealProvider("voice", (!requested || requested === "elevenlabs") && Boolean(process.env.ELEVENLABS_API_KEY?.trim()));
  if (process.env.VOICE_PROVIDER === "fixture") return fixtureVoiceProvider;
  if (process.env.VOICE_PROVIDER === "elevenlabs") return realVoiceProvider;
  return process.env.ELEVENLABS_API_KEY ? realVoiceProvider : fixtureVoiceProvider;
}

export type { VoiceProvider, VoiceResult, WordTiming } from "../types";
