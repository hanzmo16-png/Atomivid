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

const STUDIO_PROMPT = "Photorealistic interior of an elegant, modern, futuristic podcast studio with a space aesthetic, photographed for a high-end documentary series. " +
  "Behind the presenter area: a large curved panoramic window showing the soft blue limb of the Earth and a deep starfield with a faint nebula. " +
  "Dark graphite walls with thin, warm amber and cool blue LED accent lines, a few minimalist shelves with subtle objects (a small brass armillary sphere, books), " +
  "soft volumetric light. Main soft light comes from the left side of the frame, warm neutral, like a large window softbox; gentle cool fill on the right. " +
  "Shot at chest height with a 35mm lens, shallow depth of field, the background slightly out of focus, cinematic color grading, realistic materials. " +
  "The center of the frame is empty, reserved for a seated presenter. No people, no text, no logos, no watermarks, no screens with writing.";

/** Paid (images cap): studio plates through the paid-call gate, then the free composite. Reruns reuse stored plates. */
async function studio() {
  process.env.OPENAI_IMAGE_QUALITY = "high";
  // High quality 1536x1024 can take > 60 s; a client timeout leaves the charge uncertain (as on the first try).
  process.env.OPENAI_IMAGE_TIMEOUT_MS = "300000";
  const ep = await episodeRow();
  const project = `podcast-${ep.id}`;
  const { data: prior } = await db().from("pi_paid_operations").select("method,status,reserved_usd,committed_usd,created_at").eq("project_id", project).eq("provider", "openai");
  log("IMAGE_LEDGER_BEFORE", (prior ?? []).map((o) => ({ status: o.status, reserved: o.reserved_usd, committed: o.committed_usd, at: o.created_at })));
  const { openaiImageProvider } = await import("../../src/lib/providers/image/openai");
  const { guardPaidCall } = await import("../../src/lib/paid-calls/gate");
  const { supabaseLedgerStore } = await import("../../src/lib/paid-calls/supabase-ledger-store");
  const s = db().storage.from("videos");
  const prefix = `${ep.user_id}/podcasts/${ep.id}/studio`;
  const variants = [
    // Attempt 1 of plate 1 timed out client-side (charge uncertain, held at its reservation); this is attempt 2.
    { n: "1", attempt: 2, extra: " Color palette: deep navy and graphite with amber accents." },
    { n: "2", attempt: 1, extra: " Color palette: deep teal-blue and charcoal with soft violet and amber accents." },
  ];
  for (const v of variants) {
    const path = `${prefix}/plate-${v.n}.png`;
    let bytes: Buffer | null = null;
    const { data: existing } = await s.download(path);
    if (existing) bytes = Buffer.from(await existing.arrayBuffer());
    else {
      const spent = await imagesSpentUsd(project);
      if (spent + 0.4 > AUTH.imagesMaxUsd) throw Error(`images cap would be exceeded (spent ${spent.toFixed(2)}); stopped`);
      const g = await guardPaidCall<{ path: string }>(supabaseLedgerStore(db()), { projectId: project, shotId: `studio-plate-${v.n}${v.attempt > 1 ? `-attempt-${v.attempt}` : ""}`, provider: "openai", model: "gpt-image-2", method: "generate_image",
        inputFingerprint: { prompt: STUDIO_PROMPT + v.extra, aspectRatio: "16:9", quality: "high", ...(v.attempt > 1 ? { attempt: v.attempt } : {}) }, reservedUsd: 0.4 }, {
        call: async () => {
          const a = await openaiImageProvider.generateImage({ prompt: STUDIO_PROMPT + v.extra, aspectRatio: "16:9", maxCostUsd: 0.4, disableRetries: true });
          const up = await s.upload(path, a.buffer, { contentType: "image/png", upsert: false });
          if (up.error) throw Error("plate upload failed");
          return { result: { path }, costUsd: a.costUsd, resultRef: path };
        },
        load: async () => null,
        maxRejectedRetries: 0,
      });
      const { data } = await s.download(g.result.path);
      bytes = Buffer.from(await data!.arrayBuffer());
    }
    writeFileSync(`${WORK}/plate-${v.n}.png`, bytes);
    log("PLATE", { n: v.n, bytes: bytes.length, reused: !!existing });
  }
  const { data: cut } = await s.download(`${prefix}/cutout.png`);
  if (cut) writeFileSync(`${WORK}/cutout.png`, Buffer.from(await cut.arrayBuffer()));
  else {
    const { a } = await testRequest();
    const { data: photo } = await db().storage.from("avatar-uploads").download(a.source_photo_path);
    writeFileSync(`${WORK}/photo`, Buffer.from(await photo!.arrayBuffer()));
    writeFileSync(`${WORK}/test.mp4`, Buffer.alloc(0));
    execFileSync("python3", ["-c", "import sys;sys.argv=['x','x',sys.argv[1]];from pathlib import Path;import importlib.util as u;s=u.spec_from_file_location('m','scripts/podcast-episode/media.py');m=u.module_from_spec(s);s.loader.exec_module(m);from rembg import new_session,remove;from PIL import Image,ImageOps;im=ImageOps.exif_transpose(Image.open(Path(sys.argv[2])/'photo')).convert('RGB');remove(im,session=new_session('birefnet-portrait')).save(Path(sys.argv[2])/'cutout.png')", WORK], { stdio: "inherit" });
    await s.upload(`${prefix}/cutout.png`, readFileSync(`${WORK}/cutout.png`), { contentType: "image/png", upsert: true });
  }
  execFileSync("python3", ["scripts/podcast-episode/media.py", "composite", WORK], { stdio: "inherit" });
  for (const n of ["1", "2"]) {
    await s.upload(`${prefix}/composite-${n}.png`, readFileSync(`${WORK}/composite-${n}.png`), { contentType: "image/png", upsert: true });
    seal(`composite-${n}.jpg`, readFileSync(`${WORK}/out/composite-${n}.jpg`));
  }
  log("IMAGES_SPENT", { usd: Math.round((await imagesSpentUsd(project)) * 10000) / 10000, capUsd: AUTH.imagesMaxUsd });
}

