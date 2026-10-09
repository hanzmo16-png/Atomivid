/**
 * Podcast episode 1 ("Crónicas y Misterios del Universo"), owner-authorized 2026-10-09.
 * One step per invocation. Logs print structure only; private material leaves the runner only via
 * seal() (AES-256-GCM + RSA-OAEP to ops/session-public-key.txt) into sealed-out/.
 */
import { createClient } from "@supabase/supabase-js";
import { createHash, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes, createCipheriv, createDecipheriv, constants } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const TEST_REQUEST = "6dad04ec-c77f-4df7-9391-73382ac8d9f5";
const OPS_PREFIX = "ops/podcast-episode";
const RUNNER_KEY = `${OPS_PREFIX}/runner-key.pem`;
const log = (tag: string, v: unknown) => console.log(tag, JSON.stringify(v));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const db = () => createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
const WORK = "/tmp/episode";
mkdirSync(WORK, { recursive: true });
mkdirSync("sealed-out", { recursive: true });

/** Encrypts bytes to the operator session key; the file name is the only plain metadata. */
function seal(name: string, bytes: Buffer) {
  if (!/^[a-z0-9-]+\.[a-z0-9]+$/.test(name)) throw Error("bad sealed name");
  const key = randomBytes(32), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(bytes), c.final()]);
  const ek = publicEncrypt({ key: readFileSync("ops/session-public-key.txt", "utf8"), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  writeFileSync(`sealed-out/${name}.sealed`, [ek, iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join("."));
  log("SEALED_FILE", { name, bytes: bytes.length });
}

/** Opens a file sealed (same format) to the runner key kept in private storage. */
async function unsealWithRunnerKey(path: string): Promise<Buffer> {
  const { data } = await db().storage.from("videos").download(RUNNER_KEY);
  if (!data) throw Error("runner key missing (run keygen first)");
  const pem = Buffer.from(await data.arrayBuffer()).toString("utf8");
  const [ek, iv, tag, ct] = readFileSync(path, "utf8").trim().split(".").map((s) => Buffer.from(s, "base64"));
  const key = privateDecrypt({ key: pem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, ek);
  const d = createDecipheriv("aes-256-gcm", key, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

async function testRequest() {
  const { data: r } = await db().from("video_requests").select("id,user_id,avatar_id,video_path,recorded_audio_path,status").eq("id", TEST_REQUEST).single();
  const { data: a } = await db().from("avatars").select("id,source_photo_path,provider_avatar_id,status").eq("id", r!.avatar_id).single();
  return { r: r!, a: a! };
}

/** Keypair whose private half never leaves private storage; the public half is printed. Never overwritten. */
async function keygen() {
  const s = db().storage.from("videos");
  const { data: existing } = await s.download(RUNNER_KEY);
  let pub: string;
  if (existing) {
    const { createPublicKey } = await import("node:crypto");
    pub = createPublicKey(Buffer.from(await existing.arrayBuffer()).toString("utf8")).export({ type: "spki", format: "pem" }).toString();
    log("RUNNER_KEY", { created: false });
  } else {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const up = await s.upload(RUNNER_KEY, Buffer.from(privateKey), { contentType: "application/x-pem-file", upsert: false });
    if (up.error) throw Error(`key upload failed ${up.error.message.slice(0, 80)}`);
    pub = publicKey;
    log("RUNNER_KEY", { created: true });
  }
  console.log("RUNNER_PUBLIC_KEY_BEGIN\n" + pub.trim() + "\nRUNNER_PUBLIC_KEY_END");
}

/** HeyGen's published API pricing, read from the official docs (public pages; printed verbatim lines only). */
async function verifyRate() {
  const get = async (u: string) => { try { const r = await fetch(u, { signal: AbortSignal.timeout(20000), redirect: "follow" }); return r.ok ? await r.text() : `HTTP ${r.status}`; } catch (e) { return `ERR ${(e as Error).message.slice(0, 60)}`; } };
  const index = await get("https://developers.heygen.com/llms.txt");
  const links = [...new Set((index.match(/https:\/\/developers\.heygen\.com\/[^\s)]+/g) ?? []).filter((u) => /pric|limit|credit|billing|avatar-iv|photo|audio-to-video|videos/i.test(u)))].slice(0, 25);
  log("HEYGEN_DOC_LINKS", { indexOk: !index.startsWith("HTTP") && !index.startsWith("ERR"), links });
  const extra = ["https://help.heygen.com/en/articles/10060327-heygen-api-pricing-explained", "https://www.heygen.com/api-pricing"];
  for (const u of [...links, ...extra]) {
    const text = (await get(u)).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ");
    const lines = text.split(/\n|(?<=\.)\s/).map((l) => l.trim()).filter((l) => l.length < 400 && /(photo avatar|avatar iv|1080|720|per (second|minute)|\$\s?\d|credits? per)/i.test(l)).slice(0, 40);
    log("HEYGEN_DOC", { url: u, status: text.slice(0, 12), lines });
  }
}

/** Approved look: photo, frames of the approved test, and a person cut-out preview (sealed). */
async function inspect() {
  const { r, a } = await testRequest();
  const s = (b: string) => db().storage.from(b);
  const photo = await s("avatar-uploads").download(a.source_photo_path);
  const video = await s("videos").download(r.video_path);
  if (!photo.data || !video.data) throw Error("approved media missing");
  const p = Buffer.from(await photo.data.arrayBuffer()), v = Buffer.from(await video.data.arrayBuffer());
  writeFileSync(`${WORK}/photo`, p); writeFileSync(`${WORK}/test.mp4`, v);
  log("APPROVED_MEDIA", { photoSha: sha(p).slice(0, 12), photoBytes: p.length, videoSha: sha(v).slice(0, 12), videoBytes: v.length, providerAvatarKind: String(a.provider_avatar_id).split(":")[0] });
  execFileSync("python3", ["scripts/podcast-episode/media.py", "inspect", WORK], { stdio: "inherit" });
  for (const f of ["photo.jpg", "cutout-preview.jpg", "test-frames.jpg"]) if (existsSync(`${WORK}/out/${f}`)) seal(f.replace(".jpg", "") + ".jpg", readFileSync(`${WORK}/out/${f}`));
}

/** Script and plan into durable private storage (owner path), decrypted on the runner only. */
async function storeDocs() {
  const { r } = await testRequest();
  const s = db().storage.from("videos");
  for (const name of ["guion.md", "plan-y-presupuesto.md"]) {
    const bytes = await unsealWithRunnerKey(`${OPS_PREFIX}/${name}.sealed`);
    const path = `${r.user_id}/podcasts/episodio-01/${name}`;
    const up = await s.upload(path, bytes, { contentType: "text/markdown; charset=utf-8", upsert: true });
    if (up.error) throw Error(`upload failed ${up.error.message.slice(0, 80)}`);
    const { data: back } = await s.download(path);
    const ok = !!back && sha(Buffer.from(await back.arrayBuffer())) === sha(bytes);
    log("STORED_DOC", { name, bytes: bytes.length, sha256: sha(bytes).slice(0, 16), verifiedReadBack: ok });
  }
}

type Block = { kind: "A" | "V"; id: string; note: string; text: string };
const AUTH = JSON.parse(readFileSync("ops/podcast-episode.authorization.json", "utf8")) as { elevenlabsMaxCredits: number; heygenMaxUsd: number; imagesMaxUsd: number; maxTotalUsd: number; heygenTopUpConfirmed: boolean };
const EPISODE_TITLE = "Crónicas y Misterios del Universo — Ep. 1: Las dimensiones de la conciencia";

export function parseScript(md: string): Block[] {
  const out: Block[] = [];
  const re = /^## ([AV]) (\w+)([^\n]*)\n([\s\S]*?)(?=^## |(?![\s\S]))/gm;
  for (const m of md.matchAll(re)) out.push({ kind: m[1] as "A" | "V", id: m[2], note: m[3].replace(/^\s*\|\s*/, "").trim(), text: m[4].trim() });
  if (out.length < 10 || new Set(out.map((b) => b.id)).size !== out.length) throw Error("script parse failed");
  return out;
}

/** The owner's episode row (created once, idempotent by title) whose id keys the paid ledger. */
async function episodeRow() {
  const { r } = await testRequest();
  const s = db();
  const { data: found } = await s.from("podcast_episodes").select("id,user_id,status").eq("user_id", r.user_id).eq("title", EPISODE_TITLE).maybeSingle();
  if (found) return found as { id: string; user_id: string; status: string };
  const { data, error } = await s.from("podcast_episodes").insert({ user_id: r.user_id, title: EPISODE_TITLE, language: "es", source: "upload", status: "draft" }).select("id,user_id,status").single();
  if (error || !data) throw Error(`episode insert failed ${error?.code ?? ""}`);
  return data as { id: string; user_id: string; status: string };
}

/** Voice of the approved sample episode (the owner's "Atomivid 2485ab5a"), never a fallback. */
async function approvedVoiceId(userId: string) {
  const { data } = await db().from("podcast_episodes").select("voice_id,voice_name,created_at").eq("user_id", userId).eq("source", "tts").eq("status", "ready").order("created_at", { ascending: true });
  const v = (data ?? []).find((e) => typeof e.voice_name === "string" && e.voice_name.includes("Atomivid 2485ab5a"));
  if (!v?.voice_id) throw Error("approved voice not found on the sample episode");
  return v.voice_id as string;
}

/** Credits already consumed or held by this episode's ElevenLabs ledger rows. */
async function elevenCreditsUsed(project: string) {
  const { data } = await db().from("pi_paid_operations").select("status,capacity_units").eq("project_id", project).eq("provider", "elevenlabs").neq("status", "REFUNDED");
  return (data ?? []).reduce((a, o) => a + Number(o.capacity_units ?? 0), 0);
}

/** Paid (subscription credits): every block through the product's gated TTS; reruns reuse stored results at 0. */
async function narrate() {
  const script = (await unsealWithRunnerKey(`${OPS_PREFIX}/guion.md.sealed`)).toString("utf8");
  const blocks = parseScript(script);
  const ep = await episodeRow();
  const project = `podcast-${ep.id}`;
  const voiceId = await approvedVoiceId(ep.user_id);
  const { getVoiceIdentity, synthesizeVoice } = await import("../../src/lib/ai/voice");
  const { gatedVoiceSynthesize } = await import("../../src/lib/paid-calls/gated-providers");
  const { supabaseLedgerStore } = await import("../../src/lib/paid-calls/supabase-ledger-store");
  const { supabaseResultStore } = await import("../../src/lib/paid-calls/result-store");
  const { ensureJobSupplyReady } = await import("../../src/lib/supply/readiness");
  const { podcastDemand, ceil4 } = await import("../../src/lib/podcast/episode");
  const { getPricingConfig } = await import("../../src/lib/billing/pricing");
  const identity = getVoiceIdentity("es", voiceId);
  const total = blocks.reduce((a, b) => a + b.text.length, 0);
  const used = await elevenCreditsUsed(project);
  log("NARRATION_PLAN", { blocks: blocks.length, avatarBlocks: blocks.filter((b) => b.kind === "A").length, characters: total, creditsAlreadyHeld: used, cap: AUTH.elevenlabsMaxCredits, model: identity.modelId });
  // Worst case: nothing is reusable. Never start a run that could cross the owner's credit cap.
  if (used + total > AUTH.elevenlabsMaxCredits && used === 0) throw Error("credit cap would be exceeded; nothing sent");
  const rate = getPricingConfig().elevenLabsUsdPer1kChars;
  const ready = await ensureJobSupplyReady(db(), [podcastDemand({ characters: total, usd: ceil4((total / 1000) * rate) })], { refresh: true });
  log("ELEVENLABS_READY", { ready: ready.ready, failure: ready.failure ?? null });
  if (!ready.ready) throw Error("ElevenLabs capacity not ready; nothing sent");
  const provider = { name: "elevenlabs", synthesize: async (text: string, language: "es" | "en" = "es", speed?: number) => ({ ...(await synthesizeVoice(text, language, speed, voiceId)), mimeType: "audio/mpeg", extension: "mp3" }) };
  const deps = { ledger: supabaseLedgerStore(db()), results: supabaseResultStore(db(), "videos"), voiceProvider: provider as never, voiceIdentity: identity, requestId: project };
  const manifest: Record<string, unknown>[] = [];
  let reused = 0, paidChars = 0;
  for (const b of blocks) {
    const before = await elevenCreditsUsed(project);
    if (before + b.text.length > AUTH.elevenlabsMaxCredits) throw Error(`credit cap reached before block ${b.id}; stopped`);
    const r = await gatedVoiceSynthesize({ ...deps, estimatedCostUsd: ceil4((b.text.length / 1000) * rate) }, b.text, "es");
    if (r.reused) reused++; else paidChars += b.text.length;
    const path = `${ep.user_id}/podcasts/${ep.id}/blocks/${b.id}.${r.extension}`;
    const up = await db().storage.from("videos").upload(path, r.audioBuffer, { contentType: r.mimeType, upsert: true });
    if (up.error) throw Error("block upload failed");
    manifest.push({ id: b.id, kind: b.kind, note: b.note, chars: b.text.length, seconds: Math.round(r.durationSeconds * 100) / 100, audioPath: path, words: r.words });
    log("BLOCK", { id: b.id, kind: b.kind, chars: b.text.length, seconds: Math.round(r.durationSeconds * 10) / 10, reused: r.reused });
  }
  const mpath = `${ep.user_id}/podcasts/${ep.id}/narration-manifest.json`;
  await db().storage.from("videos").upload(mpath, Buffer.from(JSON.stringify({ episodeId: ep.id, voiceIdHash: sha(Buffer.from(voiceId)).slice(0, 10), blocks: manifest })), { contentType: "application/json", upsert: true });
  const secs = (k: string) => Math.round((manifest as { kind: string; seconds: number }[]).filter((m) => !k || m.kind === k).reduce((a, m) => a + m.seconds, 0));
  log("NARRATION_DONE", { episode: ep.id.slice(0, 8), blocks: manifest.length, reusedBlocks: reused, newCharacters: paidChars, creditsHeldTotal: await elevenCreditsUsed(project), avatarSeconds: secs("A"), visualSeconds: secs("V"), totalSeconds: secs("") });
}

const modes: Record<string, () => Promise<void>> = { keygen, "verify-rate": verifyRate, inspect, "store-docs": storeDocs, narrate };
// Several $0 steps may be chained with commas; each runs only if the previous one succeeded.
(async () => {
  for (const mode of (process.argv[2] ?? "").split(",").filter(Boolean)) {
    if (!modes[mode]) throw Error(`unknown step ${mode}`);
    log("STEP", { mode });
    await modes[mode]();
  }
})().catch((e) => { console.error("STEP_FAILED", e instanceof Error ? e.message.slice(0, 200) : "error"); process.exitCode = 1; });
