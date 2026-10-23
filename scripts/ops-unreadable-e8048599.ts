/** Read-only: structure of the last (unreadable) response of e8048599. Letters are masked; only structure is printed. */
import { createClient } from "@supabase/supabase-js";
import { documentaryLedgerScopeFor } from "../src/lib/video/long-form/script-jobs";
const mask = (t: string) => t.replace(/[A-Za-zÀ-ÿ]/g, "a").replace(/[0-9]/g, "9");
async function main() {
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: jobs } = await db.from("documentary_script_jobs").select("*").order("created_at", { ascending: false }).limit(50);
  const j = (jobs ?? []).find((x: any) => String(x.id).startsWith("e8048599")) as any;
  const { data: ops } = await db.from("pi_paid_operations").select("result_ref,created_at,status").eq("project_id", documentaryLedgerScopeFor(j)!).eq("status", "COMMITTED").order("created_at", { ascending: false }).limit(1);
  const f = await db.storage.from("videos").download(ops![0].result_ref);
  const r = JSON.parse(await f.data!.text());
  const blocks = (r.content ?? []).map((b: any) => b.type);
  const text = (r.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text ?? "").join("").trim();
  let err = "", pos = -1;
  try { JSON.parse(text.replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1")); } catch (e: any) { err = String(e.message); pos = Number(err.match(/position (\d+)/)?.[1] ?? -1); }
  const fenceStart = /^```/.test(text), fenceEnd = /```$/.test(text);
  let depth = 0, firstClose = -1;
  for (let i = 0; i < text.length; i++) { const c = text[i]; if (c === "{") depth++; else if (c === "}") { depth--; if (depth === 0 && firstClose < 0) firstClose = i; } }
  console.log("DIAG_UNREADABLE", JSON.stringify({ at: ops![0].created_at, stop: r.stop_reason, out: r.usage?.output_tokens, blocks, len: text.length, fenceStart, fenceEnd, err: err.slice(0, 160), pos,
    around: pos >= 0 ? mask(text.slice(Math.max(0, pos - 120), pos + 120)) : null, head: mask(text.slice(0, 80)), tail: mask(text.slice(-120)), firstTopLevelClose: firstClose,
    afterFirstObject: firstClose >= 0 ? mask(text.slice(firstClose + 1, firstClose + 160)) : null }));
}
main().catch(e => { console.error("FAILED", String(e).slice(0, 300)); process.exitCode = 1; });
