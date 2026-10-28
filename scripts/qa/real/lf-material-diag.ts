// Read-only diagnosis of the Long Form material preflight for ONE request (closure 2026-10-27): rebuilds the confirmed
// plan's shots and, for the first stock scenes the worker reported missing, prints the visual intent, the queries and
// why each Pexels candidate was rejected. Free searches only; writes nothing; prints no ids or private text beyond the
// visual intents (generic stock descriptions) and the providers' public photo/video descriptions.
import { createClient } from "@supabase/supabase-js";
import { planShotsFromScript } from "@/lib/video/long-form/production-plan";
import { usesAnchoredVisuals, usesVisualIdentity, type ProductionPlan } from "@/lib/video/long-form/production-plan-types";
import { screenCandidate, searchCandidatesStrict, selectionQueries } from "@/lib/video/long-form/stock-selection";
import { getFootageProvider } from "@/lib/providers/footage";

async function main() {
if (process.env.DIAG_SUPPLY) {
  // SOLO LECTURA (SELECT y la función pi_supply_state, sin escrituras). Imprime niveles, contadores y límites numéricos;
  // nunca claves, textos de evidencia (solo presente/ausente), correos ni ids de cuenta (se muestran como hash corto).
  const sdb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { createHash } = await import("node:crypto");
  const redact = (v: unknown) => String(v ?? "").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) => `acct#${createHash("sha256").update(m).digest("hex").slice(0, 6)}`);
  const now = Date.now();
  const { data: pols } = await sdb.from("pi_supply_policies").select("provider,enabled,unit,baseline,unit_cost_usd,daily_forecast,daily_cap_usd,monthly_cap_usd,max_concurrent,max_daily_calls,timezone,evidence,updated_at");
  for (const p of pols ?? []) console.log("policy", JSON.stringify({ ...p, evidence: String(p.evidence ?? "").trim() ? "present" : "absent" }));
  for (const pr of ["__global__", "anthropic", "elevenlabs", "openai", "heygen"]) {
    const { data, error } = await sdb.rpc("pi_supply_state", { p_provider: pr });
    const d = (data ?? {}) as Record<string, unknown>;
    const age = d.checkedAt ? Math.round((now - Date.parse(String(d.checkedAt))) / 3600000) : null;
    console.log("supply", pr, error ? `error ${error.message.slice(0, 80)}` : JSON.stringify({ level: d.level, reason: d.reason, free: d.free, unreserved: d.unreserved, held: d.held, activeCalls: d.activeCalls, todayCalls: d.todayCalls, dailySpend: d.dailySpend, monthlySpend: d.monthlySpend, coverageHours: d.coverageHours, checkedAt: d.checkedAt, ageHours: age }));
  }
  const { data: jobs } = await sdb.from("documentary_script_jobs").select("id,status,stage,retry_count,editorial_rounds,resubmit_allowance,error_message,error_code,failure_kind,created_at,updated_at").eq("request_id", process.env.LF_REQUEST_ID!).order("created_at", { ascending: false }).limit(2);
  console.log("script jobs (by request)", redact(JSON.stringify(jobs)));
  const { data: jobs2 } = await sdb.from("documentary_script_jobs").select("id,request_id,topic,status,stage,retry_count,error_message,created_at,updated_at").gte("created_at", "2026-10-27T00:00:00Z").order("created_at");
  console.log("script jobs today", redact(JSON.stringify((jobs2 ?? []).map((j) => ({ ...j, topic: String(j.topic).slice(0, 40) })))));
  const { data: ops } = await sdb.from("pi_paid_operations").select("project_id,shot_id,status,method,model,reserved_usd,committed_usd,attempt_kind,created_at,updated_at").eq("provider", "anthropic").gte("created_at", "2026-10-27T00:00:00Z").order("created_at");
  const byStatus: Record<string, { n: number; reserved: number; committed: number }> = {};
  for (const o of ops ?? []) { const k = `${o.method}/${o.status}`; byStatus[k] ??= { n: 0, reserved: 0, committed: 0 }; byStatus[k].n++; byStatus[k].reserved += Number(o.reserved_usd ?? 0); byStatus[k].committed += Number(o.committed_usd ?? 0); }
  console.log("anthropic ops today by status", JSON.stringify(byStatus));
  for (const o of (ops ?? []).filter((x) => x.status !== "COMMITTED")) console.log("anthropic non-committed op", redact(JSON.stringify(o)));
  const last = (ops ?? []).slice(-3).map((o) => ({ project: redact(o.project_id).slice(0, 40), status: o.status, reserved_usd: o.reserved_usd, committed_usd: o.committed_usd, created_at: o.created_at, updated_at: o.updated_at }));
  console.log("anthropic last ops", JSON.stringify(last));
  // Avatares listos de la cuenta del dueño: ¿existe su foto fija en cada bucket? (solo sí/no; sin rutas)
  if (process.env.OWNER_ID) {
    const { data: avs } = await sdb.from("avatars").select("id,status,source_photo_path,provider_avatar_id").eq("user_id", process.env.OWNER_ID).eq("status", "ready");
    for (const a of avs ?? []) {
      const p = String(a.source_photo_path ?? ""); const dir = p.split("/").slice(0, -1).join("/"), name = p.split("/").pop() ?? "";
      const exists = async (b: string) => { if (!p) return false; const { data } = await sdb.storage.from(b).list(dir, { search: name, limit: 5 }); return !!data?.some((f) => f.name === name); };
      console.log("avatar", redact(a.id), JSON.stringify({ hasPhotoPath: !!p, ownerPrefix: p.startsWith(`${process.env.OWNER_ID}/`), inAvatarUploads: await exists("avatar-uploads"), inVideos: await exists("videos"), hasProviderAvatar: !!a.provider_avatar_id }));
    }
  }
  // Conciliación Long Form desde el 27-oct: gasto por solicitud (hash) y proveedor/estado; filas abiertas en todo el libro.
  const { data: lfOps } = await sdb.from("pi_paid_operations").select("project_id,provider,status,reserved_usd,committed_usd,created_at").gte("created_at", "2026-10-27T00:00:00Z").not("project_id", "like", "podcast%");
  const per: Record<string, Record<string, { n: number; reserved: number; committed: number }>> = {};
  for (const o of lfOps ?? []) { const k = redact(String(o.project_id)).slice(0, 48); const ks = `${o.provider}/${o.status}`; per[k] ??= {}; per[k][ks] ??= { n: 0, reserved: 0, committed: 0 }; per[k][ks].n++; per[k][ks].reserved += Number(o.reserved_usd ?? 0); per[k][ks].committed += Number(o.committed_usd ?? 0); }
  console.log("lf spend since 10-27 by project", JSON.stringify(per));
  const { data: open } = await sdb.from("pi_paid_operations").select("project_id,provider,status,method,reserved_usd,committed_usd,created_at,updated_at").in("status", ["RECONCILIATION_REQUIRED", "SUBMITTED", "PROVIDER_JOB_RECORDED", "RESERVED"]);
  for (const o of open ?? []) console.log("open op", redact(JSON.stringify(o)));
  const { data: eps } = await sdb.from("podcast_studio_episodes").select("id,title,status,authorized_usd,cost_usd,error,created_at,updated_at").gte("created_at", "2026-10-27T00:00:00Z").order("created_at");
  console.log("podcast studio episodes today", JSON.stringify((eps ?? []).map((e) => ({ ...e, title: String(e.title).slice(0, 34) }))));
  const { data: pops } = await sdb.from("podcast_studio_operations").select("episode_id,provider,op,state,reserved_usd,actual_usd,created_at").gte("created_at", "2026-10-27T00:00:00Z").order("created_at");
  console.log("podcast studio ops today", JSON.stringify(pops));
  return;
}
const max = Number(process.env.DIAG_SHOTS || 6);
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
let id = process.env.LF_REQUEST_ID!;
if (id.startsWith("hash:")) { // same hashing as the reports (sha256 of documentary_script_jobs.request_id)
  const { createHash } = await import("node:crypto");
  const { data: jobs } = await db.from("documentary_script_jobs").select("request_id").order("created_at", { ascending: false }).limit(300);
  const hits = [...new Set((jobs ?? []).map((j) => j.request_id as string).filter(Boolean))].filter((r) => createHash("sha256").update(r).digest("hex").startsWith(id.slice(5)));
  if (hits.length !== 1) throw new Error(`hash reference matched ${hits.length} requests`);
  id = hits[0];
}
const { data: row } = await db.from("video_requests").select("script_json,long_form_production_plan,language").eq("id", id).single();
const plan = row!.long_form_production_plan as ProductionPlan; const script = row!.script_json as { topic: string; beats: never[] };
console.log("plan", { version: plan.version, strategy: plan.strategy, anchored: usesAnchoredVisuals(plan), language: row!.language });
const { shots } = planShotsFromScript(script.beats, script.topic, plan.strategy, usesAnchoredVisuals(plan), usesVisualIdentity(plan));
const provider = getFootageProvider();
let n = 0;
for (const shot of shots as Array<{ id: string; type?: string; anchoredVisual?: never; visualIntent?: string; durationSec?: number }>) {
  const visual = (shot.anchoredVisual ?? { description: shot.visualIntent ?? "", motion: false }) as never;
  const qs = selectionQueries(visual);
  let accepted = false; const rejects: string[] = [];
  for (const [tier, q] of qs.entries()) {
    const cands = await searchCandidatesStrict(provider, q, true, (shot.durationSec ?? 4) + 1.2).catch((e) => { rejects.push(`ERROR ${String(e).slice(0, 80)}`); return []; });
    for (const c of cands) { const s = screenCandidate(visual, c, tier, { footageProvider: provider }); if ("reject" in s) rejects.push(`[q${tier}] ${s.reject.slice(0, 160)}`); else { accepted = true; break; } }
    if (accepted) break;
  }
  if (accepted) continue;
  const v = visual as { subject?: string; description?: string; place?: string };
  if (process.env.DIAG_COMPACT) console.log(`MISS ${shot.id} | type ${shot.type} | subject «${v.subject ?? ""}» | place «${v.place ?? ""}» | desc «${(v.description ?? "").slice(0, 90)}» | best «${(rejects[0] ?? "").replace(/^\[q\d\] /, "").slice(0, 110)}»`);
  else { console.log(`\n== ${shot.id} | intent: ${JSON.stringify(visual).slice(0, 300)}\n   queries: ${JSON.stringify(qs)}`); for (const r of rejects.slice(0, 5)) console.log("   ", r); }
  if (++n >= max) break;
}
console.log(`\nDONE: printed ${n} scene(s) without an accepted candidate (of ${shots.length} planned)`);
}
main().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