async function imagesSpentUsd(project: string) {
  const { data, error } = await db().from("pi_paid_operations").select("status,reserved_usd,committed_usd").eq("project_id", project).eq("provider", "openai").neq("status", "REFUNDED");
  if (error || !data) throw Error("image ledger unavailable; nothing sent");
  return (data ?? []).reduce((a, o) => a + Number(o.status === "COMMITTED" ? o.committed_usd : o.reserved_usd), 0);
}

const EXTEND_PROMPT = "Outpaint only the transparent areas on the left and right. Continue the same man's navy blue blazer, shoulders, sleeves and arms naturally " +
  "beyond the original photo edges, resting in a relaxed seated posture, with the same fabric, color, soft daylight and camera perspective. " +
  "Continue the same softly blurred interior background. Do not alter the face, hair, beard, or anything inside the original photo area. Photorealistic.";

/** gpt-image edit (transparent bands = mask). Usage-based cost with the product's published token rates. */
async function openaiEdit(png: Buffer): Promise<{ buffer: Buffer; costUsd: number }> {
  const form = new FormData();
  form.append("model", process.env.OPENAI_IMAGE_MODEL || "gpt-image-2");
  form.append("prompt", EXTEND_PROMPT);
  form.append("size", "1024x1024");
  form.append("quality", "high");
  form.append("image", new Blob([new Uint8Array(png)], { type: "image/png" }), "extend-in.png");
  const r = await fetch("https://api.openai.com/v1/images/edits", { method: "POST", body: form, redirect: "error", signal: AbortSignal.timeout(300000), headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY!.trim()}` } });
  const j = await r.json().catch(() => null) as { data?: { b64_json?: string }[]; usage?: { input_tokens_details?: { text_tokens?: number; image_tokens?: number }; output_tokens?: number }; error?: { code?: string } } | null;
  if (!r.ok || !j?.data?.[0]?.b64_json) throw Error(`OpenAI edit HTTP ${r.status} code=${String(j?.error?.code ?? "").slice(0, 40)}`);
  const u = j.usage;
  const cost = u ? (u.input_tokens_details?.text_tokens ?? 0) * 5e-6 + (u.input_tokens_details?.image_tokens ?? 0) * 10e-6 + (u.output_tokens ?? 0) * 40e-6 : 0.4;
  return { buffer: Buffer.from(j.data[0].b64_json, "base64"), costUsd: Math.round(cost * 10000) / 10000 };
}

/** Paid (images cap): extend the jacket beyond the photo borders; the original pixels are restored on top. */
async function extend() {
  const ep = await episodeRow();
  const project = `podcast-${ep.id}`;
  const s = db().storage.from("videos");
  const prefix = `${ep.user_id}/podcasts/${ep.id}/studio`;
  const { a } = await testRequest();
  const { data: photo } = await db().storage.from("avatar-uploads").download(a.source_photo_path);
  writeFileSync(`${WORK}/photo`, Buffer.from(await photo!.arrayBuffer()));
  mkdirSync(`${WORK}/out`, { recursive: true });
  execFileSync("python3", ["scripts/podcast-episode/media.py", "extend-prep", WORK], { stdio: "inherit" });
  const outPath = `${prefix}/extend-out.png`;
  const { data: existing } = await s.download(outPath);
  let gen: Buffer;
  if (existing) gen = Buffer.from(await existing.arrayBuffer());
  else {
    const spent = await imagesSpentUsd(project);
    if (spent + 0.4 > AUTH.imagesMaxUsd) throw Error(`images cap would be exceeded (spent ${spent.toFixed(2)}); stopped`);
    const { guardPaidCall } = await import("../../src/lib/paid-calls/gate");
    const { supabaseLedgerStore } = await import("../../src/lib/paid-calls/supabase-ledger-store");
    const input = readFileSync(`${WORK}/extend-in.png`);
    const g = await guardPaidCall<{ path: string }>(supabaseLedgerStore(db()), { projectId: project, shotId: "presenter-extend-1", provider: "openai", model: "gpt-image-2", method: "edit_image",
      inputFingerprint: { prompt: EXTEND_PROMPT, inputSha: sha(input), size: "1024x1024", quality: "high" }, reservedUsd: 0.4 }, {
      call: async () => {
        const e = await openaiEdit(input);
        const up = await s.upload(outPath, e.buffer, { contentType: "image/png", upsert: false });
        if (up.error) throw Error("edit upload failed");
        return { result: { path: outPath }, costUsd: e.costUsd, resultRef: outPath };
      },
      load: async () => null,
      maxRejectedRetries: 0,
    });
    gen = Buffer.from(await (await s.download(g.result.path)).data!.arrayBuffer());
  }
  writeFileSync(`${WORK}/extend-out.png`, gen);
  execFileSync("python3", ["scripts/podcast-episode/media.py", "extend-merge", WORK], { stdio: "inherit" });
  await s.upload(`${prefix}/cutout-wide.png`, readFileSync(`${WORK}/cutout-wide.png`), { contentType: "image/png", upsert: true });
  seal("extended.jpg", readFileSync(`${WORK}/out/extended.jpg`));
  for (const n of ["1", "2"]) writeFileSync(`${WORK}/plate-${n}.png`, Buffer.from(await (await s.download(`${prefix}/plate-${n}.png`)).data!.arrayBuffer()));
  execFileSync("python3", ["scripts/podcast-episode/media.py", "composite", WORK], { stdio: "inherit" });
  for (const n of ["1", "2"]) {
    await s.upload(`${prefix}/composite-wide-${n}.png`, readFileSync(`${WORK}/composite-${n}.png`), { contentType: "image/png", upsert: true });
    seal(`composite-wide-${n}.jpg`, readFileSync(`${WORK}/out/composite-${n}.jpg`));
  }
  log("IMAGES_SPENT", { usd: Math.round((await imagesSpentUsd(project)) * 10000) / 10000, capUsd: AUTH.imagesMaxUsd });
}

/** Avatar segments: which A blocks go in each HeyGen call (in episode order), and at what resolution. */
const SEGMENTS: Record<string, { blocks: string[]; resolution: "720p" | "1080p"; worstUsdPerSec: number }> = {
  // 1080p rate probe on a real block of the episode (a12, ~15 s). Worst published figure: USD 4/min.
  probe: { blocks: ["a12"], resolution: "1080p", worstUsdPerSec: 4 / 60 },
  // Measured on the approved probe: USD 0.59 / 15.44 s, consistent with USD 2.31/min.
  "batch-1": { blocks: ["a01", "a02", "a03", "a03b", "a04", "a05"], resolution: "1080p", worstUsdPerSec: 2.31 / 60 },
  "batch-2": { blocks: ["a06", "a07", "a08b", "a08"], resolution: "1080p", worstUsdPerSec: 2.31 / 60 },
  "batch-3": { blocks: ["a09", "a09b", "a10", "a14", "a15"], resolution: "1080p", worstUsdPerSec: 2.31 / 60 },
};
const PAD_S = 0.3;

async function heygenApi(path: string, init: RequestInit = {}) {
  const r = await fetch("https://api.heygen.com" + path, { ...init, redirect: "error", signal: AbortSignal.timeout(120000),
    headers: { "X-Api-Key": process.env.HEYGEN_API_KEY!.trim(), ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...init.headers } });
  const j = await r.json().catch(() => null) as { data?: Record<string, any>; error?: { code?: string } } | null;
  if (!r.ok || !j?.data) throw Error(`HeyGen HTTP ${r.status} code=${String(j?.error?.code ?? "").replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 40)}`);
  return j.data;
}
const wallet = async () => { const d = await heygenApi("/v3/users/me"); if (d.wallet?.currency !== "usd") throw Error("wallet not usd"); return Number(d.wallet.remaining_balance); };
async function heygenUpload(bytes: Buffer, mime: string, name: string) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), name);
  const d = await heygenApi("/v3/assets", { method: "POST", body: form });
  const id = d.asset_id ?? d.id;
  if (typeof id !== "string") throw Error("no asset id");
  return id as string;
}
async function heygenSpentUsd(project: string) {
  const { data, error } = await db().from("pi_paid_operations").select("status,reserved_usd,committed_usd").eq("project_id", project).eq("provider", "heygen").neq("status", "REFUNDED");
  if (error || !data) throw Error("HeyGen ledger unavailable; nothing sent");
  return (data ?? []).reduce((a, o) => a + Number(o.status === "COMMITTED" ? o.committed_usd : o.reserved_usd), 0);
}

/**
 * Paid (HeyGen cap): one avatar segment = the segment's blocks joined with short silences, animated on the
 * approved composite. The provider job id is stored privately BEFORE waiting, so an interrupted run recovers
 * the same video instead of paying for another. Wallet must cover the worst case before submitting.
 */
async function avatarSegment(segId: string) {
  const seg = SEGMENTS[segId];
  if (!seg) throw Error(`unknown segment ${segId}`);
  const ep = await episodeRow();
  const project = `podcast-${ep.id}`;
  const s = db().storage.from("videos");
  const prefix = `${ep.user_id}/podcasts/${ep.id}`;
  const recPath = `${prefix}/avatar/${segId}.json`;
  const manifest = JSON.parse(Buffer.from(await (await s.download(`${prefix}/narration-manifest.json`)).data!.arrayBuffer()).toString("utf8")) as { blocks: { id: string; kind: string; seconds: number; audioPath: string }[] };
  const blocks = seg.blocks.map((id) => { const b = manifest.blocks.find((x) => x.id === id); if (!b || b.kind !== "A") throw Error(`block ${id} missing or not avatar`); return b; });
  // Segment audio: pad + block + pad ..., timings recorded for the cut.
  const parts: string[] = [];
  const timeline: { id: string; start: number; end: number }[] = [];
  let t = 0;
  for (const b of blocks) {
    const f = `${WORK}/${b.id}.mp3`;
    writeFileSync(f, Buffer.from(await (await s.download(b.audioPath)).data!.arrayBuffer()));
    const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim());
    parts.push(f);
    timeline.push({ id: b.id, start: t + PAD_S, end: t + PAD_S + dur });
    t += dur + 2 * PAD_S;
  }
  const filter = parts.map((_, i) => `[${i}:a]aresample=44100,aformat=channel_layouts=mono,adelay=${PAD_S * 1000},apad=pad_dur=${PAD_S}[a${i}]`).join(";") + ";" + parts.map((_, i) => `[a${i}]`).join("") + `concat=n=${parts.length}:v=0:a=1[out]`;
  execFileSync("ffmpeg", ["-v", "error", "-y", ...parts.flatMap((p) => ["-i", p]), "-filter_complex", filter, "-map", "[out]", "-c:a", "pcm_s16le", `${WORK}/${segId}.wav`]);
  const wav = readFileSync(`${WORK}/${segId}.wav`);
  const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `${WORK}/${segId}.wav`]).toString().trim());
  const worst = Math.ceil(seconds * seg.worstUsdPerSec * 100) / 100;
  const { data: recBlob } = await s.download(recPath);
  const rec = recBlob ? JSON.parse(Buffer.from(await recBlob.arrayBuffer()).toString("utf8")) as Record<string, any> : null;
  let ledgerKey: string | undefined = rec?.ledgerKey;
  log("SEGMENT_PLAN", { seg: segId, blocks: seg.blocks, seconds: Math.round(seconds * 10) / 10, resolution: seg.resolution, worstCaseUsd: worst, recorded: !!rec?.jobId });

  // Wait for the render, download it, and measure the wallet charge (polled until it moves, up to 3 min).
  const finish = async (jobId: string, walletBefore: number | null) => {
    const deadline = Date.now() + 100 * 60_000;
    let d: Record<string, any> = {};
    while (Date.now() < deadline) {
      d = await heygenApi(`/v3/videos/${encodeURIComponent(jobId)}`);
      if (d.status === "completed" || d.status === "failed" || d.status === "cancelled") break;
      await new Promise((r) => setTimeout(r, 20000));
    }
    if (d.status !== "completed" || typeof d.video_url !== "string") throw Error(`segment ${segId} status=${String(d.status).slice(0, 20)} code=${String(d.failure_code ?? "").slice(0, 30)}`);
    const vr = await fetch(d.video_url, { signal: AbortSignal.timeout(300000), redirect: "error" });
    if (!vr.ok) throw Error("provider video download failed");
    const video = Buffer.from(await vr.arrayBuffer());
    // Preserve the source bytes. Parts stay below the storage per-object limit.
    const storageParts: string[] = [];
    const chunkSize = 32 * 1024 * 1024;
    for (let offset = 0; offset < video.length; offset += chunkSize) {
      const n = storageParts.length;
      const path = video.length <= chunkSize ? `${prefix}/avatar/${segId}.mp4` : `${prefix}/avatar/${segId}.part-${n}`;
      const up = await s.upload(path, video.subarray(offset, offset + chunkSize), { contentType: "application/octet-stream", upsert: true });
      if (up.error) throw Error("segment video part upload failed");
      storageParts.push(path);
    }
    writeFileSync(`${WORK}/${segId}.mp4`, video);
    let walletAfter = await wallet();
    for (let i = 0; i < 9 && walletBefore !== null && walletAfter === walletBefore; i++) { await new Promise((r) => setTimeout(r, 20000)); walletAfter = await wallet(); }
    const charged = walletBefore !== null ? Math.round((walletBefore - walletAfter) * 100) / 100 : null;
    const saved = await s.upload(recPath, Buffer.from(JSON.stringify({ ...(rec ?? {}), jobId, ledgerKey, walletBefore, walletAfter, seconds, timeline, storageParts, videoSha256: sha(video), resolution: seg.resolution, chargedUsd: charged, completedAt: new Date().toISOString() })), { contentType: "application/json", upsert: true });
    if (saved.error) throw Error("completed segment record could not be saved");
    return { walletAfter, charged };
  };

  let jobId: string | undefined = rec?.jobId;
  let walletBefore: number | null = rec?.walletBefore ?? null;
  let outcome: { walletAfter: number; charged: number | null };
  if (jobId) {
    // Recovery of an already submitted segment: no new submission, no new charge.
    if (rec?.completedAt) {
      const buffers: Buffer[] = [];
      for (const path of rec.storageParts ?? [`${prefix}/avatar/${segId}.mp4`]) {
        const { data, error } = await s.download(path);
        if (error || !data) throw Error("stored paid segment missing; no regeneration");
        buffers.push(Buffer.from(await data.arrayBuffer()));
      }
      const bytes = Buffer.concat(buffers);
      if (rec.videoSha256 && sha(bytes) !== rec.videoSha256) throw Error("stored segment hash mismatch");
      writeFileSync(`${WORK}/${segId}.mp4`, bytes);
      outcome = { walletAfter: rec.walletAfter ?? walletBefore! - rec.chargedUsd, charged: rec.chargedUsd };
    } else {
      outcome = await finish(jobId, walletBefore);
    }
    if (ledgerKey) {
      const { commitRecordedPaidJob } = await import("../../src/lib/paid-calls/gate");
      const { supabaseLedgerStore } = await import("../../src/lib/paid-calls/supabase-ledger-store");
      await commitRecordedPaidJob(supabaseLedgerStore(db()), ledgerKey, { costUsd: outcome.charged !== null && outcome.charged > 0 ? outcome.charged : worst, resultRef: `avatar-job:${jobId}` });
    }
  } else {
    const spent = await heygenSpentUsd(project);
    if (spent + worst > AUTH.heygenMaxUsd) throw Error(`HeyGen cap would be exceeded (spent ${spent.toFixed(2)} + ${worst}); nothing sent`);
    walletBefore = await wallet();
    if (walletBefore < worst) throw Error(`wallet ${walletBefore.toFixed(2)} cannot complete this segment (needs up to ${worst}); nothing sent`);
    log("HEYGEN_PRECHECK", { spentUsd: Math.round(spent * 100) / 100, worstCaseUsd: worst, walletCovers: true });
    const imageId = await heygenUpload(readFileSync(`${WORK}/composite.png`), "image/png", "composite.png");
    const audioId = await heygenUpload(wav, "audio/wav", "segment.wav");
    const { guardPaidCall } = await import("../../src/lib/paid-calls/gate");
    const { supabaseLedgerStore } = await import("../../src/lib/paid-calls/supabase-ledger-store");
    let accepted: string | undefined;
    const g = await guardPaidCall<{ jobId: string; walletAfter: number; charged: number | null }>(supabaseLedgerStore(db()), { projectId: project, shotId: `avatar:${segId}`, provider: "heygen", model: "avatar-iv-photo", method: "generate_video",
      inputFingerprint: { seg: segId, blocks: seg.blocks, audioSha: sha(wav), imageSha: sha(readFileSync(`${WORK}/composite.png`)), resolution: seg.resolution }, reservedUsd: worst }, {
      call: async ({ key }) => {
        ledgerKey = key;
        const d = await heygenApi("/v3/videos", { method: "POST", body: JSON.stringify({ type: "image", image: { type: "asset_id", asset_id: imageId }, audio_asset_id: audioId, aspect_ratio: "16:9", resolution: seg.resolution }) });
        if (typeof d.video_id !== "string") throw Error("no video_id; do not resubmit");
        accepted = d.video_id;
        const up = await s.upload(recPath, Buffer.from(JSON.stringify({ jobId: d.video_id, ledgerKey, walletBefore, seconds, timeline, resolution: seg.resolution, submittedAt: new Date().toISOString() })), { contentType: "application/json", upsert: true });
        if (up.error) throw Error("job id not stored; do not resubmit");
        const o = await finish(d.video_id, walletBefore);
        // The ledger commits the measured wallet charge; the worst case only if the wallet has not moved yet.
        return { result: { jobId: d.video_id, ...o }, costUsd: o.charged !== null && o.charged > 0 ? o.charged : worst, resultRef: `avatar-job:${d.video_id}`, providerJobId: d.video_id };
      },
      load: async () => null,
      classify: () => (accepted ? { kind: "accepted", providerJobId: accepted } : { kind: "uncertain" }),
      maxRejectedRetries: 0,
    });
    jobId = g.result.jobId;
    outcome = { walletAfter: g.result.walletAfter, charged: g.result.charged };
  }
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate", "-of", "json", `${WORK}/${segId}.mp4`]).toString());
  const v = probe.streams.find((x: any) => x.codec_type === "video");
  const perMin = outcome.charged !== null ? Math.round((outcome.charged / seconds) * 60 * 1000) / 1000 : null;
  log("SEGMENT_DONE", { seg: segId, videoSeconds: Math.round(Number(probe.format.duration) * 10) / 10, width: v?.width, height: v?.height, fps: v?.r_frame_rate, audioSeconds: Math.round(seconds * 10) / 10, chargedUsd: outcome.charged, usdPerMinute: perMin });
  execFileSync("python3", ["-c", `import sys;sys.path.insert(0,'scripts/podcast-episode');import media;from pathlib import Path;w=Path('${WORK}');(w/'out').mkdir(exist_ok=True);media.sheet(media.frames(w/'${segId}.mp4',w/'out',8,480),4).save(w/'out'/'${segId}-frames.jpg',quality=86)`], { stdio: "inherit" });
  seal(`${segId}-frames.jpg`, readFileSync(`${WORK}/out/${segId}-frames.jpg`));
  sealed_json(`${segId}-heygen.json`, { walletBefore, walletAfter: outcome.walletAfter, charged: outcome.charged, perMin, seconds });
  const source = readFileSync(`${WORK}/${segId}.mp4`);
  for (let offset = 0, n = 0; offset < source.length; offset += 32 * 1024 * 1024, n++)
    sealOwner(`${segId}-part-${n}.bin`, source.subarray(offset, offset + 32 * 1024 * 1024));
  sealOwner(`${segId}-record.json`, Buffer.from(JSON.stringify({ segId, seconds, timeline, videoSha256: sha(source), chargedUsd: outcome.charged, width: v?.width, height: v?.height })));
  if (!Number.isFinite(outcome.charged) || outcome.charged! <= 0 || outcome.charged! > worst)
    throw Error("charge requires reconciliation before the next paid segment");
}
function sealed_json(name: string, v: unknown) { seal(name, Buffer.from(JSON.stringify(v))); }

/** Avatar step: "avatar:<segment>" — loads the chosen composite (studio plate 2) first. */
async function avatarStep(segId: string) {
  // Operator workflow is a production caller too: enforce existing daily/monthly/concurrency limits.
  process.env.SUPPLY_GUARD_ENFORCED = "true";
  const ep = await episodeRow();
  const { data } = await db().storage.from("videos").download(`${ep.user_id}/podcasts/${ep.id}/studio/composite-wide-2.png`);
  if (!data) throw Error("composite missing");
  writeFileSync(`${WORK}/composite.png`, Buffer.from(await data.arrayBuffer()));
  await avatarSegment(segId);
}


/** Read-only export of the existing paid probe to the requesting owner's session. No provider calls. */
async function exportProbe() {
  const { r } = await testRequest();
  const { data: ep, error } = await db().from("podcast_episodes").select("id,user_id")
    .eq("user_id", r.user_id).eq("title", EPISODE_TITLE).single();
  if (error || !ep) throw Error("existing episode missing");
  const { data: video, error: downloadError } = await db().storage.from("videos")
    .download(`${ep.user_id}/podcasts/${ep.id}/avatar/probe.mp4`);
  if (downloadError || !video) throw Error("existing probe missing");
  const bytes = Buffer.from(await video.arrayBuffer());
  const key = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const encryptedKey = publicEncrypt({ key: "-----BEGIN PUBLIC KEY-----\nMIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAuMOMunpUAccUO6WKqZ1W\n5W5wXLHDeJ8VY3CWdjr/HgmBM2xnjua/reRysYUHbRlo7+XFlwAQ5YglnnO2JnlN\nVUEnpqx994fWm0LitTYNsAYwHIN6sDWe12VcGrT9aLZU2KYCyJjbKVHJUOPPowoZ\nCMwHVt/KOxF5yMCEfzL0yK9qHk3NWxkejq4RepXwUk8H1w5VIh7yq99M66XQ3vk2\nZ4kbLreO1+CZKkyFv8UTA+2fO3A4beh1+bVwBjWw2nrchUtu//6e9qIzLpnTF9yl\ndegjvnZJy4uCujWn27geiFZfdXWKFQZ46tHDGmuQJCtsAe9LLLnjgPOwjAlixXjS\nQ3fYk3OVpU3ojEIh4BWmlX4KyecKprhn4JO5fVdbzZTYcE3RIATGOyeoBRAEM6ZR\nJ1+tmM5K5Yrc8WJM4PjNbZwBZa5413k6B/xBBOQLGnFOUhPrQ0CURtSM+IB9N/4s\n38My+ZqIBJY62fq7l53Jit8UNZoiy4GUs7lWaXgKBetVAgMBAAE=\n-----END PUBLIC KEY-----\n", padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  writeFileSync("sealed-out/probe-video.mp4.sealed", [encryptedKey, iv, cipher.getAuthTag(), encrypted].map(b => b.toString("base64")).join("."));
  log("PROBE_EXPORTED", { bytes: bytes.length, sha256: sha(bytes), providerCalls: 0 });
}


/** Existing production assets and balances, read-only; encrypted for the owner. */
function sealOwner(name: string, bytes: Buffer) {
  if (!/^[a-z0-9-]+\.[a-z0-9]+$/.test(name)) throw Error("bad export name");
  const key = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const ek = publicEncrypt({ key: "-----BEGIN PUBLIC KEY-----\nMIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAuMOMunpUAccUO6WKqZ1W\n5W5wXLHDeJ8VY3CWdjr/HgmBM2xnjua/reRysYUHbRlo7+XFlwAQ5YglnnO2JnlN\nVUEnpqx994fWm0LitTYNsAYwHIN6sDWe12VcGrT9aLZU2KYCyJjbKVHJUOPPowoZ\nCMwHVt/KOxF5yMCEfzL0yK9qHk3NWxkejq4RepXwUk8H1w5VIh7yq99M66XQ3vk2\nZ4kbLreO1+CZKkyFv8UTA+2fO3A4beh1+bVwBjWw2nrchUtu//6e9qIzLpnTF9yl\ndegjvnZJy4uCujWn27geiFZfdXWKFQZ46tHDGmuQJCtsAe9LLLnjgPOwjAlixXjS\nQ3fYk3OVpU3ojEIh4BWmlX4KyecKprhn4JO5fVdbzZTYcE3RIATGOyeoBRAEM6ZR\nJ1+tmM5K5Yrc8WJM4PjNbZwBZa5413k6B/xBBOQLGnFOUhPrQ0CURtSM+IB9N/4s\n38My+ZqIBJY62fq7l53Jit8UNZoiy4GUs7lWaXgKBetVAgMBAAE=\n-----END PUBLIC KEY-----\n", padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  writeFileSync(`sealed-out/${name}.sealed`, [ek, iv, cipher.getAuthTag(), ct].map(b => b.toString("base64")).join("."));
}
async function exportProduction() {
  const { r } = await testRequest();
  const { data: ep, error } = await db().from("podcast_episodes").select("id,user_id").eq("user_id", r.user_id).eq("title", EPISODE_TITLE).single();
  if (error || !ep) throw Error("existing episode missing");
  const s = db().storage.from("videos");
  const prefix = `${ep.user_id}/podcasts/${ep.id}`;
  const get = async (path: string) => {
    const { data, error } = await s.download(path);
    if (error || !data) throw Error("asset download failed");
    return Buffer.from(await data.arrayBuffer());
  };
  const manifestBytes = await get(prefix + "/narration-manifest.json");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  sealOwner("manifest.json", manifestBytes);
  const balance = await wallet();
  const spent = await heygenSpentUsd("podcast-" + ep.id);
  const images = await imagesSpentUsd("podcast-" + ep.id);
  sealOwner("production-state.json", Buffer.from(JSON.stringify({ episodeId: ep.id, userId: ep.user_id, balance, spent, images })));
  log("PRODUCTION_INVENTORY", { balance, spent, images, blocks: manifest.blocks.map((b: any) => ({ id: b.id, kind: b.kind, seconds: b.seconds })), providerCalls: 0 });
  for (const name of ["guion.md", "plan-y-presupuesto.md"])
    sealOwner(name, await get(`${ep.user_id}/podcasts/episodio-01/${name}`));
  for (const b of manifest.blocks) {
    if (!/^[av][a-z0-9]+$/.test(b.id)) throw Error("invalid block id");
    sealOwner("audio-" + b.id + ".mp3", await get(b.audioPath));
  }
  sealOwner("studio.png", await get(prefix + "/studio/composite-wide-2.png"));
}


/** Conceptual illustrations are always labelled as such in the edit, never presented as archival evidence. */
async function visualAssets() {
  process.env.SUPPLY_GUARD_ENFORCED = "true";
  process.env.OPENAI_IMAGE_TIMEOUT_MS = "300000";
  process.env.OPENAI_IMAGE_QUALITY = "medium";
  process.env.OPENAI_IMAGE_ESTIMATED_COST_USD = "0.12";
  const ep = await episodeRow(), project = "podcast-" + ep.id;
  const s = db().storage.from("videos"), prefix = `${ep.user_id}/podcasts/${ep.id}/visuals`;
  const { openaiImageProvider } = await import("../../src/lib/providers/image/openai");
  const { guardPaidCall } = await import("../../src/lib/paid-calls/gate");
  const { supabaseLedgerStore } = await import("../../src/lib/paid-calls/supabase-ledger-store");
  const common = "Cinematic documentary conceptual illustration, panoramic landscape composition, premium photographic realism, restrained deep navy and warm amber palette, delicate volumetric light, natural detailed textures. No text, no logos, no labels. Main subject clearly legible, full scene, avoid collages. ";
  const shots = [
    ["neuron", "Macro view of a branching neuron with delicate dendrites and tiny glowing synaptic connections, scientific visualization, dimensional depth, dark background."],
    ["bat", "A single anatomically realistic small insectivorous bat in side profile flying through a limestone cave at dusk, natural wings, softly lit stone walls."],
    ["theatre", "Empty elegant theatre viewed from the back of the auditorium, a single warm spotlight on the central stage, surrounding darkness, metaphor for conscious attention."],
    ["laboratory", "Modern neuroscience laboratory with a magnetic resonance scanner visible through a glass observation wall, no people, no brand logos, realistic clinical equipment."],
    ["flower", "Extreme macro of a yellow flower with a small honeybee approaching its center, natural daylight, detailed pollen and petals, accurate insect anatomy."],
    ["eye", "Close side profile of an anonymous adult's eye looking through a rain covered window at a soft blue city, realistic skin and iris, contemplative intimate scene."],
    ["circuits", "Extreme macro photograph of intricate copper traces on a dark blue circuit board, tiny electrical components, side lighting, shallow but controlled depth of field."],
    ["cave", "Philosophical illustration of Plato's allegory: a wide stone cave, three seated human silhouettes in the foreground facing a wall, a small fire behind them casts large shadows on the wall, clearly understandable lighting geometry."],
    ["desert", "Wide New Mexico desert landscape at night with low mesas and a brilliant Milky Way arch, dark foreground, realistic astronomy photography aesthetic, no spacecraft."],
    ["radio", "Large parabolic radio telescope dish seen from below at blue hour in a quiet desert, distant dishes and stars, realistic engineering."],
    ["archive", "Historically inspired 1950s researcher's desk with a closed notebook, slide rule and telescope diagram without readable text, amber desk lamp, no claim of actual archival photography."],
    ["swans", "Three white swans and a single black swan swimming calmly on a dark reflective lake at dawn, accurate long neck anatomy, all four birds distinct and fully visible."],
    ["threshold", "An ordinary empty corridor ending in a translucent curved geometric surface of blue light, restrained speculative physics conceptual illustration, no creatures, no spacecraft."],
    ["microtubule", "Scientific conceptual visualization of a hollow cylindrical microtubule built from many small blue and gold protein units, cutaway view, dark background, molecule-scale representation."]
  ];
  for (const [id, detail] of shots) {
    const path = `${prefix}/${id}.png`, prompt = common + detail;
    const prior = await s.download(path);
    let bytes: Buffer;
    if (prior.data) bytes = Buffer.from(await prior.data.arrayBuffer());
    else {
      if (await imagesSpentUsd(project) + 0.12 > AUTH.imagesMaxUsd) throw Error("illustration image cap reached; no further calls");
      const result = await guardPaidCall<{ path: string }>(supabaseLedgerStore(db()), {
        projectId: project, shotId: "episode-visual-" + id, provider: "openai", model: "gpt-image-2", method: "generate_image",
        inputFingerprint: { prompt, quality: "medium", aspectRatio: "16:9" }, reservedUsd: 0.12
      }, {
        call: async () => {
          const image = await openaiImageProvider.generateImage({ prompt, aspectRatio: "16:9", maxCostUsd: 0.12, disableRetries: true });
          const up = await s.upload(path, image.buffer, { contentType: "image/png", upsert: false });
          if (up.error) throw Error("illustration upload failed");
          return { result: { path }, costUsd: image.costUsd, resultRef: path };
        },
        load: async () => ({ path }), maxRejectedRetries: 0
      });
      const stored = await s.download(result.result.path);
      if (!stored.data) throw Error("paid illustration missing");
      bytes = Buffer.from(await stored.data.arrayBuffer());
    }
    sealOwner("visual-" + id + ".png", bytes);
    log("ILLUSTRATION_SAVED", { id, reused: !!prior.data, spent: await imagesSpentUsd(project), cap: AUTH.imagesMaxUsd });
  }
}
async function releaseUnsubmittedRecut() {
  // The daily supply gate rejected this reservation BEFORE submission. Release only
  // this exact, unused hold via the normal ledger CAS; never alter paid operations.
  const { supabaseLedgerStore } = await import("../../src/lib/paid-calls/supabase-ledger-store");
  const ledger = supabaseLedgerStore(db());
  const key = "op_3184ad7171c474b4770eb0a65d6f1559";
  const op = await ledger.get(key);
  if (!op || op.projectId !== "podcast-84b2c44a-8463-4ebc-8b7d-0335df2cd5b2" || op.shotId !== "avatar:batch-3" || op.provider !== "heygen") throw Error("recut reservation mismatch");
  const reason = "cancelled-before-submission:editorial-recut-a11-to-visual";
  if (op.status === "REFUNDED" && op.resultRef === reason && op.committedUsd === 0) return;
  if (op.status !== "RESERVED" || op.providerJobId || op.resultRef || op.committedUsd !== null) throw Error("reservation may have been submitted; reconcile first");
  const ep = await episodeRow();
  const { data, error } = await db().storage.from("videos").list(`${ep.user_id}/podcasts/${ep.id}/avatar`, { search: "batch-3.json" });
  if (error || !data || data.some(x => x.name === "batch-3.json")) throw Error("recorded job check failed; reservation unchanged");
  if (!await ledger.update(key, "RESERVED", { status: "REFUNDED", committedUsd: 0, resultRef: reason, updatedAt: new Date().toISOString() })) throw Error("reservation changed concurrently");
  log("UNSUBMITTED_RESERVATION_RELEASED", { key, releasedUsd: op.reservedUsd, providerCharge: 0, visualBlock: "a11" });
}

async function archiveAssets() {
  const list = [
    { id: "pale-blue-dot", url: "https://assets.science.nasa.gov/dynamicimage/assets/science/psd/photojournal/pia/pia23/pia23645/PIA23645.jpg?crop=faces%2Cfocalpoint&fit=clip&h=5175&w=5230", source: "https://science.nasa.gov/resource/voyager-pale-blue-dot-download/", credit: "NASA/JPL-Caltech", license: "NASA media usage guidelines" },
    { id: "westerlund", url: "https://cdn.esahubble.org/archives/images/publicationjpg/heic1509a.jpg", source: "https://esahubble.org/images/heic1509a/", credit: "NASA, ESA, the Hubble Heritage Team (STScI/AURA), A. Nota (ESA/STScI), and the Westerlund 2 Science Team", license: "CC BY 4.0; https://esahubble.org/copyright/" }
  ];
  const manifest = [];
  for (const item of list) {
    const r = await fetch(item.url, { signal: AbortSignal.timeout(90000), redirect: "follow" });
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("image")) throw Error("archive download failed: " + item.id);
    const b = Buffer.from(await r.arrayBuffer());
    sealOwner("archive-" + item.id + ".jpg", b);
    manifest.push({ ...item, sha256: sha(b) });
  }
  sealOwner("archive-credits.json", Buffer.from(JSON.stringify(manifest)));
  log("ARCHIVE_SAVED", { count: manifest.length, paidCalls: 0 });
}

const modes: Record<string, () => Promise<void>> = { "archive-assets": archiveAssets, "visual-assets": visualAssets, "export-production": exportProduction, "export-probe": exportProbe, keygen, "verify-rate": verifyRate, inspect, "store-docs": storeDocs, narrate, studio, extend };
// Several $0 steps may be chained with commas; each runs only if the previous one succeeded.
(async () => {
  for (const mode of (process.argv[2] ?? "").split(",").filter(Boolean)) {
    log("STEP", { mode });
    if (mode === "recut-final") { await releaseUnsubmittedRecut(); continue; }
    if (mode.startsWith("avatar:")) { await avatarStep(mode.slice(7)); continue; }
    if (!modes[mode]) throw Error(`unknown step ${mode}`);
    await modes[mode]();
  }
})().catch((e) => { console.error("STEP_FAILED", e instanceof Error ? e.message.slice(0, 200) : "error"); process.exitCode = 1; });

