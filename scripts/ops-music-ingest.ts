/**
 * PREPARED, NOT RUN — ingest of the two CC BY 4.0 epic tracks (Silverman Sound / Shane Ivers) into the private
 * `music-library` bucket. No provider spend (free downloads); it DOES write to production Storage, so it needs
 * CONFIRM=MUSIC-INGEST-SILVERMAN. DRY=1 downloads and validates only (no Storage write).
 * Checks per track: HTTP 200, audio/mpeg-ish payload (ID3 or MPEG frame sync), 1–15 MB, duration 90–200 s (ffprobe when
 * present), sha256 logged; refuses to overwrite an existing object (upsert:false) and verifies it reads back identical.
 * Only after this succeeds may the manifest entries (content/music/pending-epic-tracks.json in PR #199) be merged.
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const log = (t: string, v: unknown) => console.log(t, JSON.stringify(v));
const TRACKS = [
  { path: "silverman-passage-of-arms.mp3", url: "https://www.silvermansound.com/wp-content/uploads/passage-of-arms.mp3" },
  { path: "silverman-the-fall-of-heroes.mp3", url: "https://www.silvermansound.com/wp-content/uploads/the-fall-of-heroes.mp3" },
];
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
function looksMp3(b: Buffer) { return b.subarray(0, 3).toString("latin1") === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0); }
function durationSec(file: string): number | null {
  try { return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim()); } catch { return null; }
}
async function main() {
  const dry = process.env.DRY === "1";
  if (!dry && process.env.CONFIRM !== "MUSIC-INGEST-SILVERMAN") throw Error("confirmation missing");
  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  for (const t of TRACKS) {
    const res = await fetch(t.url);
    const buf = Buffer.from(await res.arrayBuffer());
    const tmp = `/tmp/${t.path}`; await writeFile(tmp, buf);
    const dur = durationSec(tmp);
    const ok = res.ok && looksMp3(buf) && buf.length > 1e6 && buf.length < 15e6 && (dur === null || (dur >= 90 && dur <= 200));
    const { data: existing } = await db.storage.from("music-library").list("", { search: t.path });
    const already = (existing ?? []).some((o) => o.name === t.path);
    log("MUSIC", { path: t.path, http: res.status, bytes: buf.length, mp3: looksMp3(buf), durationSec: dur, sha256: sha(buf), already, ok });
    if (!ok) throw Error(`validation failed for ${t.path}`);
    if (dry || already) continue;
    const up = await db.storage.from("music-library").upload(t.path, buf, { contentType: "audio/mpeg", upsert: false });
    if (up.error) throw Error(`upload ${t.path}: ${up.error.message}`);
    const back = await db.storage.from("music-library").download(t.path);
    const same = back.data ? sha(Buffer.from(await back.data.arrayBuffer())) === sha(buf) : false;
    log("MUSIC", { path: t.path, uploaded: true, readBackIdentical: same });
    if (!same) throw Error(`read-back mismatch ${t.path}`);
  }
  log("END", { dry });
}
main().catch((e) => { console.log("FAILED", String(e).slice(0, 300)); process.exitCode = 1; });
