/**
 * Probe (no limit change): which object size the private "videos" bucket accepts today. Uploads zero-filled
 * test objects of increasing size to videos/ops/size-probe/, records accept/reject, deletes every object it
 * created. No provider call.
 */
import { createClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_URL!.trim(), KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
const log = (tag: string, v: unknown) => console.log(tag, JSON.stringify(v));
const db = createClient(URL_, KEY, { auth: { persistSession: false } });
const MiB = 1024 * 1024;

async function main() {
  const { data: bucket } = await db.storage.getBucket("videos");
  log("BUCKET", { public: bucket?.public ?? null, fileSizeLimit: bucket?.file_size_limit ?? null });
  const created: string[] = [];
  try {
    for (const mb of [60, 350, 800, 1300]) {
      const path = `ops/size-probe/${Date.now()}-${mb}mib.bin`;
      const body = Buffer.alloc(mb * MiB);
      const t = Date.now();
      const r = await fetch(`${URL_}/storage/v1/object/videos/${path}`, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, apikey: KEY, "Content-Type": "application/octet-stream", "x-upsert": "false" }, body });
      const text = (await r.text()).slice(0, 200);
      log("UPLOAD", { mib: mb, status: r.status, ok: r.ok, seconds: Math.round((Date.now() - t) / 1000), message: r.ok ? null : text });
      if (r.ok) created.push(path); else break;
    }
  } finally {
    if (created.length) { const { error } = await db.storage.from("videos").remove(created); log("CLEANUP", { removed: created.length, error: error?.message ?? null }); }
  }
}
main().catch((e) => { console.error("FAILED", e instanceof Error ? e.message.slice(0, 200) : "error"); process.exitCode = 1; });
