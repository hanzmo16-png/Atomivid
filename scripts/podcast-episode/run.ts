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

const modes: Record<string, () => Promise<void>> = { keygen, "verify-rate": verifyRate, inspect, "store-docs": storeDocs };
const mode = process.argv[2] ?? "";
(modes[mode] ?? (async () => { throw Error(`unknown step ${mode}`); }))().catch((e) => { console.error("STEP_FAILED", e instanceof Error ? e.message.slice(0, 200) : "error"); process.exitCode = 1; });
