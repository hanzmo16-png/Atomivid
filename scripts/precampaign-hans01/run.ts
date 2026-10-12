/**
 * T-20261012-0648-hans-01 — precampaign voice + two avatar clips, authorised directly by Hans (≤ USD 1.20 total).
 *
 * MODE=check     USD 0: verifies the cloned voice row, the approved avatar photo (private thumbnail for review),
 *                ElevenLabs plan/credits, HeyGen wallet and Drive write access. No generation.
 * MODE=generate  only with APPROVED_PHOTO_SHA256 (the photo Claude reviewed in `check`):
 *                1) full narration with Hans's cloned ElevenLabs voice (one paid call, ledger-guarded);
 *                2) opening/closing lines cut from THAT audio at word timestamps (lip-sync uses the same samples);
 *                3) budget recomputed from the real cut durations BEFORE any HeyGen call; stop if > cap;
 *                4) two HeyGen Avatar IV photo clips, 720p, each ledger-guarded (never resubmitted after an
 *                   uncertain outcome: the ledger turns it into RECONCILIATION_REQUIRED and the run stops);
 *                5) real cost from wallet/credit deltas; files uploaded to Drive «Entregas» and verified by md5.
 * Never prints secrets, provider voice ids or signed URLs. Never publishes anything.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const sh = promisify(execFile);
const MODE = process.env.MODE;
const OUT = resolve(process.env.OUT_DIR ?? "hans01-output");
const PROJECT = "precampaign-hans01-20261012";
const VOICE_ROW = "2485ab5a-4975-4e9a-a6dd-30f6723d99b2";
const AVATAR_ROW = "245a8a51-a699-4f69-a387-7c11246a0b7f";
const CAP_USD = 1.2;
const ENTREGAS = "1z8C1ZnE8rh9iUUiEYQrNU-x7VMzCI4SJ";
const PREFIX = "T-20261012-0648-hans-01__claude__";
const TEXT = "¿Tienes buenas ideas, pero hacer un video te toma demasiado tiempo? Estamos preparando Atomivid para ayudarte a convertir esas ideas en contenido. Guion, voz, imágenes, subtítulos y la opción de presentar con tu propio avatar. Mira algunos resultados de nuestras pruebas. Estamos afinando la experiencia para que tú también puedas crear. ¿Quieres enterarte del lanzamiento? Síguenos. Atomivid. Tu idea. Tu video. Próximamente.";
const OPENING_LAST = "tiempo?";
const CLOSING_FIRST = "¿Quieres", CLOSING_LAST = "Síguenos.";
// Conservative planning rates (USD). Real cost is measured from the HeyGen wallet and ElevenLabs credit deltas.
const ELEVEN_USD_PER_CHAR_MAX = 0.0003;
const HEYGEN_USD_PER_SECOND_MAX = 0.05;

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const md5 = (b: Buffer) => createHash("md5").update(b).digest("hex");
const r4 = (x: number) => Math.round(x * 10000) / 10000;
const report: Record<string, unknown> = { request: "T-20261012-0648-hans-01", mode: MODE, project: PROJECT, capUsd: CAP_USD, startedAt: new Date().toISOString() };
const save = () => writeFile(join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n");

function service(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}

async function probeSeconds(file: string) {
  const { stdout } = await sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Number(stdout.trim());
}

// ---------- providers (read-only calls are free) ----------
async function eleven(path: string) {
  const res = await fetch(`https://api.elevenlabs.io${path}`, { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`elevenlabs_get_${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}
async function elevenCredits() {
  const s = await eleven("/v1/user/subscription");
  return { tier: s.tier, used: Number(s.character_count), limit: Number(s.character_limit), resetUnix: s.next_character_count_reset_unix ?? null };
}

// ---------- Drive (Hans's OAuth refresh token, scope drive) ----------
async function driveToken() {
  const body = new URLSearchParams({ client_id: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "", client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "", refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN ?? "", grant_type: "refresh_token" });
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`drive_token_${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}
async function driveList(token: string, name?: string) {
  const q = encodeURIComponent(`'${ENTREGAS}' in parents and trashed = false${name ? ` and name = '${name}'` : ""}`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,size,md5Checksum,parents,createdTime)&pageSize=10`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`drive_list_${res.status}`);
  return ((await res.json()) as { files: { id: string; name: string; size?: string; md5Checksum?: string; parents?: string[]; createdTime: string }[] }).files;
}
async function driveUpload(token: string, name: string, bytes: Buffer, mime: string) {
  const existing = await driveList(token, name);
  if (existing.length) {
    // Never overwrite or duplicate: an identical earlier upload is reused, a different one stops the run.
    const same = existing.find(f => f.md5Checksum === md5(bytes));
    if (same) return { ...same, reused: true };
    throw new Error(`drive_name_conflict:${name}`);
  }
  const boundary = `hans01${Date.now()}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [ENTREGAS], mimeType: mime })}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--`);
  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,md5Checksum,parents,createdTime", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` }, body: Buffer.concat([head, bytes, tail]) });
  if (!res.ok) throw new Error(`drive_upload_${res.status}`);
  const f = (await res.json()) as { id: string; name: string; size: string; md5Checksum: string; parents: string[]; createdTime: string };
  // Verify the stored object, not the upload response.
  const check = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?fields=id,name,size,md5Checksum,parents,createdTime`, { headers: { authorization: `Bearer ${token}` } });
  const v = (await check.json()) as typeof f;
  if (Number(v.size) !== bytes.length || v.md5Checksum !== md5(bytes) || !v.parents?.includes(ENTREGAS)) throw new Error(`drive_verify_failed:${name}`);
  return { ...v, reused: false };
}

// ---------- shared checks ----------
async function identity(svc: SupabaseClient) {
  const { data: voice, error: ve } = await svc.from("user_voices").select("id,user_id,name,status,provider,provider_voice_id,needs_review").eq("id", VOICE_ROW).maybeSingle();
  if (ve || !voice) throw new Error("voice_row_missing");
  const { data: avatar, error: ae } = await svc.from("avatars").select("id,user_id,name,provider,status,consent_given,source_photo_path").eq("id", AVATAR_ROW).maybeSingle();
  if (ae || !avatar) throw new Error("avatar_row_missing");
  const photoFile = await svc.storage.from("avatar-uploads").download(avatar.source_photo_path ?? "");
  if (photoFile.error || !photoFile.data) throw new Error("photo_unavailable");
  const photo = Buffer.from(await photoFile.data.arrayBuffer());
  const photoPath = join(OUT, "photo-original");
  await writeFile(photoPath, photo);
  const { stdout } = await sh("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name", "-of", "json", photoPath]);
  const dims = (JSON.parse(stdout).streams?.[0] ?? {}) as { width?: number; height?: number; codec_name?: string };
  report.voice = { rowStatus: voice.status, provider: voice.provider, name: voice.name, providerVoiceIdPresent: Boolean(voice.provider_voice_id), needsReview: voice.needs_review, sameOwnerAsAvatar: voice.user_id === avatar.user_id };
  report.avatar = { provider: avatar.provider, status: avatar.status, name: avatar.name, consentGiven: avatar.consent_given, photoSha256: sha256(photo), photoBytes: photo.length, photoWidth: dims.width, photoHeight: dims.height, photoCodec: dims.codec_name,
    mime: avatar.source_photo_path?.endsWith(".png") ? "image/png" : "image/jpeg" };
  if (voice.provider !== "elevenlabs" || voice.status !== "ready" || !voice.provider_voice_id || voice.needs_review) throw new Error("voice_not_ready");
  if (!avatar.consent_given) throw new Error("avatar_consent_missing");
  if (voice.user_id !== avatar.user_id) throw new Error("voice_avatar_owner_mismatch");
  return { voiceId: voice.provider_voice_id as string, photo, photoMime: (report.avatar as { mime: string }).mime };
}

async function check() {
  const svc = service();
  const { voiceId } = await identity(svc);
  // Review copy stays on the runner (public repo: never uploaded as an artifact). Claude must SEE the photo before any spend.
  await sh("ffmpeg", ["-y", "-v", "error", "-i", join(OUT, "photo-original"), "-vf", "scale=480:-2", "-frames:v", "1", join(OUT, "photo-review.jpg")]);
  const v = await eleven(`/v1/voices/${encodeURIComponent(voiceId)}`);
  report.elevenlabsVoice = { category: v.category, name: v.name };
  report.elevenlabs = await elevenCredits();
  const { getHeygenWallet } = await import("../../src/lib/providers/avatar/heygen");
  report.heygenWalletUsd = await getHeygenWallet();
  const token = await driveToken();
  report.drive = { tokenOk: true, entregasListable: (await driveList(token)).length >= 0, existingOutputs: (await driveList(token)).filter(f => f.name.startsWith(PREFIX)).map(f => f.name) };
  report.estimate = { chars: TEXT.length, voiceMaxUsd: r4(TEXT.length * ELEVEN_USD_PER_CHAR_MAX), heygenMaxUsdFor12s: r4(12 * HEYGEN_USD_PER_SECOND_MAX) };
  report.result = "check_ok_no_spend";
}

async function generate() {
  const approved = process.env.APPROVED_PHOTO_SHA256?.trim();
  if (!approved || !/^[0-9a-f]{64}$/.test(approved)) throw new Error("photo_not_approved");
  const svc = service();
  const { voiceId, photo, photoMime } = await identity(svc);
  if (sha256(photo) !== approved) throw new Error("photo_changed_since_review");

  const { getHeygenWallet, estimateHeygenCost } = await import("../../src/lib/providers/avatar/heygen");
  const { synthesizeVoice, getVoiceIdentity } = await import("../../src/lib/ai/voice");
  const { gatedVoiceSynthesize } = await import("../../src/lib/paid-calls/gated-providers");
  const { guardPaidCall } = await import("../../src/lib/paid-calls/gate");
  const { supabaseLedgerStore } = await import("../../src/lib/paid-calls/supabase-ledger-store");
  const { supabaseResultStore, paidResultPath } = await import("../../src/lib/paid-calls/result-store");
  const { GenerativeProviderError } = await import("../../src/lib/providers/types");
  const ledger = supabaseLedgerStore(svc), results = supabaseResultStore(svc, "videos");

  // ---- budget gate 1 (before any paid call): voice max + generous avatar allowance must fit.
  const walletBefore = await getHeygenWallet();
  const creditsBefore = await elevenCredits();
  report.before = { heygenWalletUsd: walletBefore, elevenlabs: creditsBefore };
  const voiceMax = r4(TEXT.length * ELEVEN_USD_PER_CHAR_MAX);
  if (voiceMax + 12 * HEYGEN_USD_PER_SECOND_MAX > CAP_USD) throw new Error("cap_exceeded_before_voice");
  if (creditsBefore.limit - creditsBefore.used < TEXT.length) throw new Error("elevenlabs_credits_insufficient");

  // ---- 1) voice (ledger-guarded; a stored result is reused at zero cost)
  const voiceProvider = { name: "elevenlabs", async synthesize(text: string, language?: "es" | "en", speed?: number) {
    const r = await synthesizeVoice(text, language ?? "es", speed, voiceId);
    return { ...r, mimeType: "audio/mpeg", extension: "mp3" };
  } };
  const voice = await gatedVoiceSynthesize({ ledger, results, requestId: PROJECT, voiceProvider, voiceIdentity: getVoiceIdentity("es", voiceId), estimatedCostUsd: voiceMax }, TEXT, "es");
  const creditsAfterVoice = await elevenCredits();
  const mp3 = join(OUT, "voz_completa.mp3"), wav = join(OUT, "voz_completa.wav");
  await writeFile(mp3, voice.audioBuffer);
  await sh("ffmpeg", ["-y", "-v", "error", "-i", mp3, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
  const charsUsed = creditsAfterVoice.used - creditsBefore.used;
  report.voiceResult = { reused: voice.reused, durationSecondsAlignment: voice.durationSeconds, durationSecondsDecoded: await probeSeconds(wav), creditsUsed: charsUsed,
    words: voice.words.length };

  // ---- 2) cut the avatar lines from the SAME audio at word boundaries (keeps sync with the full narration)
  const w = voice.words;
  const iOpenEnd = w.findIndex(x => x.text.endsWith(OPENING_LAST));
  const iCloseStart = w.findIndex(x => x.text === CLOSING_FIRST), iCloseEnd = w.findIndex(x => x.text === CLOSING_LAST);
  if (iOpenEnd < 0 || iCloseStart < 0 || iCloseEnd < iCloseStart) throw new Error("word_alignment_not_found");
  const pad = 0.2;
  const cuts = {
    apertura: { start: 0, end: Math.min(w[iOpenEnd].endSeconds + pad, w[iOpenEnd + 1].startSeconds - 0.02) },
    cierre: { start: Math.max(w[iCloseStart].startSeconds - pad, w[iCloseStart - 1].endSeconds + 0.02), end: Math.min(w[iCloseEnd].endSeconds + pad, w[iCloseEnd + 1].startSeconds - 0.02) },
  };
  const clipAudio: Record<string, { file: string; seconds: number; bytes: Buffer }> = {};
  for (const [k, c] of Object.entries(cuts)) {
    const file = join(OUT, `corte_${k}.wav`);
    await sh("ffmpeg", ["-y", "-v", "error", "-i", wav, "-af", `atrim=start=${c.start.toFixed(3)}:end=${c.end.toFixed(3)},asetpts=PTS-STARTPTS`, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", file]);
    clipAudio[k] = { file, seconds: await probeSeconds(file), bytes: await readFile(file) };
  }
  report.cuts = Object.fromEntries(Object.entries(cuts).map(([k, c]) => [k, { startSeconds: r4(c.start), endSeconds: r4(c.end), seconds: r4(clipAudio[k].seconds),
    text: k === "apertura" ? w.slice(0, iOpenEnd + 1).map(x => x.text).join(" ") : w.slice(iCloseStart, iCloseEnd + 1).map(x => x.text).join(" ") }]));

  // ---- 3) budget gate 2 with the REAL durations, before HeyGen
  const avatarSeconds = clipAudio.apertura.seconds + clipAudio.cierre.seconds;
  const avatarMax = r4(avatarSeconds * HEYGEN_USD_PER_SECOND_MAX);
  const voiceUsd = voice.reused ? 0 : voiceMax;
  report.budget = { voiceUsdUpperBound: voiceUsd, avatarSeconds: r4(avatarSeconds), avatarUsdUpperBound: avatarMax, heygenTariffEstimateUsd: r4(estimateHeygenCost(clipAudio.apertura.seconds) + estimateHeygenCost(clipAudio.cierre.seconds)), totalUpperBound: r4(voiceUsd + avatarMax) };
  if (voiceUsd + avatarMax > CAP_USD) throw new Error("cap_exceeded_before_avatar");
  if (walletBefore < avatarMax) throw new Error("heygen_wallet_insufficient");
  await save();

  // ---- 4) HeyGen Avatar IV photo clips (each ledger-guarded; no replay after an uncertain outcome)
  const heygen = async (path: string, init: RequestInit = {}) => {
    const res = await fetch("https://api.heygen.com" + path, { ...init, redirect: "error", signal: AbortSignal.timeout(60000),
      headers: { "X-Api-Key": process.env.HEYGEN_API_KEY!, ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }) } });
    const body = await res.json().catch(() => null) as { data?: Record<string, unknown>; error?: { code?: string } } | null;
    if (!res.ok || !body?.data) {
      const reason = res.status === 400 || res.status === 422 ? "invalid_request" : res.status === 401 || res.status === 403 ? "authentication_error" : "upstream_error";
      throw new GenerativeProviderError(`heygen_http_${res.status}_${String(body?.error?.code ?? "").replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 60)}`, "heygen", reason);
    }
    return body.data;
  };
  const assetUpload = async (bytes: Buffer, mime: string, name: string) => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), name);
    const d = await heygen("/v3/assets", { method: "POST", body: form });
    const id = (d.asset_id ?? d.id) as string;
    if (!id) throw new GenerativeProviderError("heygen_no_asset_id", "heygen", "invalid_response");
    return id;
  };
  const waitVideo = async (videoId: string) => {
    const deadline = Date.now() + 15 * 60000;
    while (Date.now() < deadline) {
      const d = await heygen(`/v3/videos/${encodeURIComponent(videoId)}`);
      if (d.status === "completed" && typeof d.video_url === "string") {
        const r = await fetch(d.video_url, { signal: AbortSignal.timeout(120000) });
        if (!r.ok) throw new GenerativeProviderError("heygen_download_failed", "heygen", "download_failed", undefined, videoId);
        return Buffer.from(await r.arrayBuffer());
      }
      if (d.status === "failed" || d.status === "cancelled") throw new GenerativeProviderError(`heygen_${d.status}`, "heygen", "upstream_error", undefined, videoId);
      await new Promise(res => setTimeout(res, 10000));
    }
    throw new GenerativeProviderError("heygen_still_processing", "heygen", "timeout", undefined, videoId);
  };
  let photoAsset: string | null = null;
  const clips: Record<string, { file: string; reused: boolean; providerJobId?: string; seconds?: number; walletDeltaUsd?: number }> = {};
  for (const k of ["apertura", "cierre"] as const) {
    const a = clipAudio[k];
    const spec = { projectId: PROJECT, shotId: `avatar:${k}`, provider: "heygen", model: "avatar-iv-photo", method: "image_audio_video",
      inputFingerprint: { photo: sha256(photo), audio: sha256(a.bytes), resolution: "720p", aspect: "auto" }, reservedUsd: r4(a.seconds * HEYGEN_USD_PER_SECOND_MAX) };
    const storeMp4 = async (key: string, mp4: Buffer, providerJobId: string) => {
      const p = paidResultPath(PROJECT, key, "mp4");
      await results.putBytes(p, mp4, "video/mp4");
      await results.putJson(paidResultPath(PROJECT, key, "json"), { mp4Path: p, sha256: sha256(mp4), bytes: mp4.length, providerJobId });
      return paidResultPath(PROJECT, key, "json");
    };
    const before = await getHeygenWallet();
    const g = await guardPaidCall<Buffer>(ledger, spec, {
      call: async ({ key }) => {
        photoAsset ??= await assetUpload(photo, photoMime, photoMime === "image/png" ? "photo.png" : "photo.jpeg");
        const audioAsset = await assetUpload(a.bytes, "audio/wav", `${k}.wav`);
        const created = await heygen("/v3/videos", { method: "POST", body: JSON.stringify({ type: "image", image: { type: "asset_id", asset_id: photoAsset }, audio_asset_id: audioAsset, aspect_ratio: "auto", resolution: "720p" }) });
        const videoId = created.video_id as string;
        if (!videoId) throw new GenerativeProviderError("heygen_no_video_id", "heygen", "invalid_response");
        const mp4 = await waitVideo(videoId);
        return { result: mp4, costUsd: spec.reservedUsd, resultRef: await storeMp4(key, mp4, videoId), providerJobId: videoId };
      },
      resume: async (videoId, { key }) => { const mp4 = await waitVideo(videoId); return { result: mp4, costUsd: spec.reservedUsd, resultRef: await storeMp4(key, mp4, videoId), providerJobId: videoId }; },
      load: async (ref) => { const m = await results.getJson<{ mp4Path: string; sha256: string }>(ref); if (!m) return null; const b = await results.getBytes(m.mp4Path); return b && sha256(b) === m.sha256 ? b : null; },
    });
    const after = await getHeygenWallet();
    const file = join(OUT, `avatar_${k}_720p.mp4`);
    await writeFile(file, g.result);
    clips[k] = { file, reused: g.reused, seconds: await probeSeconds(file), walletDeltaUsd: r4(before - after) };
    report.clips = clips;
    await save();
  }

  // ---- 5) real cost and balances
  const walletAfter = await getHeygenWallet();
  const creditsAfter = await elevenCredits();
  const elevenCreditsUsed = creditsAfter.used - creditsBefore.used;
  report.after = { heygenWalletUsd: walletAfter, elevenlabs: creditsAfter };
  report.realCost = { heygenUsd: r4(walletBefore - walletAfter), elevenlabsCredits: elevenCreditsUsed,
    note: "ElevenLabs is a subscription: the run consumes plan credits (characters), not a separate charge; USD equivalent depends on the plan price." };
  for (const [k, c] of Object.entries(clips)) {
    const { stdout } = await sh("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,duration", "-of", "json", c.file]);
    (c as Record<string, unknown>).streams = JSON.parse(stdout).streams;
    void k;
  }

  // ---- 6) Drive «Entregas» (verified by size + md5 + parent)
  const token = await driveToken();
  const uploads = [
    [`${PREFIX}voz_completa.mp3`, mp3, "audio/mpeg"], [`${PREFIX}voz_completa.wav`, wav, "audio/wav"],
    [`${PREFIX}avatar_apertura_720p.mp4`, clips.apertura.file, "video/mp4"], [`${PREFIX}avatar_cierre_720p.mp4`, clips.cierre.file, "video/mp4"],
    [`${PREFIX}corte_apertura.wav`, clipAudio.apertura.file, "audio/wav"], [`${PREFIX}corte_cierre.wav`, clipAudio.cierre.file, "audio/wav"],
  ] as const;
  const drive: unknown[] = [];
  for (const [name, file, mime] of uploads) {
    const bytes = await readFile(file);
    const f = await driveUpload(token, name, bytes, mime);
    drive.push({ name, id: f.id, size: Number(f.size), md5: f.md5Checksum, sha256: sha256(bytes), parentOk: f.parents?.includes(ENTREGAS), createdTime: f.createdTime, reused: f.reused });
  }
  report.drive = drive;
  report.result = "generated_and_delivered";
}

async function main() {
  await mkdir(OUT, { recursive: true });
  if (MODE === "check") await check();
  else if (MODE === "generate") await generate();
  else throw new Error("invalid_mode");
}
main()
  .catch(e => { report.result = "stopped"; report.error = e instanceof Error ? e.message.slice(0, 200) : "unknown"; process.exitCode = 1; })
  .finally(async () => { report.finishedAt = new Date().toISOString(); await save(); console.log(JSON.stringify({ result: report.result, error: report.error ?? null })); });
