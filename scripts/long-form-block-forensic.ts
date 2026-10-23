/** Read-only forensic of the visual-plan responses of one job: shape of every scene, anchor validity per block. */
import { createClient } from "@supabase/supabase-js";
import { documentaryLedgerScopeFor } from "../src/lib/video/long-form/script-jobs";
import { narrationCatalog } from "../src/lib/video/long-form/narration-catalog";
import { extractJsonDocument } from "../src/lib/video/long-form/response-normalizer";
const log = (t: string, v: unknown) => console.log(t, JSON.stringify(v));
async function main() {
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: jobs } = await db.from("documentary_script_jobs").select("*").order("created_at", { ascending: false }).limit(50);
  const j = (jobs ?? []).find((x: any) => String(x.id).startsWith(process.env.JOB ?? "e8048599")) as any;
  const beats = j.editorial_checkpoint.script.beats as { narration: string }[];
  const catalog = narrationCatalog(beats);
  log("DIAG_BEATS", beats.map((b, i) => ({ i, words: b.narration.split(/\s+/).length, excerpts: catalog.filter(e => e.beatIndex === i).length })));
  const { data: ops } = await db.from("pi_paid_operations").select("status,result_ref,created_at").eq("project_id", documentaryLedgerScopeFor(j)).eq("status", "COMMITTED").order("created_at");
  let block = 0;
  for (const o of ops ?? []) {
    const f = await db.storage.from("videos").download(o.result_ref); if (!f.data) continue;
    const r = JSON.parse(await f.data.text());
    const text = (r.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text ?? "").join("").trim();
    let v: any; try { v = extractJsonDocument(text); } catch { log("DIAG_UNREADABLE", { at: o.created_at, len: text.length, stop: r.stop_reason }); continue; }
    if (!Array.isArray(v?.visuals)) { if (v && (v.index !== undefined || v.replacements)) log("DIAG_REPAIR", { at: o.created_at, keys: Object.keys(v), out: r.usage?.output_tokens, stop: r.stop_reason }); continue; }
    const ids = v.visuals.map((s: any) => s?.excerptId);
    const beatOf = (id: string) => catalog.find(e => e.id === id)?.beatIndex;
    const beatsHit = [...new Set(ids.filter((x: any) => typeof x === "string").map(beatOf))];
    const positions = ids.map((id: any) => catalog.findIndex(e => e.id === id));
    log("DIAG_BLOCK", { n: ++block, at: o.created_at, stop: r.stop_reason, out: r.usage?.output_tokens, scenes: v.visuals.length, beatsHit, positions,
      dupIds: ids.length - new Set(ids).size,
      odd: v.visuals.flatMap((s: any, i: number) => {
        const keys = Object.keys(s ?? {});
        if (keys.includes("description") && typeof s.description === "string") return [];
        return [{ i, keys: keys.map(k => /^[A-Za-z_]{1,40}$/.test(k) ? k : "(non-label)"),
          values: keys.map(k => { const x = s[k]; const t = typeof x;
            return t === "string" ? { len: x.length, looksJson: /^\s*[{[]/.test(x), parsedKeys: (() => { try { const p = JSON.parse(x); return p && typeof p === "object" ? Object.keys(p).slice(0, 15) : null; } catch { return null; } })(),
              words: x.split(/\s+/).length, hasExcerptRef: /:b\d+:w\d+/.test(x) } : t }) }];
      }) });
  }
}
main().catch(e => { console.error("FAILED", String(e).slice(0, 200)); process.exitCode = 1; });
