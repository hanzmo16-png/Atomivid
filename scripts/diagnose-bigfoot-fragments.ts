/** Read-only: structure of the Bigfoot writer responses (no provider, no writes, no content).
 * For every saved writer response: stop reason, output tokens, each top-level object's fragment kind,
 * and for plan fragments the schema issue codes/paths (enum labels only when they look like labels). */
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { documentarySupplyScope } from "../src/lib/supply/anthropic";
import { EDITORIAL_VERSION } from "../src/lib/video/long-form/editorial";
import { RESEARCH_VERSION } from "../src/lib/video/long-form/research";
import { PlanFragmentSchema, BeatFragmentSchema } from "../src/lib/video/long-form/documentary-script";
import { topLevelObjects } from "../src/lib/video/long-form/narrative-fragments";

const JOB_ID = "03738404-02ce-440a-a588-cb51ae4a0e9f";
const at = (v: unknown, p: PropertyKey[]) => p.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<PropertyKey, unknown>)[k] : undefined), v);
const shape = (v: unknown) => v === null ? "null" : Array.isArray(v) ? `array(${v.length})` : typeof v === "string" ? `string(${v.length})` : typeof v === "object" ? `object{${Object.keys(v as object).sort().join(",")}}` : typeof v;
async function main() {
  if (process.env.ANTHROPIC_API_KEY) throw Error("provider key present");
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: job } = await db.from("documentary_script_jobs").select("*").eq("id", JOB_ID).single();
  const f = job!.input.fields;
  const projectId = documentarySupplyScope(job!.user_id, { ...f, editorialVersion: EDITORIAL_VERSION, researchVersion: RESEARCH_VERSION, creativeHistory: job!.input.creativeHistory,
    ...(job!.input.referenceContract ? { referenceContract: job!.input.referenceContract } : {}) }, false).projectId;
  const { data: ops } = await db.from("pi_paid_operations").select("idempotency_key,status,result_ref,created_at").eq("project_id", projectId).order("created_at");
  for (const [i, o] of (ops ?? []).entries()) {
    if (o.status !== "COMMITTED" || !o.result_ref) continue;
    const file = await db.storage.from("videos").download(o.result_ref);
    const r = JSON.parse(await file.data!.text());
    const text = (r.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text?: string }) => b.text ?? "").join("");
    const objs = topLevelObjects(text);
    const frags = objs.map((raw) => {
      let v: unknown; try { v = JSON.parse(raw); } catch { return { kind: "unparseable", chars: raw.length }; }
      const kind = (v as { fragment?: unknown })?.fragment;
      if (kind === "plan") {
        const p = PlanFragmentSchema.safeParse(v);
        return { kind: "plan", valid: p.success, top: shape(v), issues: p.success ? [] : p.error.issues.slice(0, 15).map((x) => {
          const got = at(v, x.path as PropertyKey[]);
          return { code: x.code, path: x.path.map(String).join("."), got: shape(got), label: x.code === "invalid_value" && typeof got === "string" && /^[A-Za-z_ -]{1,40}$/.test(got) ? got : undefined,
            allowed: (x as { values?: unknown[] }).values, max: (x as { maximum?: unknown }).maximum, min: (x as { minimum?: unknown }).minimum };
        }) };
      }
      if (kind === "beat") { const b = BeatFragmentSchema.safeParse(v); return { kind: "beat", index: (v as { index?: unknown }).index, valid: b.success, issues: b.success ? [] : b.error.issues.slice(0, 5).map((x) => `${x.code}@${x.path.join(".")}`) }; }
      return { kind: String(kind ?? "none"), top: shape(v) };
    });
    console.log("OP", JSON.stringify({ index: i, key: createHash("sha256").update(o.idempotency_key).digest("hex").slice(0, 10), created: o.created_at, stop: r.stop_reason, out: r.usage?.output_tokens,
      textChars: text.length, objects: objs.length, fragments: frags.length ? frags : undefined }));
  }
}
main().catch((e) => { console.error("diagnostic failed", e instanceof Error ? e.message.slice(0, 120) : ""); process.exitCode = 1; });
