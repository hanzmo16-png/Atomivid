/**
 * Owner-authorised (Hans, 2026-10-23 21:09): ONE real production of Travis Walton Ep. 2 (podcast 1.x, single narrator,
 * audio only) with the El Duro Hans voice and a server-side cap of USD 3.40 including retries:
 *  - DB: pi_spend_authorizations cap 3.40 enforced inside pi_submit_with_supply before every ElevenLabs call (PR #198);
 *  - app: runGeneration(..., { capUsd: 3.40 }) stops before exceeding it; paid chunks are stored and reused.
 * Requires CONFIRM=WALTON-EP2-3.40 and production running EXPECTED_COMMIT. Never creates a second episode.
 */
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { providerConfigSignature } from "../src/lib/ops/provider-config";
import { normalizeScript, validateScript, estimatePodcast, podcastLedgerProject } from "../src/lib/podcast/episode";
import { runGeneration, EPISODE_COLUMNS, ensureBundledFfmpeg } from "../src/lib/podcast/server";
import { listAccountVoices } from "../src/lib/podcast/voices";
import { elevenLabsSnapshot } from "../src/lib/production-intelligence/capacity/adapters";
import { supplyGuardRequired } from "../src/lib/supply/server";
const log = (t: string, v: unknown) => console.log(t, JSON.stringify(v));
const CAP = 3.40, VOICE = "CeFSZuaHs4SxcBxb9nCr", REF = "hans-2026-10-23-walton-ep2-usd3.40", ORIGIN = "https://atomivid.vercel.app";
const TITLE = "Crónicas y Misterios del Universo — Ep. 2: Travis Walton, lo que dicen los polígrafos";
async function main() {
  if (process.env.CONFIRM !== "WALTON-EP2-3.40") throw Error("confirmation missing");
  // Every ElevenLabs call must go through pi_submit_with_supply (where the stored authorization is enforced).
  if (!supplyGuardRequired()) return log("STOP", { reason: "supply guard not enforced in this runtime" });
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
  const db = createClient(process.env.SUPABASE_URL!.trim(), key, { auth: { persistSession: false, autoRefreshToken: false } });
  // 1) Production runs the merged commit.
  { const nonce = randomUUID(), ts = String(Date.now());
    const r = await fetch(`${ORIGIN}/api/internal/provider-config`, { method: "POST", headers: { "x-probe-nonce": nonce, "x-probe-time": ts, "x-probe-signature": providerConfigSignature(key, nonce, ts) } });
    const j = await r.json() as { commit?: string; keys?: Record<string, unknown> }; log("PROD", { status: r.status, commit: j.commit, privateVoiceGrants: j.keys?.PRIVATE_VOICE_GRANTS ?? null });
    if (!process.env.EXPECTED_COMMIT || j.commit !== process.env.EXPECTED_COMMIT) return log("STOP", { reason: "production does not run the expected commit", expected: process.env.EXPECTED_COMMIT }); }
  // 2) The server-side control exists (PR #198 migration applied).
  { const { error } = await db.from("pi_spend_authorizations").select("project_id").limit(1);
    if (error) return log("STOP", { reason: "pi_spend_authorizations not available: migration not applied", error: error.message }); }
  // 3) Owner = owner of the internal production account (same user as job e8048599); El Duro in the account.
  const { data: job } = await db.from("documentary_script_jobs").select("user_id").eq("id", "e8048599-cf92-45e8-95c8-f145cb9d3be2").single();
  const owner = (job as { user_id: string }).user_id;
  const voices = await listAccountVoices({ fresh: true });
  const duro = voices.find((v) => v.voiceId === VOICE);
  log("VOICE", { found: !!duro, name: duro?.name ?? null, category: (duro as { category?: string } | undefined)?.category ?? null });
  if (!duro) return log("STOP", { reason: "El Duro voice not in the ElevenLabs account: not substituted" });
  // 4) Script + estimate (same functions as the app); refuse if it cannot fit the cap.
  const script = normalizeScript(readFileSync("content/podcast/travis-walton-ep2/guion.txt", "utf8"));
  const invalid = validateScript(script); if (invalid) return log("STOP", { reason: invalid });
  const est = estimatePodcast(script);
  log("ESTIMATE", est);
  if (!(est.usd <= CAP)) return log("STOP", { reason: "estimate exceeds the authorized cap", est });
  // 5) One episode only (idempotent by owner + title).
  let { data: ep } = await db.from("podcast_episodes").select(EPISODE_COLUMNS).eq("user_id", owner).eq("title", TITLE).order("created_at").limit(1).maybeSingle();
  if (ep && (ep as { status: string }).status === "ready") return log("STOP", { reason: "episode already produced; not regenerated", id: (ep as { id: string }).id });
  if (!ep) {
    const ins = await db.from("podcast_episodes").insert({ user_id: owner, title: TITLE, language: "es", source: "tts", script, voice_id: VOICE, voice_name: duro.name, characters: est.characters, estimated_usd: est.usd, budget_usd: CAP }).select(EPISODE_COLUMNS).single();
    if (ins.error) return log("STOP", { reason: "episode insert failed", error: ins.error.message });
    ep = ins.data;
  }
  const e = ep as unknown as Parameters<typeof runGeneration>[1];
  const project = podcastLedgerProject(e.id);
  log("EPISODE", { id: e.id, status: e.status, characters: e.characters, estimated_usd: e.estimated_usd });
  // 6) Stored spend authorization (immutable, one per episode).
  const open = await db.rpc("pi_open_spend_authorization", { p_episode_id: e.id, p_cap_usd: CAP, p_authorization_ref: REF });
  log("AUTHZ", { result: open.data ?? null, error: open.error?.message ?? null });
  const { data: auth } = await db.from("pi_spend_authorizations").select("cap_usd,status,owner_id,authorization_ref").eq("project_id", project).maybeSingle();
  if (!auth || Number((auth as { cap_usd: number }).cap_usd) !== CAP || (auth as { status: string }).status !== "ACTIVE" || (auth as { owner_id: string }).owner_id !== owner)
    return log("STOP", { reason: "stored authorization missing or different from the approved cap", auth });
  // 7) Single real production.
  const now = new Date().toISOString();
  const before = await elevenLabsSnapshot(fetch, process.env, 0, 0, now);
  const t0 = Date.now();
  const r = await runGeneration(db, e, Date.now, { capUsd: CAP });
  const after = await elevenLabsSnapshot(fetch, process.env, 0, 0, new Date().toISOString());
  const { data: ops } = await db.from("pi_paid_operations").select("status,reserved_usd,committed_usd,provider,method").eq("project_id", project);
  const usage = await db.rpc("pi_spend_authorization_usage", { p_project_id: project, p_exclude_key: null });
  log("RUN", { ok: "ok" in r, error: "error" in r ? r.error : null, seconds: Math.round((Date.now() - t0) / 1000),
    elevenlabsCharsBefore: before.available, elevenlabsCharsAfter: after.available, charsConsumed: before.available != null && after.available != null ? before.available - after.available : null,
    ledger: (ops ?? []).map((o) => `${o.provider}:${o.method}:${o.status}:r${o.reserved_usd}:c${o.committed_usd}`), usage: usage.data ?? usage.error?.message });
  if (!("ok" in r)) return;
  // 8) Verify the delivered audio (download, probe, loudness) and a playback link.
  const ready = r.episode;
  const { data: blob } = await db.storage.from("videos").download(ready.audio_path!);
  const dir = await mkdtemp(path.join(tmpdir(), "walton-")); const f = path.join(dir, "episode.m4a");
  await writeFile(f, Buffer.from(await blob!.arrayBuffer()));
  ensureBundledFfmpeg();
  const ff = process.env.FFMPEG_BIN!;
  const probe = spawnSync(ff, ["-hide_banner", "-i", f], { encoding: "utf8" }).stderr.match(/Duration: [^,]+|Audio: [^\n]+|Video: [^\n]+/g);
  const loud = spawnSync(ff, ["-hide_banner", "-nostats", "-i", f, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const tail = loud.slice(loud.lastIndexOf("Summary:"));
  const signed = await db.storage.from("videos").createSignedUrl(ready.audio_path!, 7 * 24 * 3600);
  log("DELIVERY", { id: ready.id, status: ready.status, duration_seconds: ready.duration_seconds, bytes: ready.audio_bytes, sha256: ready.audio_sha256, cost_usd: ready.cost_usd,
    probe, lufs: /I:\s+(-?[\d.]+) LUFS/.exec(tail)?.[1] ?? null, truePeak: /Peak:\s+(-?[\d.]+) dBFS/.exec(tail.slice(tail.indexOf("True peak")))?.[1] ?? null,
    appUrl: `https://atomicvid.app/dashboard/podcast/${ready.id}` });
  if (signed.data?.signedUrl) console.log("LINK " + signed.data.signedUrl);
}
main().catch((e) => { console.log("FAILED", String(e).slice(0, 400)); process.exitCode = 1; });
