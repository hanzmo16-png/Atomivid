/**
 * T-20261012-0648-hans-01 — precampaign voice + two avatar clips, authorised directly by Hans (≤ USD 1.20 total).
 *
 * MODE=check     USD 0: verifies the cloned voice row, the approved avatar photo (private thumbnail for review),
 *                ElevenLabs plan/credits, HeyGen wallet and a private-bucket round trip. No generation.
 * MODE=generate  only with the photo Hans approved (APPROVED_PHOTO: exact sha256, private storage path):
 *                1) full narration with Hans's cloned ElevenLabs voice (one paid call, ledger-guarded);
 *                2) opening/closing lines cut from THAT audio at word timestamps (lip-sync uses the same samples);
 *                3) budget recomputed from the real cut durations BEFORE any HeyGen call; stop if > cap;
 *                4) two HeyGen Avatar IV photo clips, 720p, each ledger-guarded (never resubmitted after an
 *                   uncertain outcome: the ledger turns it into RECONCILIATION_REQUIRED and the run stops);
 *                5) real cost from wallet/credit deltas; files stored in the private bucket "videos" and verified by sha256.
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
// Hans chose (2026-10-12, option a) the navy-jacket photo recovered in Drive (1i1JxePYjDLrME85wrEsI53eI1houVNSt),
// inspected by Claude and Codex. The avatar row's own photo (5446139c…) is a DIFFERENT image (perceptual distance
// 27/64 dHash) and is never used. The workflow cannot read Drive from this branch and the repository is public, so the
// exact bytes must be placed privately at this path; anything with another sha256 is refused.
const APPROVED_PHOTO = { bucket: "avatar-uploads", path: "hans01-precampaign/foto-chaqueta-azul-marino.jpg", mime: "image/jpeg",
  sha256: "d00818a82ded6325b00128e818eb771fe9e4763230cafc75315a5606d18ad3cc", bytes: 191382 } as const;

async function approvedPhoto(svc: SupabaseClient) {
  const f = await svc.storage.from(APPROVED_PHOTO.bucket).download(APPROVED_PHOTO.path);
  if (f.error || !f.data) return { ok: false as const, reason: "approved_photo_not_uploaded" };
  const b = Buffer.from(await f.data.arrayBuffer());
  if (sha256(b) !== APPROVED_PHOTO.sha256) return { ok: false as const, reason: "approved_photo_sha_mismatch", sha256: sha256(b), bytes: b.length };
  return { ok: true as const, photo: b };
}
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
  // Hans confirmed directly (2026-10-12) that both rows are his although they sit in two accounts, and authorised
  // combining them ONLY for this precampaign and ONLY these two row ids (hard-coded above).
  report.owners = { crossAccount: voice.user_id !== avatar.user_id, combinationConfirmedByHans: true };
  return { voiceId: voice.provider_voice_id as string, photo, photoMime: (report.avatar as { mime: string }).mime };
}

async function check() {
  const svc = service();
  const { voiceId, photo } = await identity(svc);
  const v = await eleven(`/v1/voices/${encodeURIComponent(voiceId)}`);
  report.elevenlabsVoice = { category: v.category, cloned: v.category === "cloned" || v.category === "professional" };
  report.elevenlabs = await elevenCredits();
  const { getHeygenWallet } = await import("../../src/lib/providers/avatar/heygen");
  report.heygenWalletUsd = await getHeygenWallet();
  // Which of the two accounts uses the app (private download channel = an owned video_requests row). Counts only.
  const { data: rows } = await svc.from("user_voices").select("user_id").eq("id", VOICE_ROW).maybeSingle();
  const { data: arow } = await svc.from("avatars").select("user_id").eq("id", AVATAR_ROW).maybeSingle();
  const usage = async (uid: string) => {
    const { count } = await svc.from("video_requests").select("id", { count: "exact", head: true }).eq("user_id", uid);
    const { count: done } = await svc.from("video_requests").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("status", "completed");
    return { videoRequests: count ?? 0, completed: done ?? 0 };
  };
  report.appUsage = { voiceOwner: await usage(rows!.user_id), avatarOwner: await usage(arow!.user_id) };
  const { data: sample } = await svc.from("video_requests").select("*").limit(1);
  report.videoRequestColumns = sample?.[0] ? Object.keys(sample[0]).sort() : [];
  // Private channel round trip at USD 0: write, read back and delete a tiny probe in the private "videos" bucket.
  const probePath = `${PROJECT}/entrega/probe.txt`, probe = Buffer.from(`hans-01 probe ${new Date().toISOString()}`);
  const up = await svc.storage.from("videos").upload(probePath, probe, { contentType: "text/plain", upsert: true });
  const down = up.error ? null : await svc.storage.from("videos").download(probePath);
  const back = down?.data ? Buffer.from(await down.data.arrayBuffer()) : null;
  const signed = up.error ? null : await svc.storage.from("videos").createSignedUrl(probePath, 60);
  const viaSigned = signed?.data?.signedUrl ? await fetch(signed.data.signedUrl).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null) : null;
  await svc.storage.from("videos").remove([probePath]);
  const after = await svc.storage.from("videos").download(probePath);
  report.privateChannel = { uploadOk: !up.error, readBackOk: Boolean(back && back.equals(probe)), signedUrlOk: Boolean(viaSigned && Buffer.from(viaSigned).equals(probe)),
    probeDeleted: Boolean(after.error || !after.data) };
  report.estimate = { chars: TEXT.length, voiceMaxUsd: r4(TEXT.length * ELEVEN_USD_PER_CHAR_MAX), heygenMaxUsdFor12s: r4(12 * HEYGEN_USD_PER_SECOND_MAX) };
  report.photoSha256 = sha256(photo);
  const ap = await approvedPhoto(svc);
  report.approvedPhoto = ap.ok ? { present: true, sha256Ok: true, bytes: ap.photo.length } : { present: ap.reason !== "approved_photo_not_uploaded", sha256Ok: false, reason: ap.reason };
  // Perceptual fingerprint only (hashes + 3x3 mean colours): compared privately with the Drive copy, never the image.
  const { photoFingerprint } = await import("./fingerprint");
  report.photoFingerprint = await photoFingerprint(join(OUT, "photo-original"));
  const { supabaseProjectBudgetStore, projectExposure } = await import("../../src/lib/paid-calls/project-budget");
  const bs = supabaseProjectBudgetStore(svc);
  const exp = projectExposure(await bs.listHolds(PROJECT), await bs.listOps(PROJECT));
  report.ledger = { exposureUsd: exp.usd, uncertain: exp.uncertainKeys.length };
  report.deliveryRouteApproved = APPROVED_DELIVERY_ROUTE !== null;
  report.result = "check_ok_no_spend";
}

// Delivery route for the generated files. Hans accepted the private bucket "videos" (2026-10-12) but asked that a route
// recoverable by him, Codex and Grok be verified BEFORE any spend. Until that is confirmed this stays null and
// generate() stops before the first paid call. Changing it is an explicit, reviewable commit.
const APPROVED_DELIVERY_ROUTE: "private-bucket-videos" | null = "private-bucket-videos"; // Hans, 2026-10-12 ~20:00 UTC in chat: «Adelante»

async function deliveryPreflight(svc: SupabaseClient) {
  if (APPROVED_DELIVERY_ROUTE !== "private-bucket-videos") throw new Error("delivery_route_not_approved");
  const path = `${PROJECT}/entrega/preflight.txt`, probe = Buffer.from(`hans-01 preflight ${new Date().toISOString()}`);
  const up = await svc.storage.from("videos").upload(path, probe, { contentType: "text/plain", upsert: true });
  if (up.error) throw new Error("delivery_preflight_upload_failed");
  const back = await svc.storage.from("videos").download(path);
  const ok = back.data ? Buffer.from(await back.data.arrayBuffer()).equals(probe) : false;
  await svc.storage.from("videos").remove([path]);
  if (!ok) throw new Error("delivery_preflight_readback_failed");
}

type Word = { text: string; startSeconds: number; endSeconds: number };
type VoiceOut = { audioBuffer: Buffer; durationSeconds: number; words: Word[] };
type ClipAudio = { file: string; seconds: number; bytes: Buffer };

async function generate() {
  const svc = service();
  const { voiceId } = await identity(svc);
  // Only the photo Hans approved (exact sha256); the avatar row's photo is never sent to HeyGen.
  const ap = await approvedPhoto(svc);
  if (!ap.ok) throw new Error(ap.reason);
  const photo = ap.photo, photoMime = APPROVED_PHOTO.mime;
  report.photoUsed = { source: "hans-approved-drive-copy", sha256: APPROVED_PHOTO.sha256, bytes: photo.length };

  const { getHeygenWallet, estimateHeygenCost } = await import("../../src/lib/providers/avatar/heygen");
  const { synthesizeVoice, getVoiceIdentity } = await import("../../src/lib/ai/voice");
  const { supabaseLedgerStore } = await import("../../src/lib/paid-calls/supabase-ledger-store");
  const { supabaseResultStore, paidResultPath } = await import("../../src/lib/paid-calls/result-store");
  const { supabaseProjectBudgetStore } = await import("../../src/lib/paid-calls/project-budget");
  const { runHans01 } = await import("../../src/lib/precampaign/hans01-flow");
  const { GenerativeProviderError } = await import("../../src/lib/providers/types");
  const ledger = supabaseLedgerStore(svc), results = supabaseResultStore(svc, "videos"), budget = supabaseProjectBudgetStore(svc);

  const walletBefore = await getHeygenWallet();
  const creditsBefore = await elevenCredits();
  report.before = { heygenWalletUsd: walletBefore, elevenlabs: creditsBefore };
  if (creditsBefore.limit - creditsBefore.used < TEXT.length) throw new Error("elevenlabs_credits_insufficient");
  const identityV = getVoiceIdentity("es", voiceId);

  // ---- HeyGen (asset upload + Avatar IV photo video). Errors carry the job id once accepted (resume, never resubmit).
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
  const storeMp4 = async (key: string, mp4: Buffer, providerJobId: string) => {
    const p = paidResultPath(PROJECT, key, "mp4");
    await results.putBytes(p, mp4, "video/mp4");
    await results.putJson(paidResultPath(PROJECT, key, "json"), { mp4Path: p, sha256: sha256(mp4), bytes: mp4.length, providerJobId });
    return paidResultPath(PROJECT, key, "json");
  };

  const voiceMax = TEXT.length * ELEVEN_USD_PER_CHAR_MAX;
  const out = await runHans01<VoiceOut, ClipAudio, Buffer, unknown[]>({
    projectId: PROJECT, capUsd: CAP_USD, ledger, budget,
    deliveryPreflight: () => deliveryPreflight(svc),
    voice: {
      spec: { projectId: PROJECT, shotId: "voice:full", provider: "elevenlabs", model: identityV.modelId, method: "tts_with_timestamps", capacityUnits: TEXT.length,
        inputFingerprint: { text: TEXT, language: "es", voiceId, modelId: identityV.modelId, voiceSettingsJson: identityV.voiceSettingsJson }, reservedUsd: voiceMax },
      hooks: {
        call: async ({ key }) => {
          const r = await synthesizeVoice(TEXT, "es", undefined, voiceId);
          const mp3Path = paidResultPath(PROJECT, key, "mp3");
          await results.putBytes(mp3Path, r.audioBuffer, "audio/mpeg");
          await results.putJson(paidResultPath(PROJECT, key, "json"), { mp3Path, sha256: sha256(r.audioBuffer), durationSeconds: r.durationSeconds, words: r.words });
          return { result: { audioBuffer: r.audioBuffer, durationSeconds: r.durationSeconds, words: r.words }, costUsd: voiceMax, resultRef: paidResultPath(PROJECT, key, "json") };
        },
        load: async (ref) => {
          const m = await results.getJson<{ mp3Path: string; sha256: string; durationSeconds: number; words: Word[] }>(ref);
          const b = m ? await results.getBytes(m.mp3Path) : null;
          return m && b && sha256(b) === m.sha256 ? { audioBuffer: b, durationSeconds: m.durationSeconds, words: m.words } : null;
        },
      },
    },
    avatarUsdPerSecond: HEYGEN_USD_PER_SECOND_MAX, avatarAllowanceSeconds: 12,
    // Cut the avatar lines from the SAME audio at word timestamps (lip-sync uses the same samples).
    cut: async (voice) => {
      const mp3 = join(OUT, "voz_completa.mp3"), wav = join(OUT, "voz_completa.wav");
      await writeFile(mp3, voice.audioBuffer);
      await sh("ffmpeg", ["-y", "-v", "error", "-i", mp3, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
      report.voiceResult = { durationSecondsAlignment: voice.durationSeconds, durationSecondsDecoded: await probeSeconds(wav), words: voice.words.length };
      const w = voice.words;
      const iOpenEnd = w.findIndex(x => x.text.endsWith(OPENING_LAST));
      const iCloseStart = w.findIndex(x => x.text === CLOSING_FIRST), iCloseEnd = w.findIndex(x => x.text === CLOSING_LAST);
      if (iOpenEnd < 0 || iCloseStart < 0 || iCloseEnd < iCloseStart) throw new Error("word_alignment_not_found");
      const pad = 0.2;
      const cuts = {
        apertura: { start: 0, end: Math.min(w[iOpenEnd].endSeconds + pad, w[iOpenEnd + 1].startSeconds - 0.02) },
        cierre: { start: Math.max(w[iCloseStart].startSeconds - pad, w[iCloseStart - 1].endSeconds + 0.02), end: Math.min(w[iCloseEnd].endSeconds + pad, w[iCloseEnd + 1].startSeconds - 0.02) },
      };
      const audio = {} as Record<"apertura" | "cierre", ClipAudio>;
      for (const [k, c] of Object.entries(cuts) as ["apertura" | "cierre", { start: number; end: number }][]) {
        const file = join(OUT, `corte_${k}.wav`);
        await sh("ffmpeg", ["-y", "-v", "error", "-i", wav, "-af", `atrim=start=${c.start.toFixed(3)}:end=${c.end.toFixed(3)},asetpts=PTS-STARTPTS`, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", file]);
        audio[k] = { file, seconds: await probeSeconds(file), bytes: await readFile(file) };
      }
      report.cuts = Object.fromEntries(Object.entries(cuts).map(([k, c]) => [k, { startSeconds: r4(c.start), endSeconds: r4(c.end), seconds: r4(audio[k as "apertura"].seconds) }]));
      report.budget = { avatarSeconds: r4(audio.apertura.seconds + audio.cierre.seconds), heygenTariffEstimateUsd: r4(estimateHeygenCost(audio.apertura.seconds) + estimateHeygenCost(audio.cierre.seconds)) };
      await save();
      return audio;
    },
    clip: (k, a) => ({
      spec: { projectId: PROJECT, shotId: `avatar:${k}`, provider: "heygen", model: "avatar-iv-photo", method: "image_audio_video",
        inputFingerprint: { photo: sha256(photo), audio: sha256(a.bytes), resolution: "720p", aspect: "auto" }, reservedUsd: a.seconds * HEYGEN_USD_PER_SECOND_MAX },
      hooks: {
        call: async ({ key }) => {
          photoAsset ??= await assetUpload(photo, photoMime, "photo.jpeg");
          const audioAsset = await assetUpload(a.bytes, "audio/wav", `${k}.wav`);
          const created = await heygen("/v3/videos", { method: "POST", body: JSON.stringify({ type: "image", image: { type: "asset_id", asset_id: photoAsset }, audio_asset_id: audioAsset, aspect_ratio: "auto", resolution: "720p" }) });
          const videoId = created.video_id as string;
          if (!videoId) throw new GenerativeProviderError("heygen_no_video_id", "heygen", "invalid_response");
          const mp4 = await waitVideo(videoId);
          return { result: mp4, costUsd: a.seconds * HEYGEN_USD_PER_SECOND_MAX, resultRef: await storeMp4(key, mp4, videoId), providerJobId: videoId };
        },
        resume: async (videoId, { key }) => { const mp4 = await waitVideo(videoId); return { result: mp4, costUsd: a.seconds * HEYGEN_USD_PER_SECOND_MAX, resultRef: await storeMp4(key, mp4, videoId), providerJobId: videoId }; },
        load: async (ref) => { const m = await results.getJson<{ mp4Path: string; sha256: string }>(ref); if (!m) return null; const b = await results.getBytes(m.mp4Path); return b && sha256(b) === m.sha256 ? b : null; },
      },
    }),
    observeAccountUsd: getHeygenWallet,
    // Delivery in the private bucket "videos", each object read back and verified (sha256 + md5 for a later Drive check).
    deliver: async ({ voice, audio, clips }) => {
      const files: [string, Buffer, string][] = [
        ["voz_completa.mp3", voice.audioBuffer, "audio/mpeg"], ["voz_completa.wav", await readFile(join(OUT, "voz_completa.wav")), "audio/wav"],
        ["avatar_apertura_720p.mp4", clips.apertura, "video/mp4"], ["avatar_cierre_720p.mp4", clips.cierre, "video/mp4"],
        ["corte_apertura.wav", audio.apertura.bytes, "audio/wav"], ["corte_cierre.wav", audio.cierre.bytes, "audio/wav"],
      ];
      const delivery: unknown[] = [];
      for (const [name, bytes, mime] of files) {
        const path = `${PROJECT}/entrega/${name}`;
        const up = await svc.storage.from("videos").upload(path, bytes, { contentType: mime, upsert: true });
        if (up.error) throw new Error(`delivery_upload_failed:${name}`);
        const back = await svc.storage.from("videos").download(path);
        const ok = back.data ? sha256(Buffer.from(await back.data.arrayBuffer())) === sha256(bytes) : false;
        if (!ok) throw new Error(`delivery_verify_failed:${name}`);
        let streams: unknown = null;
        if (mime === "video/mp4") {
          const f = join(OUT, name);
          await writeFile(f, bytes);
          streams = JSON.parse((await sh("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,duration", "-of", "json", f])).stdout).streams;
        }
        delivery.push({ name, bytes: bytes.length, sha256: sha256(bytes), md5: md5(bytes), verified: ok, streams });
      }
      return delivery;
    },
  });

  // Real cost: HeyGen wallet delta is an observation of the account (not an exact attribution if anything else ran);
  // ElevenLabs is a subscription, so the run consumes plan characters rather than a separate charge.
  const walletAfter = await getHeygenWallet();
  const creditsAfter = await elevenCredits();
  report.after = { heygenWalletUsd: walletAfter, elevenlabs: creditsAfter };
  report.clips = Object.fromEntries(Object.entries(out.clips).map(([k, c]) => [k, { reused: c.reused, reservedUsd: c.reservedUsd, attributedUsd: c.attributedUsd, walletDeltaUsd: c.observedAccountDeltaUsd }]));
  report.realCost = { heygenWalletDeltaUsd: r4(walletBefore - walletAfter), elevenlabsCreditsUsed: creditsAfter.used - creditsBefore.used, voiceReused: out.voice.reused,
    projectExposureStartUsd: out.exposureAtStartUsd, projectExposureEndUsd: out.exposureAtEndUsd };
  report.delivery = out.delivered;
  report.result = "generated_and_delivered";
}

// Correction 3 (chatgpt-25): bounded, read-only inventory of the two accounts' private photos vs the approved one.
async function inventoryMode() {
  const svc = service();
  const { collectCandidates, inventory } = await import("./inventory");
  const { data: v } = await svc.from("user_voices").select("user_id").eq("id", VOICE_ROW).maybeSingle();
  const { data: a } = await svc.from("avatars").select("user_id").eq("id", AVATAR_ROW).maybeSingle();
  if (!v || !a) throw new Error("owner_rows_missing");
  const owners = [{ id: v.user_id as string, label: "cuenta_voz" as const }, { id: a.user_id as string, label: "cuenta_avatar" as const }];
  const extra = [];
  for (const o of owners) {
    const { data: rows } = await svc.from("avatars").select("source_photo_path").eq("user_id", o.id);
    for (const r of rows ?? []) if (r.source_photo_path) extra.push({ path: r.source_photo_path as string, owner: o.label, source: "avatars.source_photo_path" });
  }
  extra.push({ path: APPROVED_PHOTO.path, owner: "cuenta_avatar" as const, source: "ruta_aprobada" });
  const bucket = svc.storage.from(APPROVED_PHOTO.bucket);
  const store = {
    async list(prefix: string) {
      const { data } = await bucket.list(prefix, { limit: 100 });
      return (data ?? []).map(e => ({ name: e.name, isFolder: e.id === null }));
    },
    async download(path: string) { const r = await bucket.download(path); return r.data ? Buffer.from(await r.data.arrayBuffer()) : null; },
  };
  const cands = await collectCandidates(store, owners.map(o => ({ prefix: o.id, owner: o.label })), extra);
  report.inventory = await inventory(store, cands);
  report.result = "inventory_ok_no_spend";
}

async function main() {
  await mkdir(OUT, { recursive: true });
  if (MODE === "check") await check();
  else if (MODE === "generate") await generate();
  else if (MODE === "inventory") await inventoryMode();
  else throw new Error("invalid_mode");
}
main()
  .catch(e => { report.result = "stopped"; report.error = e instanceof Error ? e.message.slice(0, 200) : "unknown"; process.exitCode = 1; })
  .finally(async () => { report.finishedAt = new Date().toISOString(); await save(); const a = report.avatar as Record<string, unknown> | undefined, vo = report.voice as Record<string, unknown> | undefined;
    console.log("HANS01_SUMMARY " + JSON.stringify({ result: report.result, error: report.error ?? null, photoSha256: a?.photoSha256, photoFingerprint: report.photoFingerprint, approvedPhoto: report.approvedPhoto, inventory: report.inventory, photo: a && { w: a.photoWidth, h: a.photoHeight, codec: a.photoCodec, bytes: a.photoBytes },
      voice: vo && { status: vo.rowStatus, provider: vo.provider, needsReview: vo.needsReview }, elevenlabsVoice: report.elevenlabsVoice, elevenlabs: report.elevenlabs, heygenWalletUsd: report.heygenWalletUsd,
      owners: report.owners, appUsage: report.appUsage, videoRequestColumns: report.videoRequestColumns, privateChannel: report.privateChannel, estimate: report.estimate, ledger: report.ledger, deliveryRouteApproved: report.deliveryRouteApproved,
      before: report.before, voiceResult: report.voiceResult, cuts: report.cuts, budget: report.budget, clips: report.clips && Object.fromEntries(Object.entries(report.clips as Record<string, Record<string, unknown>>).map(([k, c]) => [k, { reused: c.reused, seconds: c.seconds, walletDeltaUsd: c.walletDeltaUsd, streams: c.streams }])),
      after: report.after, realCost: report.realCost, delivery: report.delivery })); });
