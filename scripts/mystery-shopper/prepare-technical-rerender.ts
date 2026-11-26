/** Root-reviewed QA insert only; no render, reserve, script generation, confirmation or original update. */
import { createClient } from "@supabase/supabase-js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SOURCE_ID, ANCHOR_ID, prepareTechnicalRerender, verifiedReview, snapshotSha } from "./technical-long-form-rerender";

async function main() {
  const e = process.env;
  const operation = e.MS_TECHNICAL_OPERATION ?? "review";
  if (process.argv.length !== 2 || !["review", "apply"].includes(operation) || !e.MS_NEW_REQUEST_ID || !e.MS_OUT_DIR) throw Error("review inputs required");
  if (operation === "apply" && (!e.GITHUB_RUN_ID || !/^mystery-shopper\/v3\/receipts\/technical-rerender-review-\d+\.json$/.test(e.MS_REVIEW_RECEIPT ?? "") || !/^[0-9a-f]{64}$/.test(e.MS_ACCEPTED_REVIEW_SHA ?? ""))) throw Error("root-reviewed receipt required");
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
    if (operation === "apply") {
      const prior = await service.storage.from("videos").download(e.MS_REVIEW_RECEIPT!);
      if (prior.error) throw Error("review receipt unavailable");
      verifiedReview(plan, JSON.parse(await prior.data.text()), e.MS_ACCEPTED_REVIEW_SHA!);
      // Sole application mutation: one INSERT, no upsert, UPDATE, RPC, dispatch, reserve or confirmation.
      const insert = await service.from("video_requests").insert(plan.payload).select("id,user_id,status,mode,duration_seconds,render_attempts,script_json,long_form_confirmed_at,long_form_production_plan,video_path").single();
      if (insert.error || insert.data.id !== e.MS_NEW_REQUEST_ID || insert.data.user_id !== login.data.user.id || insert.data.status !== "script_ready" || insert.data.mode !== "long_form" || insert.data.duration_seconds !== 180 || insert.data.render_attempts !== 0 || insert.data.long_form_confirmed_at || insert.data.long_form_production_plan || insert.data.video_path || snapshotSha(insert.data.script_json) !== plan.provenance.sourceScriptSha256) throw Error("insert verification unavailable; never retry automatically");
      if (!e.GITHUB_RUN_ID) throw Error("private insert receipt requires workflow identity");
      const saved = await service.storage.from("videos").upload(`mystery-shopper/v3/receipts/technical-rerender-insert-${e.GITHUB_RUN_ID}.json`, JSON.stringify({ ...plan.provenance, reviewSha256: plan.reviewSha256, sourceReviewReceipt: e.MS_REVIEW_RECEIPT, inserted: true, confirmed: false, renderStarted: false }), { contentType: "application/json", upsert: false });
      if (saved.error) throw Error("insert receipt unavailable; never retry automatically");
      console.log("New QA row inserted from exact reviewed real source. No confirmation, reservation or generation.");
      return;
    }
    await mkdir(e.MS_OUT_DIR, { recursive: true, mode: 0o700 });
    await writeFile(path.join(e.MS_OUT_DIR, "technical-rerender-review.json"), JSON.stringify(plan, null, 2), { mode: 0o600, flag: "wx" });
    if (e.GITHUB_RUN_ID) {
      const receipt = await service.storage.from("videos").upload(`mystery-shopper/v3/receipts/technical-rerender-review-${e.GITHUB_RUN_ID}.json`, JSON.stringify(plan), { contentType: "application/json", upsert: false });
      if (receipt.error) throw Error("private review receipt unavailable");
    }
    console.log("Private review plan prepared. No QA row inserted or provider called. Root review required before execution.");
  } finally { await auth.auth.signOut({ scope: "local" }); }
}
main().catch(() => { console.error("Technical rerender preparation blocked; private details withheld."); process.exitCode = 1; });
