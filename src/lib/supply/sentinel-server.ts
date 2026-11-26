import type { SupabaseClient } from "@supabase/supabase-js";
import { requireCommandCenterAdmin, CommandCenterAccessError, type AuthUser } from "@/lib/command-center/access";
import { buildSentinelOverview, type SentinelInput, type SentinelOperation, type SentinelReservation, type SentinelSnapshot, type SentinelPolicy, type SentinelTelemetry } from "./sentinel";

/** Only existing service-only tables. Bounded pagination must never turn missing rows into zero usage. */
async function allRows<T>(page: (start: number, end: number) => PromiseLike<{ data: T[] | null; error: unknown; count: number | null }>): Promise<T[]> {
  const rows: T[] = []; let expected: number | undefined;
  for (let start = 0; start < 50_000; start += 500) {
    const result = await page(start, start + 499);
    if (result.error || !result.data || !Number.isSafeInteger(result.count) || result.count! < 0 || result.count! > 50_000) throw Error("SENTINEL_HISTORY_UNVERIFIED");
    if (expected !== undefined && expected !== result.count) throw Error("SENTINEL_HISTORY_CHANGED");
    expected = result.count!; rows.push(...result.data);
    if (rows.length === expected) return rows;
    if (result.data.length !== 500 || rows.length > expected) throw Error("SENTINEL_HISTORY_TRUNCATED");
  }
  throw Error("SENTINEL_HISTORY_BOUND_EXCEEDED");
}

