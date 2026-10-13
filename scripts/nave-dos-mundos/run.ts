/**
 * «Una nave entre dos mundos» — paid generation runner (Hans, 2026-10-13: spend authorised for this test, no cap).
 *
 * ops/nave-dos-mundos.mode
 *   line 1: phase = check | refs | keyframes | clips
 *   line 2: GASTAR (required for any paid phase)
 *   line 3 (optional): only=<key,key>  — keys are shot/ref ids, optionally versioned "s05@2" for a deliberate redo
 *
 * - Reuse first: an output already in the private bucket is never regenerated (cost 0).
 * - Write-ahead ledger (videos/samples/nave-dos-mundos/state/ledger.json): reserved → spent | failed | uncertain.
 *   A reserved/uncertain entry without output stops the run for that key; a Veo entry with an operation name is
 *   resumed (polling only, no new charge).
 * - Never prints secrets or signed URLs. Outputs are copied to OUT_DIR, which the workflow encrypts with the public
 *   key in ops/nave-dos-mundos.pub.pem before uploading (the repository is public; nothing is published in clear).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { veoVideoProvider } from "@/lib/providers/video-gen/veo";
import { NEGATIVE, REFS, SHOTS, STYLE, type RefId, type Shot } from "./shots";

const PREFIX = "samples/nave-dos-mundos";
const OUT = resolve(process.env.OUT_DIR ?? "nave-output");
const MODE = resolve("ops/nave-dos-mundos.mode");
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
const IMAGE_ESTIMATE_USD = 0.25; // high quality, portrait/landscape, with reference inputs: conservative estimate; usage tokens are recorded too
const CLIP_ESTIMATE_USD = 8 * Number(process.env.VEO_COST_USD_PER_SECOND || "0.12");
const CONCURRENCY = 4;

type Status = "reserved" | "spent" | "failed" | "uncertain";
type Entry = { key: string; kind: "image" | "video"; status: Status; usd: number; at: string; model: string; job?: string; note?: string; usage?: unknown; sha256?: string; bytes?: number };
type Ledger = { entries: Entry[] };

const log = (...a: unknown[]) => console.log(`[nave ${new Date().toISOString()}]`, ...a);

function service(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("missing Supabase credentials");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function exists(svc: SupabaseClient, path: string): Promise<boolean> {
  const dir = dirname(path), name = path.slice(dir.length + 1);
  const { data } = await svc.storage.from("videos").list(dir, { search: name, limit: 10 });
  return !!data?.some(o => o.name === name);
}
async function download(svc: SupabaseClient, path: string): Promise<Buffer> {
  const { data, error } = await svc.storage.from("videos").download(path);
  if (error || !data) throw new Error(`download failed: ${path}`);
  return Buffer.from(await data.arrayBuffer());
}
async function upload(svc: SupabaseClient, path: string, bytes: Buffer, contentType: string) {
  const { error } = await svc.storage.from("videos").upload(path, bytes, { contentType, upsert: true });
  if (error) throw new Error(`upload failed: ${path}: ${error.message}`);
  const back = await download(svc, path);
  if (!back.equals(bytes)) throw new Error(`read-back mismatch: ${path}`);
}

// ---- ledger (single job, serialised writes)
let ledgerChain = Promise.resolve();
async function loadLedger(svc: SupabaseClient): Promise<Ledger> {
  const p = `${PREFIX}/state/ledger.json`;
  return (await exists(svc, p)) ? JSON.parse((await download(svc, p)).toString("utf8")) : { entries: [] };
}
function saveLedger(svc: SupabaseClient, l: Ledger) {
  // Each save runs after the previous one settles (a failed save never silently skips the next) and reports its own error.
  const next = ledgerChain.catch(() => {}).then(() => upload(svc, `${PREFIX}/state/ledger.json`, Buffer.from(JSON.stringify(l, null, 2)), "application/json"));
  ledgerChain = next;
  return next;
}
const total = (l: Ledger) => Math.round(l.entries.filter(e => e.status === "spent" || e.status === "uncertain").reduce((s, e) => s + e.usd, 0) * 100) / 100;

// ---- OpenAI images (generation for reference sheets, edits with reference inputs for keyframes)
async function openaiImage(prompt: string, size: string, inputs: { name: string; bytes: Buffer }[]): Promise<{ bytes: Buffer; usage: unknown }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY missing");
  let res: Response;
  if (!inputs.length) {
    res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: IMAGE_MODEL, prompt, size, quality: "high", n: 1 }),
    });
  } else {
    const form = new FormData();
    form.append("model", IMAGE_MODEL); form.append("prompt", prompt); form.append("size", size); form.append("quality", "high"); form.append("n", "1");
    for (const i of inputs) form.append("image[]", new Blob([new Uint8Array(i.bytes)], { type: "image/png" }), i.name);
    res = await fetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
  }
  const json = await res.json().catch(() => ({})) as { data?: { b64_json?: string }[]; usage?: unknown; error?: { message?: string } };
  if (!res.ok || !json.data?.[0]?.b64_json) throw Object.assign(new Error(`OpenAI image HTTP ${res.status}: ${json.error?.message ?? "no image"}`), { charged: res.ok });
  return { bytes: Buffer.from(json.data[0].b64_json, "base64"), usage: json.usage };
}

function parseMode(raw: string) {
  const lines = raw.split("\n").map(l => l.trim());
  const only = (lines[2] ?? "").startsWith("only=") ? lines[2].slice(5).split(",").map(s => s.trim()).filter(Boolean) : [];
  return { phase: lines[0], confirm: lines[1], only };
}
const baseId = (key: string) => key.split("@")[0];

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  const queue = [...items]; const errors: unknown[] = [];
  await Promise.all(Array.from({ length: n }, async () => { for (let t = queue.shift(); t !== undefined; t = queue.shift()) await fn(t).catch(e => errors.push(e)); }));
  return errors;
}

async function main() {
  const { phase, confirm, only } = parseMode(await readFile(MODE, "utf8"));
  await mkdir(OUT, { recursive: true });
  const svc = service();
  const ledger = await loadLedger(svc);
  const report: Record<string, unknown> = { phase, startedAt: new Date().toISOString(), results: [] as unknown[] };
  const results = report.results as unknown[];
  log("phase", phase, "only", only.join(",") || "(all)", "spent so far USD", total(ledger));

  const paid = phase === "refs" || phase === "keyframes" || phase === "clips";
  if (paid && confirm !== "GASTAR") throw new Error("paid phase without GASTAR on line 2");

  // One paid unit with reuse + write-ahead ledger.
  async function unit(key: string, kind: Entry["kind"], outPath: string, usd: number, model: string, run: (onJob: (job: string) => Promise<void>, resumeJob?: string) => Promise<{ bytes: Buffer; usage?: unknown; contentType: string }>) {
    if (await exists(svc, outPath)) { results.push({ key, status: "reused", usd: 0 }); log(key, "reused (cost 0)"); return; }
    const prior = ledger.entries.filter(e => e.key === key).at(-1);
    let resumeJob: string | undefined;
    if (prior && (prior.status === "reserved" || prior.status === "uncertain")) {
      if (kind === "video" && prior.job) { resumeJob = prior.job; log(key, "resuming submitted operation (no new charge)"); }
      else { results.push({ key, status: "blocked_uncertain" }); log(key, "BLOCKED: previous attempt uncertain, needs review"); return; }
    }
    const entry: Entry = resumeJob ? prior! : { key, kind, status: "reserved", usd, at: new Date().toISOString(), model };
    if (!resumeJob) { ledger.entries.push(entry); await saveLedger(svc, ledger); }
    try {
      const out = await run(async job => { entry.job = job; await saveLedger(svc, ledger); }, resumeJob);
      await upload(svc, outPath, out.bytes, out.contentType);
      Object.assign(entry, { status: "spent", usage: out.usage, sha256: createHash("sha256").update(out.bytes).digest("hex"), bytes: out.bytes.length, at: new Date().toISOString() });
      await saveLedger(svc, ledger);
      results.push({ key, status: resumeJob ? "resumed" : "generated", usd: entry.usd, bytes: out.bytes.length });
      log(key, resumeJob ? "resumed" : "generated", out.bytes.length, "bytes, USD", entry.usd);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A refusal before acceptance is not charged; anything after a provider accepted the job is uncertain.
      const charged = (e as { charged?: boolean }).charged === true || !!entry.job;
      Object.assign(entry, { status: charged ? "uncertain" : "failed", note: msg.slice(0, 300), usd: charged ? entry.usd : 0 });
      await saveLedger(svc, ledger);
      results.push({ key, status: entry.status, error: msg.slice(0, 300) });
      log(key, "FAILED", entry.status, msg.slice(0, 300));
    }
  }

  if (phase === "refs") {
    const keys = (only.length ? only : Object.keys(REFS)) as string[];
    for (const key of keys) {
      const id = baseId(key) as RefId;
      await unit(`ref:${key}`, "image", `${PREFIX}/refs/${key}.png`, IMAGE_ESTIMATE_USD, IMAGE_MODEL,
        async () => ({ ...(await openaiImage(REFS[id], "1536x1024", [])), contentType: "image/png" }));
    }
  }

  if (phase === "keyframes") {
    const refBytes: Partial<Record<RefId, Buffer>> = {};
    for (const r of Object.keys(REFS) as RefId[]) if (await exists(svc, `${PREFIX}/refs/${r}.png`)) refBytes[r] = await download(svc, `${PREFIX}/refs/${r}.png`);
    const keys = only.length ? only : SHOTS.map(s => s.id);
    await pool(keys, CONCURRENCY, async key => {
      const shot = SHOTS.find(s => s.id === baseId(key)) as Shot;
      const inputs = shot.refs.map(r => { if (!refBytes[r]) throw new Error(`reference ${r} missing`); return { name: `${r}.png`, bytes: refBytes[r]! }; });
      const prompt = `${shot.keyframe}\n\nThe ship and creature must match the provided reference sheets exactly (same design, colours and proportions). ${STYLE}. Avoid: ${NEGATIVE}.`;
      await unit(`kf:${key}`, "image", `${PREFIX}/keyframes/${key}.png`, IMAGE_ESTIMATE_USD, IMAGE_MODEL,
        async () => ({ ...(await openaiImage(prompt, "1024x1536", inputs)), contentType: "image/png" }));
    });
  }

  if (phase === "clips") {
    const keys = only.length ? only : SHOTS.map(s => s.id);
    await pool(keys, CONCURRENCY, async key => {
      const shot = SHOTS.find(s => s.id === baseId(key)) as Shot;
      const kf = `${PREFIX}/keyframes/${key.includes("@") ? key : shot.id}.png`;
      const kfAlt = `${PREFIX}/keyframes/${shot.id}.png`;
      const kfPath = (await exists(svc, kf)) ? kf : kfAlt;
      if (!(await exists(svc, kfPath))) { results.push({ key, status: "no_keyframe" }); log(key, "no keyframe"); return; }
      const signed = await svc.storage.from("videos").createSignedUrl(kfPath, 3600);
      if (!signed.data?.signedUrl) throw new Error(`cannot sign keyframe for ${key}`);
      const request = { prompt: `${shot.motion} Keep the ship's design, colours and proportions exactly as in the first frame. Cinematic, photorealistic.`,
        negativePrompt: NEGATIVE, aspectRatio: "9:16" as const, durationSeconds: 8, maxCostUsd: CLIP_ESTIMATE_USD, referenceImageUrl: signed.data.signedUrl };
      await unit(`clip:${key}`, "video", `${PREFIX}/clips/${key}.mp4`, CLIP_ESTIMATE_USD, "veo-3.1-fast-generate-preview",
        async (onJob, resumeJob) => {
          const asset = resumeJob ? await veoVideoProvider.resumeGeneration!(resumeJob, request)
            : await veoVideoProvider.generateVideo({ ...request, onProviderJobAccepted: onJob });
          return { bytes: asset.buffer!, contentType: "video/mp4" };
        });
    });
  }

  // Copy every stored output (refs, keyframes, clips) + ledger to OUT for the encrypted bundle.
  for (const dir of ["refs", "keyframes", "clips", "state"]) {
    const { data } = await svc.storage.from("videos").list(`${PREFIX}/${dir}`, { limit: 200 });
    for (const o of data ?? []) {
      if (!o.name || o.name.endsWith("/")) continue;
      const bytes = await download(svc, `${PREFIX}/${dir}/${o.name}`);
      await mkdir(join(OUT, dir), { recursive: true });
      await writeFile(join(OUT, dir, o.name), bytes);
    }
  }
  report.finishedAt = new Date().toISOString();
  report.spentUsdTotal = total(ledger);
  await writeFile(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  log("done; total spent USD (incl. uncertain)", total(ledger));
}

main().catch(async e => {
  const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
  console.error("[nave] fatal:", message);
  // The CI log is not readable from Claude's session: the error travels in the encrypted bundle (message only, never env).
  await mkdir(OUT, { recursive: true }).catch(() => {});
  await writeFile(join(OUT, "fatal.json"), JSON.stringify({ at: new Date().toISOString(), message, stack: e instanceof Error ? e.stack?.split("\n").slice(0, 6) : null }, null, 2)).catch(() => {});
  process.exit(1);
});
