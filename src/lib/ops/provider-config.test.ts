import { test } from "node:test";
import assert from "node:assert/strict";
import { providerConfigReport, providerConfigSignature, validProviderConfigSignature } from "./provider-config";
import { resetVoiceCache } from "@/lib/podcast/voices";

const SECRET = "s".repeat(40), NONCE = "6b4b3c1e-0000-4000-8000-000000000001";

test("firma: válida solo con secreto, nonce y hora correctos", () => {
  const ts = String(Date.now());
  assert.ok(validProviderConfigSignature(SECRET, NONCE, ts, providerConfigSignature(SECRET, NONCE, ts)));
  assert.ok(!validProviderConfigSignature(SECRET, NONCE, ts, providerConfigSignature("x".repeat(40), NONCE, ts)));
  const old = String(Date.now() - 400_000);
  assert.ok(!validProviderConfigSignature(SECRET, NONCE, old, providerConfigSignature(SECRET, NONCE, old)));
  assert.ok(!validProviderConfigSignature(undefined, NONCE, ts, providerConfigSignature(SECRET, NONCE, ts)));
});

test("informe: presencia sin valor, nombres de variables, voz Hans podcast; nunca IDs ni la clave", async () => {
  resetVoiceCache();
  const key = "sk_" + "a".repeat(40);
  const fetchImpl = (async () => new Response(JSON.stringify({ voices: [{ voice_id: "abcdefgh12345678", name: "Hans podcast", category: "cloned" }, { voice_id: "zzzzzzzz12345678", name: "Mateo" }] }))) as typeof fetch;
  const r = await providerConfigReport({ ELEVENLABS_API_KEY: ` ${key} `, ELEVENLABS_VOICE_ID: "v", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_SHA: "0123456789" }, fetchImpl);
  assert.deepEqual(r, { vercelEnv: "production", commit: "0123456", elevenlabsKey: "present", elevenEnvNames: ["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"], voices: { ok: true, count: 2, hansPodcast: true } });
  assert.doesNotMatch(JSON.stringify(r), /sk_|abcdefgh/);
  resetVoiceCache();
  const missing = await providerConfigReport({}, fetchImpl);
  assert.equal(missing.elevenlabsKey, "missing");
  assert.equal(missing.voices.ok, false);
  resetVoiceCache();
  assert.equal((await providerConfigReport({ ELEVENLABS_API_KEY: "   " }, fetchImpl)).elevenlabsKey, "blank");
});
