/**
 * FREE, READ-ONLY owner readiness snapshot of PRODUCTION (no writes, no provider calls, no secrets printed, no PII):
 * what Hans's account can use today and which state blocks it. Prints only booleans, counts, statuses and amounts.
 *  - owner accounts (by the two known e-mails): exists / e-mail confirmed;
 *  - recent activity per module (status counts only): Reels/Long Form requests, Podcast episodes, script jobs;
 *  - supply state per provider (pi_supply_state) and policy enabled/caps;
 *  - paid ledger: operations not COMMITTED/RELEASED (open or uncertain) — count and USD by provider;
 *  - recovery budgets / durable resume authorizations (status only).
 */
import { createClient } from "@supabase/supabase-js";
const log = (t: string, v: unknown) => console.log(t, JSON.stringify(v));
async function main() {
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false } });
  // Owner e-mails are given only as sha256 of the lowercased address (no PII in the repository or the logs).
  const { createHash } = await import("node:crypto"); const hashOf = (e: string) => createHash("sha256").update(e.trim().toLowerCase()).digest("hex");
  const emails = (process.env.OWNER_EMAIL_HASHES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const users: { id: string; email?: string; email_confirmed_at?: string | null; last_sign_in_at?: string | null }[] = [];
  for (let page = 1; page <= 20; page++) { const r = await db.auth.admin.listUsers({ page, perPage: 200 }); if (r.error) throw Error("users"); users.push(...r.data.users); if (r.data.users.length < 200) break; }
  const owners = emails.map((e, i) => { const u = users.find((x) => !!x.email && hashOf(x.email) === e); return { owner: `owner#${i + 1}`, exists: !!u, confirmed: !!u?.email_confirmed_at, lastSignIn: u?.last_sign_in_at?.slice(0, 10) ?? null, id: u?.id }; });
  log("OWNER", { totalUsers: users.length, owners: owners.map(({ id, ...o }) => o) });
  const ids = owners.map((o) => o.id).filter(Boolean) as string[];
  const count = (rows: { status?: string }[] | null) => (rows ?? []).reduce((a: Record<string, number>, r) => ((a[r.status ?? "?"] = (a[r.status ?? "?"] ?? 0) + 1), a), {});
  if (ids.length) {
    const vr = await db.from("video_requests").select("status,created_at").in("user_id", ids).order("created_at", { ascending: false }).limit(50);
    log("OWNER", { videoRequests50: count(vr.data), last: vr.data?.[0]?.created_at?.slice(0, 16) ?? null, error: vr.error?.code ?? null });
    const pe = await db.from("podcast_episodes").select("status,created_at").in("user_id", ids).order("created_at", { ascending: false }).limit(50);
    log("OWNER", { podcastEpisodes50: count(pe.data), last: pe.data?.[0]?.created_at?.slice(0, 16) ?? null, error: pe.error?.code ?? null });
    const sj = await db.from("documentary_script_jobs").select("status,created_at").in("user_id", ids).order("created_at", { ascending: false }).limit(50);
    log("OWNER", { scriptJobs50: count(sj.data), last: sj.data?.[0]?.created_at?.slice(0, 16) ?? null, error: sj.error?.code ?? null });
  }
  for (const p of ["elevenlabs", "heygen", "anthropic", "openai", "pexels", "recraft", "runway", "veo"]) {
    const st = await db.rpc("pi_supply_state", { p_provider: p });
    const s = st.data as Record<string, unknown> | null;
    log("SUPPLY", { p, state: s, error: st.error ? `${st.error.code}`.slice(0, 40) : null });
  }
  const pol = await db.from("pi_supply_policies").select("provider,enabled,unit,daily_cap_usd,monthly_cap_usd,max_concurrent,max_daily_calls").order("provider");
  log("POLICY", pol.data ?? pol.error?.code);
  const open = await db.from("pi_paid_operations").select("provider,status,reserved_usd").not("status", "in", "(COMMITTED,RELEASED,REFUNDED)").limit(1000);
  const byP: Record<string, { n: number; usd: number; statuses: Record<string, number> }> = {}; // REFUNDED is terminal (money back): excluded below
  for (const o of open.data ?? []) { const k = o.provider ?? "?"; byP[k] ??= { n: 0, usd: 0, statuses: {} }; byP[k].n++; byP[k].usd = Math.round((byP[k].usd + Number(o.reserved_usd ?? 0)) * 1e4) / 1e4; byP[k].statuses[o.status] = (byP[k].statuses[o.status] ?? 0) + 1; }
  log("LEDGER", { openOrUncertain: open.data?.length ?? null, byProvider: byP, error: open.error?.code ?? null });
  const rb = await db.from("pi_recovery_budgets").select("status,cap_usd,created_at").order("created_at", { ascending: false }).limit(10);
  log("RECOVERY", { budgets: (rb.data ?? []).map((b) => ({ status: b.status, cap: Number(b.cap_usd) })), error: rb.error?.code ?? null });
  const ra = await db.from("pi_recovery_resume_authorizations").select("created_at").limit(20);
  log("RECOVERY", { resumeAuthorizations: ra.data?.length ?? null, error: ra.error?.code ?? null });
}
main().catch((e) => { console.log("FAILED", String(e).slice(0, 300)); process.exitCode = 1; });
