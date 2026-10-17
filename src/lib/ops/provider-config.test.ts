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
  const { heygen, keys, ...rest } = r;
  assert.deepEqual(rest, { vercelEnv: "production", commit: "0123456", elevenlabsKey: "present", elevenEnvNames: ["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"], voices: { ok: true, count: 2, hansPodcast: true, userVoice: { found: false, category: null } } });
  assert.equal(keys.ELEVENLABS_API_KEY, "present");
  assert.equal(keys.ANTHROPIC_API_KEY, "missing");
  assert.equal(heygen.key, "missing");
  assert.doesNotMatch(JSON.stringify(r), /sk_|abcdefgh/);
  resetVoiceCache();
  const missing = await providerConfigReport({}, fetchImpl);
  assert.equal(missing.elevenlabsKey, "missing");
  assert.equal(missing.voices.ok, false);
  resetVoiceCache();
  assert.equal((await providerConfigReport({ ELEVENLABS_API_KEY: "   " }, fetchImpl)).elevenlabsKey, "blank");
});

test("HeyGen: estado de la clave, HTTP y compatibilidad de billing_type/wallet con el lector de suministro", async () => {
  const { heygenProbe } = await import("./provider-config");
  const me = (data: unknown, status = 200) => (async () => new Response(JSON.stringify({ data }), { status })) as typeof fetch;
  const wallet = await heygenProbe({ HEYGEN_API_KEY: "hk_live" }, me({ billing_type: "wallet", wallet: { currency: "usd", remaining_balance: 12.5 } }));
  assert.deepEqual([wallet.key, wallet.usersMe.http, wallet.shape?.billingTypeWallet, wallet.shape?.currency, wallet.snapshot.reliability, wallet.snapshot.unit, wallet.legacyUsdWalletReader], ["present", 200, true, "usd", "provider_api", "usd", true]);
  const sub = await heygenProbe({ HEYGEN_API_KEY: "hk_live" }, me({ billing_type: "subscription", wallet: { currency: "usd", remaining_balance: 30 } }));
  assert.deepEqual([sub.shape?.billingTypeWallet, sub.snapshot.reliability, sub.snapshot.availablePresent, sub.legacyUsdWalletReader], [false, "none", false, true], "the supply reader refuses a non-wallet account even if a usd wallet field exists");
  const credits = await heygenProbe({ HEYGEN_API_KEY: "hk_live" }, me({ billing_type: "wallet", wallet: { currency: "credits", remaining_balance: 900 } }));
  assert.deepEqual([credits.snapshot.unit, credits.legacyUsdWalletReader], ["credit", false]);
  const denied = await heygenProbe({ HEYGEN_API_KEY: "hk_live" }, me({}, 401));
  assert.deepEqual([denied.usersMe.http, denied.snapshot.health, denied.shape], [401, "DOWN", null]);
  assert.equal((await heygenProbe({ HEYGEN_API_KEY: "••••" }, me({}))).key, "masked");
  assert.equal((await heygenProbe({ HEYGEN_API_KEY: " " }, me({}))).key, "blank");
  const pub = { ...wallet, sealed: undefined };
  assert.doesNotMatch(JSON.stringify(pub), /12\.5|hk_live/, "public part carries no balance or key");
});
