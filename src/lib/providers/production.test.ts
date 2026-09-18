import test from "node:test";
import assert from "node:assert/strict";
import { getScriptProvider } from "./script";
import { getVoiceProvider } from "./voice";
import { getFootageProvider } from "./footage";
import { getMusicProvider } from "./music";
import { getAvatarProvider } from "./avatar";
import { getImageProvider } from "./image";
import { getVideoProvider } from "./video-gen";
import { ProviderConfigurationError } from "./production";

const cases = [
  ["SCRIPT_PROVIDER", "ANTHROPIC_API_KEY", "anthropic", getScriptProvider],
  ["VOICE_PROVIDER", "ELEVENLABS_API_KEY", "elevenlabs", getVoiceProvider],
  ["FOOTAGE_PROVIDER", "PEXELS_API_KEY", "pexels", getFootageProvider],
  ["AVATAR_PROVIDER", "DID_API_KEY", "did", getAvatarProvider],
  ["IMAGE_PROVIDER", "OPENAI_API_KEY", "openai", getImageProvider],
  ["VIDEO_PROVIDER", "RUNWAY_API_KEY", "runway", getVideoProvider],
  ["MUSIC_PROVIDER", "BEATOVEN_API_KEY", "beatoven", getMusicProvider],
] as const;
for (const [variable, key, real, select] of cases) {
  test(`${variable}: production refuses missing keys, unknown providers and explicit fixtures`, () => {
    const original = { ...process.env };
    try {
      process.env.ATOMIVID_RUNTIME = "production";
      process.env.PREMIUM_CLIPS_ENABLED = "true";
      process.env[variable] = real; delete process.env[key];
      assert.throws(select, ProviderConfigurationError);
      process.env[key] = "unit-test-value";
      assert.notEqual(select().name, "fixture");
      process.env[variable] = "fixture";
      assert.throws(select, ProviderConfigurationError);
      process.env[variable] = "typo";
      assert.throws(select, ProviderConfigurationError);
    } finally { for (const k of Object.keys(process.env)) if (!(k in original)) delete process.env[k]; Object.assign(process.env, original); }
  });
}
