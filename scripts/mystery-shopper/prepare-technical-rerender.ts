/** Review-only: no insert, render, budget mutation, script generation or original update exists in this helper. */
import { createClient } from "@supabase/supabase-js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SOURCE_ID, ANCHOR_ID, prepareTechnicalRerender } from "./technical-long-form-rerender";

async function main() {
  const e = process.env;
  if (process.argv.length !== 2 || !e.MS_NEW_REQUEST_ID || !e.MS_OUT_DIR) throw Error("review inputs required");
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const service = createClient(e.NEXT_PUBLIC_SUPABASE_URL!, e.SUPABASE_SERVICE_ROLE_KEY!, options);
  const auth = createClient(e.NEXT_PUBLIC_SUPABASE_URL!, e.SUPABASE_SERVICE_ROLE_KEY!, options);
  const login = await auth.auth.signInWithPassword({ email: e.MYSTERY_SHOPPER_QA_EMAIL!, password: e.MYSTERY_SHOPPER_QA_PASSWORD! });
  if (login.error || !login.data.user?.email_confirmed_at) throw Error("QA authentication required");
  try {
    const bucket = await service.storage.getBucket("videos");
    if (bucket.error || bucket.data.public !== false) throw Error("private evidence required");
    const [source, anchor, duplicate, output] = await Promise.all([
      service.from("video_requests").select("id,user_id,status,mode,duration_seconds,render_attempts,language,style,aspect_ratio,topic,script_json,video_path").eq("id", SOURCE_ID).single(),
      service.from("video_requests").select("user_id").eq("id", ANCHOR_ID).single(),
      service.from("video_requests").select("id").eq("id", e.MS_NEW_REQUEST_ID).maybeSingle(),
      service.storage.from("videos").download(`${SOURCE_ID}/state/output.json`),
    ]);
    if (source.error || anchor.error || duplicate.error || duplicate.data || output.error) throw Error("source read or new identity unavailable");
    const plan = prepareTechnicalRerender(source.data, JSON.parse(await output.data.text()), login.data.user.id, anchor.data.user_id, e.MS_NEW_REQUEST_ID);
    await mkdir(e.MS_OUT_DIR, { recursive: true, mode: 0o700 });
    await writeFile(path.join(e.MS_OUT_DIR, "technical-rerender-review.json"), JSON.stringify(plan, null, 2), { mode: 0o600, flag: "wx" });
    if (e.GITHUB_RUN_ID) {
      const receipt = await service.storage.from("videos").upload(`mystery-shopper/v3/receipts/technical-rerender-review-${e.GITHUB_RUN_ID}.json`, JSON.stringify(plan), { contentType: "application/json", upsert: false });
      if (receipt.error) throw Error("private review receipt unavailable");
    }
    console.log("Private review plan prepared. No QA row inserted or provider called. Root review required before execution.");
  } finally { await auth.auth.signOut(); }
}
main().catch(() => { console.error("Technical rerender preparation blocked; private details withheld."); process.exitCode = 1; });
