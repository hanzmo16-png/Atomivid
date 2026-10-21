import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AccountVoice } from "@/lib/podcast/voices";
import { parseVoices, resetVoiceCache } from "@/lib/podcast/voices";
import { canUsePrivateVoice, isPrivateVoice, parsePrivateVoiceGrants, supportsModel, visibleVoices } from "./private-voices";
import { reelVoiceChoices, validateReelVoiceSelection } from "@/lib/video/reel-voices";

// Fixture ids only; the real voice id lives in server configuration (PRIVATE_VOICE_GRANTS), never in code.
const OWNER = { id: "u-owner", email: "Owner@Example.test", email_confirmed_at: "2026-10-01T00:00:00Z" };
const OTHER = { id: "u-other", email: "other@example.test", email_confirmed_at: "2026-10-01T00:00:00Z" };
const env = { PRIVATE_VOICE_GRANTS: "PrivClone001=owner@example.test; bad id=x@y.z;Instant0001=owner@example.test|second@example.test" };
const voice = (voiceId: string, over: Partial<AccountVoice> = {}): AccountVoice => ({ voiceId, name: voiceId, category: "premade", language: "es", accent: null, gender: null,
  previewUrl: `https://example.test/${voiceId}.mp3`, isOwner: false, models: [], ...over });
const pro = voice("PrivClone001", { name: "duro fixture", category: "professional", isOwner: true, previewUrl: null, models: ["eleven_multilingual_v2", "eleven_flash_v2_5"] });
const instant = voice("Instant0001", { name: "instant clone", category: "cloned", isOwner: true });
const otherClone = voice("NotGranted01", { name: "otro clon", category: "cloned", isOwner: true });
const untrained = voice("PrivClone001", { ...pro, models: ["eleven_flash_v2_5"] });
const library = voice("uYlzyj2kIZo3HfBB21vF", { name: "Mateo", category: "professional", isOwner: false });
const account = [voice("StockEs0001"), voice("StockEn0001", { language: "en" }), pro, instant, otherClone, library, voice("default001")];

test("grants: parsed from config, case-insensitive email, malformed entries ignored", () => {
  const g = parsePrivateVoiceGrants(env.PRIVATE_VOICE_GRANTS);
  assert.deepEqual([...g.keys()].sort(), ["Instant0001", "PrivClone001"]);
  assert.ok(g.get("Instant0001")!.has("second@example.test"));
  assert.equal(parsePrivateVoiceGrants(undefined).size, 0);
});

test("authorization: only the granted confirmed account; never another account, anonymous or unconfirmed", () => {
  assert.equal(canUsePrivateVoice("PrivClone001", OWNER, env), true);
  assert.equal(canUsePrivateVoice("PrivClone001", OTHER, env), false);
  assert.equal(canUsePrivateVoice("PrivClone001", null, env), false);
  assert.equal(canUsePrivateVoice("PrivClone001", { ...OWNER, email_confirmed_at: null }, env), false);
  assert.equal(canUsePrivateVoice("PrivClone001", OWNER, {}), false, "no config → nobody");
  assert.equal(isPrivateVoice(pro) && isPrivateVoice(instant) && !isPrivateVoice(library) && !isPrivateVoice(voice("x0000000")), true);
});

test("compatibility with the TTS model in use comes from provider metadata", () => {
  assert.equal(supportsModel(pro, "eleven_multilingual_v2"), true);
  assert.equal(supportsModel(untrained, "eleven_multilingual_v2"), false);
  assert.equal(supportsModel(instant, "eleven_multilingual_v2"), true);
  const parsed = parseVoices({ voices: [{ voice_id: "PrivClone001", name: "duro", category: "professional", is_owner: true, preview_url: null,
    high_quality_base_model_ids: ["eleven_flash_v2_5"], fine_tuning: { state: { eleven_multilingual_v2: "fine_tuned", eleven_turbo_v2: "not_started" } } }] });
  assert.equal(parsed[0].isOwner, true);
  assert.deepEqual(parsed[0].models!.sort(), ["eleven_flash_v2_5", "eleven_multilingual_v2"]);
});