export async function readResourceSentinel(service: SupabaseClient, now = Date.now()) {
  if (!Number.isFinite(now)) throw Error("SENTINEL_CLOCK_UNVERIFIED");
  const month = new Date(now); month.setUTCDate(1); month.setUTCHours(0, 0, 0, 0);
  const historySince = new Date(Math.min(month.getTime(), now - 14 * 86_400_000)).toISOString();
  const policies = await service.from("pi_supply_policies").select("provider,enabled,unit,unit_cost_usd,timezone,max_concurrent");
  if (policies.error || !policies.data) throw Error("SENTINEL_POLICIES_UNVERIFIED");
  const configured = policies.data.filter(p => p.provider !== "__global__") as SentinelPolicy[];
  const snapshots: SentinelSnapshot[] = [];
  let complete = true;
  for (const p of configured) {
    const read = await service.from("pi_capacity_snapshots").select("provider,unit,available,derived_estimate,checked_at,reliability,health")
      .eq("provider", p.provider).order("checked_at", { ascending: false }).limit(1).maybeSingle();
    if (read.error) complete = false;
    else if (read.data) snapshots.push(read.data as SentinelSnapshot);
  }
  const [operations, reservations, slots] = await Promise.all([
    allRows<SentinelOperation>((start, end) => service.from("pi_paid_operations")
      .select("idempotency_key,project_id,provider,method,status,reserved_usd,committed_usd,capacity_units,supply_job_key,supply_reconciled,supply_pool,result_ref,created_at,updated_at", { count: "exact" })
      .or(`status.in.(RESERVED,SUBMITTED,PROVIDER_JOB_RECORDED,RECONCILIATION_REQUIRED),and(status.eq.REFUNDED,supply_reconciled.eq.false),updated_at.gte.${historySince}`)
      .order("idempotency_key").range(start, end)).catch(() => { complete = false; return []; }),
    allRows<SentinelReservation>((start, end) => service.from("pi_supply_job_reservations")
      .select("id,project_id,provider,status,reserved_units,consumed_units,reserved_usd,consumed_usd", { count: "exact" })
      .eq("status", "OPEN").order("id").range(start, end)).catch(() => { complete = false; return []; }),
    service.rpc("pi_worker_supply_slots"),
  ]);
  const admission = await Promise.all(configured.map(async p => {
    const result = await service.rpc("pi_supply_state", { p_provider: p.provider });
    const state = result.data as { level?: string; reason?: string } | null;
    const valid = !result.error && state && ["GREEN", "YELLOW", "RED", "UNKNOWN"].includes(state.level ?? "");
    return { provider: p.provider, enabled: p.enabled === true, level: valid ? state!.level! : "UNKNOWN",
      reason: valid && typeof state!.reason === "string" ? state!.reason.slice(0, 180) : "control unavailable" };
  }));
  const telemetry: SentinelTelemetry[] = [];
  const maxWorkers = Number(policies.data.find(p => p.provider === "__global__")?.max_concurrent);
  const active = slots.data?.active;
  if (!slots.error && slots.data?.configured === true && Number.isSafeInteger(active) && active >= 0 && Number.isSafeInteger(maxWorkers) && maxWorkers > 0)
    telemetry.push({ resource: "workers", verified: true, checked_at: new Date(now).toISOString(), used: active, limit: maxWorkers, unit: "workers" });
  // Existing Audio/Podcast ledgers are NOT silently counted as PI. Their cross-product
  // reservations/history need reconciliation; an API wallet can be real while free cash is unknown.
  const uncoveredProviders = ["elevenlabs", "heygen", "anthropic", "openai", "recraft", "flux"];
  const input = { now, policies: configured, snapshots, operations, reservations, ledgerComplete: complete, historySince, telemetry, uncoveredProviders } as SentinelInput;
  const model = buildSentinelOverview(input);
  const accounts = model.accounts.map(account => {
    const guards = admission.filter(g => g.enabled && account.providers.includes(g.provider));
    const operationalLevel = account.level === "RED" || guards.some(g => g.level === "RED") ? "RED"
      : account.level === "GRAY" || !guards.length || guards.some(g => g.level === "UNKNOWN") ? "GRAY"
      : account.level === "AMBER" || guards.some(g => g.level === "YELLOW") ? "AMBER" : "GREEN";
    return { ...account, operationalLevel };
  });
  return {
    sentinel: { ...model, accounts }, admission, timezones: [...new Set(configured.map(p => p.timezone ?? "UTC"))],
    recordedConsumption: { scope: "PI_LEDGER_ONLY_NOT_ALL_PRODUCTS_OR_PROVIDER_INVOICES", accounts:
      buildSentinelOverview({ ...input, uncoveredProviders: [] }).accounts.map(a => ({ account: a.account, unit: a.unit, consumption: a.consumption })) },
    refreshSeconds: 300, observedAt: new Date(now).toISOString(),
    coverage: { ledger: "pi_paid_operations + pi_supply_job_reservations", uncoveredProviders,
      workers: "video_requests only; excludes separate Audio/Podcast workers", gpu: "UNVERIFIED_NO_GPU_QUERY", storage: "UNVERIFIED_NO_QUOTA_QUERY", rateLimits: "provider Retry-After enforced by monitor; remaining request quota unverified" },
    protection: { longForm: "EXISTING_ATOMIC_RPC_WITH_SAFE_WAITS", reels: "EXISTING_ATOMIC_RPC_WITH_SAFE_WAITS",
      audio: "UNCACHED_PAID_AUDIO_PAUSED_PENDING_COMMON_RESERVATION", audiovisual: "EXISTING_PRIVATE_STUDIO_GUARDS_NOT_CERTIFIED_AS_SHARED_PI_POOL" },
    alternativeProviderPolicy: "NO_AUTOMATIC_SUBSTITUTION_WITHOUT_EXISTING_AUTHORIZATION_AND_EQUIVALENCE",
    purchases: "NEVER_AUTOMATIC",
  };
}

/** Auth runs before constructing a service client; never expose provider financial data to other users. */
export async function resourceSentinelResponse(user: AuthUser, deps: { service: () => SupabaseClient; now?: number; env?: Record<string, string | undefined> }) {
  const headers = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache", Vary: "Cookie" };
  try { requireCommandCenterAdmin(user, deps.env); }
  catch (error) { return Response.json({ error: "Resource Sentinel unavailable" }, { status: error instanceof CommandCenterAccessError ? error.status : 403, headers }); }
  try { return Response.json(await readResourceSentinel(deps.service(), deps.now), { headers }); }
  catch { return Response.json({ error: "Resource Sentinel observations unavailable" }, { status: 503, headers }); }
}