test("Reel catalogue: owner sees own clones first (even without preview); other users never do", () => {
  const mine = reelVoiceChoices(account, "es", "default001", { viewer: OWNER, env });
  assert.deepEqual(mine.filter(v => v.kind === "private").map(v => v.voiceId).sort(), ["Instant0001", "PrivClone001"]);
  assert.equal(mine[0].kind, "private");
  assert.equal(mine.find(v => v.voiceId === "PrivClone001")!.previewUrl, null);
  assert.ok(!mine.some(v => v.voiceId === "NotGranted01"));
  assert.equal(mine.find(v => v.voiceId === library.voiceId)!.kind, "library");
  const theirs = reelVoiceChoices(account, "es", "default001", { viewer: OTHER, env });
  assert.ok(!theirs.some(v => v.kind === "private"));
  assert.ok(!JSON.stringify(theirs).includes("PrivClone001"));
  assert.ok(!reelVoiceChoices([untrained], "es", "default001", { viewer: OWNER, env }).length, "not trained for model → not offered");
});

test("validation before any paid call: private voice rejected for other account, accepted for owner", () => {
  const mine = reelVoiceChoices(account, "es", "default001", { viewer: OWNER, env });
  const theirs = reelVoiceChoices(account, "es", "default001", { viewer: OTHER, env });
  assert.equal(validateReelVoiceSelection("PrivClone001", true, mine), "PrivClone001");
  assert.throws(() => validateReelVoiceSelection("PrivClone001", true, theirs), /ya no está disponible/);
  assert.throws(() => validateReelVoiceSelection("PrivClone001", false, mine), /ya no está disponible/, "flag off: explicit choice fails closed, no silent default");
});

test("Podcast list/creation hide private clones from non-granted accounts", () => {
  assert.ok(visibleVoices(account, OWNER, env).some(v => v.voiceId === "PrivClone001"));
  assert.ok(!visibleVoices(account, OWNER, env).some(v => v.voiceId === "NotGranted01"));
  assert.ok(!visibleVoices(account, OTHER, env).some(v => isPrivateVoice(v)));
  assert.ok(visibleVoices(account, OTHER, env).some(v => v.voiceId === library.voiceId), "shared library voices unchanged");
  const server = readFileSync("src/lib/podcast/server.ts", "utf8");
  assert.match(server, /visibleVoices\(voices, viewer\)\.find/);
  assert.match(readFileSync("src/app/api/podcast/route.ts", "utf8"), /\}, user\);/);
  assert.match(readFileSync("src/app/api/podcast/voices/route.ts", "utf8"), /visibleVoices\(await listAccountVoices\(\), user\)/);
  assert.match(readFileSync("src/app/dashboard/podcast/page.tsx", "utf8"), /visibleVoices\(await listAccountVoices\(\), user\)/);
});

test("server resolution uses the signed-in viewer (mocked provider list, no network)", async () => {
  const saved = { ...process.env }; const savedFetch = globalThis.fetch;
  let calls = 0;
  try {
    Object.assign(process.env, { REEL_VOICE_SELECTION_ENABLED: "true", ELEVENLABS_API_KEY: "test-not-a-key", PRIVATE_VOICE_GRANTS: env.PRIVATE_VOICE_GRANTS, ELEVENLABS_MODEL_ID: "eleven_flash_v2_5" });
    const { resolveReelVoiceSelection } = await import("@/lib/video/reel-voices-server");
    resetVoiceCache();
    globalThis.fetch = (async (url: string) => { calls++; assert.equal(String(url), "https://api.elevenlabs.io/v1/voices");
      return Response.json({ voices: [{ voice_id: "PrivClone001", name: "duro", category: "professional", is_owner: true, preview_url: null,
        high_quality_base_model_ids: ["eleven_flash_v2_5"] }] }); }) as typeof fetch;
    assert.equal(await resolveReelVoiceSelection("PrivClone001", "es", OWNER), "PrivClone001");
    await assert.rejects(resolveReelVoiceSelection("PrivClone001", "es", OTHER), /ya no está disponible/);
    assert.equal(await resolveReelVoiceSelection("", "es", OTHER), null);
    assert.equal(calls, 1, "free GET cached; no synthesis endpoint ever called");
  } finally { process.env = saved; globalThis.fetch = savedFetch; resetVoiceCache(); }
});

test("route and action pass the authenticated user, never a client-supplied identity", () => {
  assert.match(readFileSync("src/app/api/reel/voices/route.ts", "utf8"), /getReelVoiceCatalog\(language, user\)/);
  assert.match(readFileSync("src/app/dashboard/new/actions.ts", "utf8"), /resolveReelVoiceSelection\(formData\.get\("reel_voice_id"\), language === "en" \? "en" : "es", user\)/);
});
