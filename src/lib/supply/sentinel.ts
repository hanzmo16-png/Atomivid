import type { CapacitySnapshot } from "../production-intelligence/capacity/capacity";
import type { PaidOpStatus } from "../production-intelligence/ledger";
import { billingAccountKey, billingAccountProviders, SUPPLY_REFRESH_INTERVAL_MS } from "./billing-account";

type Numeric = number | string | null;
export interface SentinelSnapshot { provider: string; unit: CapacitySnapshot["unit"]; available: Numeric; checked_at: string; reliability: CapacitySnapshot["reliability"]; health: CapacitySnapshot["health"]; derived_estimate?: Numeric }
export interface SentinelPolicy { provider: string; unit: CapacitySnapshot["unit"]; unit_cost_usd: Numeric; enabled?: boolean; timezone?: string }
export interface SentinelOperation { idempotency_key: string; provider: string; status: PaidOpStatus; reserved_usd: Numeric; committed_usd: Numeric; capacity_units: Numeric; created_at: string; updated_at: string; supply_job_key?: string | null; project_id?: string; method?: string; result_ref?: string | null; supply_reconciled?: boolean; supply_pool?: "paid" | "free" }
export interface SentinelReservation { id: string; provider: string; project_id?: string; status: "OPEN" | "RELEASED"; reserved_units: Numeric; consumed_units: Numeric; reserved_usd: Numeric; consumed_usd: Numeric }
export interface SentinelThresholds { redDays: number; amberDays: number; minimumSamples: number; minimumActiveDays: number; minimumHistoryDays: number; bufferRatio: number }
export interface SentinelTelemetry { resource: "gpu" | "storage" | "workers" | "rate_limits"; verified: boolean; checked_at: string; used: Numeric; limit: Numeric; unit: string }
export interface SentinelInput { now: number; policies: SentinelPolicy[]; snapshots: SentinelSnapshot[]; operations: SentinelOperation[]; reservations: SentinelReservation[]; ledgerComplete: boolean; uncoveredProviders?: string[]; historySince: string | null; thresholds?: Partial<SentinelThresholds>; telemetry?: SentinelTelemetry[] }
export interface SentinelConsumption { actualUsd: number | null; estimatedUsd: number | null; actualUnits: number | null; estimatedUnits: number | null }
export interface SentinelAccount { account: string; providers: string[]; enabledProviders: string[]; unit: CapacitySnapshot["unit"] | null; level: "RED" | "AMBER" | "GREEN" | "GRAY"; available: number | null; estimatedAvailable: number | null; staleAvailable: number | null; balanceStatus: "REAL" | "ESTIMATED" | "STALE" | "UNKNOWN"; checkedAt: string | null; held: number | null; consumedSinceSnapshot: number | null; free: number | null; auditStatus: string; consumption: { daily: SentinelConsumption; rolling7d: SentinelConsumption; monthly: SentinelConsumption }; forecast: { confidence: "HIGH" | "LOW" | "NONE"; samples: number; activeDays: number; coveredDays: number; dailyActualUsd: number | null; coverageDays: number | null; target7Units: number | null; target14Units: number | null; topUp7Units: number | null; topUp14Units: number | null; unitTargetsAreEstimates: true }; topUpUrl: string | null }
export interface SentinelOverview { accounts: SentinelAccount[]; totalsByUnit: { unit: string; verifiedAvailable: number | null; free: number | null }[]; resources: { resource: SentinelTelemetry["resource"]; state: "VERIFIED" | "UNKNOWN"; used: number | null; limit: number | null; unit: string | null }[]; accountingScope: "READ_ONLY_NOT_ATOMIC_ADMISSION" }

// Implementation below is pure: caller supplies existing table rows, never credentials or payloads.
const DAY = 86_400_000;
const DEFAULTS: SentinelThresholds = { redDays: 1, amberDays: 3, minimumSamples: 3, minimumActiveDays: 3, minimumHistoryDays: 7, bufferRatio: .15 };
const OFFICIAL: Record<string, string> = { fal: "https://fal.ai/dashboard/billing", elevenlabs: "https://elevenlabs.io/app/subscription", heygen: "https://app.heygen.com/", runway: "https://app.runwayml.com/", anthropic: "https://console.anthropic.com/settings/billing", openai: "https://platform.openai.com/settings/organization/billing/overview" };
const number = (v: Numeric | undefined): number | null => { if (v == null || (typeof v !== "number" && typeof v !== "string") || String(v).trim() === "") return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
const total = (values: (number | null)[]) => { const sum = values.some(x => x === null) ? null : values.reduce<number>((n, x) => n + x!, 0); return sum !== null && Number.isFinite(sum) ? sum : null; };
const date = (v: string) => Date.parse(v);
const providerName = (v: string) => ["elevenlabs", "recraft", "flux", "heygen", "runway", "anthropic", "openai", "luma", "veo", "bfl", "ltx", "beatoven", "pexels", "runpod", "remotion"].includes(v);
const validUnit = (v: unknown): v is CapacitySnapshot["unit"] => ["usd", "credit", "character"].includes(String(v));
const same = (a: unknown, b: unknown) => { const encode = (x: unknown) => JSON.stringify(x, (_key, v: unknown) => typeof v === "number" && !Number.isFinite(v) ? `NONFINITE:${String(v)}` : v); return encode(a) === encode(b); };
function distinct<T extends { provider: string }>(rows: T[], key: (r: T) => string, fields: (r: T) => unknown) {
  const seen = new Map<string, T>(), bad = new Set<string>();
  for (const row of rows) { const id = key(row), old = seen.get(id); if (!id || (old && !same(fields(old), fields(row)))) { bad.add(row.provider); if (old) bad.add(old.provider); } else seen.set(id, row); }
  return { rows: [...seen.values()], bad };
}
/** Existing paid-operation/envelope rows only. This view never admits work or pools SQL locks. */
export function buildSentinelOverview(input: SentinelInput): SentinelOverview {
  const t = { ...DEFAULTS, ...input.thresholds }, now = input.now;
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime()) || Object.values(t).some(x => !Number.isFinite(x)) || t.redDays < 0 || t.amberDays <= t.redDays || t.bufferRatio < 0 || t.bufferRatio > 1 || ![t.minimumSamples, t.minimumActiveDays, t.minimumHistoryDays].every(x => Number.isInteger(x) && x >= 1) || t.minimumHistoryDays > 14 || t.minimumActiveDays > 14) throw new Error("INVALID_SENTINEL_CONFIGURATION");
  const operations = distinct(input.operations, x => x.idempotency_key, x => [x.provider, x.status, x.reserved_usd, x.committed_usd, x.capacity_units, x.updated_at, x.created_at, x.supply_job_key, x.project_id, x.method, x.result_ref, x.supply_reconciled, x.supply_pool]);
  const reservations = distinct(input.reservations, x => x.id, x => [x.provider, x.project_id, x.status, x.reserved_units, x.consumed_units, x.reserved_usd, x.consumed_usd]);
  const policies = distinct(input.policies, x => x.provider, x => [x.unit, x.unit_cost_usd, x.enabled, x.timezone]);
  const groups = [...new Set(policies.rows.filter(x => providerName(x.provider)).map(x => billingAccountKey(x.provider)))];
  const accounts: SentinelAccount[] = groups.map(account => {
    const members = [...billingAccountProviders(account === "fal" ? "recraft" : account)], ps = policies.rows.filter(x => members.includes(x.provider));
    const enabledProviders = ps.filter(x => x.enabled === true).map(x => x.provider);
    const units = [...new Set(ps.map(x => x.unit))], unit = units.length === 1 && validUnit(units[0]) ? units[0] : null;
    const prices = [...new Set(ps.map(x => number(x.unit_cost_usd)))], price = prices.length === 1 && prices[0] !== null && prices[0] > 0 ? prices[0] : null;
    const zones = [...new Set(ps.map(x => x.timezone ?? "UTC"))], zone = zones[0]; let zoneValid = zones.length === 1;
    let formatter: Intl.DateTimeFormat | null = null;
    try { formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }); } catch { zoneValid = false; }
    const parts = (ms: number) => Object.fromEntries((formatter?.formatToParts(ms) ?? []).filter(x => x.type !== "literal").map(x => [x.type, Number(x.value)]));
    const calendar = (ms: number) => { const p = parts(ms); return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`; };
    const boundary = (monthly: boolean) => { const p = parts(now), wall = Date.UTC(p.year, p.month - 1, monthly ? 1 : p.day); let result = wall; for (let i = 0; i < 2; i++) { const q = parts(result); result += wall - Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second); } return result; };
    const today = calendar(now), month = today.slice(0, 7), history = input.historySince ? date(input.historySince) : NaN;
    const historyValid = Number.isFinite(history) && history <= now;

    // supply_pool selects a funded ceiling, not a different physical provider wallet.
    const rows = operations.rows.filter(x => members.includes(x.provider)), jobs = reservations.rows.filter(x => members.includes(x.provider) && x.status === "OPEN");
    const snapshots = input.snapshots.filter(x => members.includes(x.provider)), invalidClock = snapshots.some(x => !Number.isFinite(date(x.checked_at)));
    const newest = Math.max(...snapshots.map(x => date(x.checked_at))), latest = snapshots.filter(x => date(x.checked_at) === newest), s = latest[0];
    const snapshotConflict = latest.some(x => !same([x.unit, number(x.available), x.reliability, x.health], [s?.unit, number(s?.available), s?.reliability, s?.health]));
    const age = now - newest, freshApiEvidence = !!s && !invalidClock && !snapshotConflict && age >= 0 && age <= SUPPLY_REFRESH_INTERVAL_MS && s.reliability === "provider_api" && s.unit === unit;
    const usable = freshApiEvidence && number(s.available) !== null;
    const available = usable ? number(s.available) : null;
    const estimatedAvailable = s && ["manual_entry", "derived_from_ledger"].includes(s.reliability) && age >= 0 && !invalidClock && !snapshotConflict && s.unit === unit ? number(s.derived_estimate ?? s.available) : null;
    const staleAvailable = s?.reliability === "provider_api" && age > SUPPLY_REFRESH_INTERVAL_MS && !invalidClock && !snapshotConflict && s.unit === unit ? number(s.available) : null;
    const balanceStatus = available !== null ? "REAL" as const : staleAvailable !== null ? "STALE" as const : estimatedAvailable !== null ? "ESTIMATED" as const : "UNKNOWN" as const;
    const uncovered = members.some(x => input.uncoveredProviders?.includes(x));
    let bad = uncovered || !input.ledgerComplete || unit === null || !zoneValid || members.some(x => operations.bad.has(x) || reservations.bad.has(x) || policies.bad.has(x)), unresolved = false;
    const toUnits = (usd: number | null, explicit: Numeric | undefined) => unit === "usd" ? usd : number(explicit) ?? (usd !== null && price !== null ? number(usd / price) : null);
    const reservedCash = (r: SentinelOperation) => number(r.reserved_usd) === null ? null : Math.max(number(r.reserved_usd)!, number(r.committed_usd) ?? 0);
    const amount = (r: SentinelOperation, actual: boolean) => toUnits(actual ? number(r.committed_usd) : reservedCash(r), r.capacity_units);
    if (reservations.rows.some(j => members.includes(j.provider) && !["OPEN", "RELEASED"].includes(j.status))) bad = true;
    for (const r of rows) if (!Number.isFinite(date(r.created_at)) || !Number.isFinite(date(r.updated_at)) || date(r.updated_at) > now || date(r.created_at) > now || date(r.updated_at) < date(r.created_at) || number(r.reserved_usd) === null || (r.committed_usd !== null && number(r.committed_usd) === null) || (r.capacity_units !== null && number(r.capacity_units) === null)) bad = true;
    const pending = new Map<string, number[]>(), submitted: (number | null)[] = [], standalone: (number | null)[] = [], envelope: (number | null)[] = [], consumed: (number | null)[] = [];
    for (const j of jobs) { const reserved = number(j.reserved_units), used = number(j.consumed_units), cash = number(j.reserved_usd), spent = number(j.consumed_usd); if (reserved === null || used === null || cash === null || spent === null || used > reserved || spent > cash) bad = true; envelope.push(unit === "usd" ? (cash !== null && spent !== null ? cash - spent : null) : (reserved !== null && used !== null ? reserved - used : null)); }
    for (const r of rows) {
      const legacy = r.method === "capacity_hold", closed = r.status === "COMMITTED" && !legacy && number(r.committed_usd) !== null;
      if (r.status === "REFUNDED" && r.supply_reconciled) continue;
      if (closed) { if (date(r.updated_at) >= newest) consumed.push(amount(r, true)); continue; }
      if (r.status === "COMMITTED" && legacy && date(r.updated_at) < newest) continue;
      if (!["RESERVED", "SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED", "REFUNDED", "COMMITTED"].includes(r.status)) { bad = true; continue; }
      const related = jobs.filter(j => r.supply_job_key ? j.id === r.supply_job_key : !!r.project_id && j.project_id === r.project_id && j.provider === r.provider);
      if (related.length > 1) bad = true;
      const held = legacy ? (/^units:[0-9]+(?:\.[0-9]+)?$/.test(r.result_ref ?? "") ? number(r.result_ref!.slice(6)) : null) : amount(r, false);
      if (legacy && related.length) bad = true; // No evidence that two legacy funding mechanisms are independent.
      if (r.status === "RESERVED" && related.length === 1 && !legacy) { const id = related[0].id, prev = pending.get(id) ?? []; if (held === null) bad = true; else prev.push(held); pending.set(id, prev); }
      else if (r.status === "RESERVED" || legacy) standalone.push(held);
      else { unresolved = true; submitted.push(held); }
    }
    for (let i = 0; i < jobs.length; i++) envelope[i] = envelope[i] === null ? null : Math.max(envelope[i]!, total(pending.get(jobs[i].id) ?? []) ?? 0);
    const held = total([...envelope, ...standalone, ...submitted]), consumedSince = total(consumed);
    if (held === null || consumedSince === null || !Number.isFinite(held + consumedSince)) bad = true;
    const free = !bad && available !== null ? Math.max(0, available - held! - consumedSince!) : null;
    const period = (accept: (ms: number) => boolean, start: number): SentinelConsumption => {
      if (bad || !historyValid || history > start) return { actualUsd: null, estimatedUsd: null, actualUnits: null, estimatedUnits: null };
      const eligible = rows.filter(r => r.method !== "capacity_hold" && accept(date(r.updated_at)) && !(r.status === "REFUNDED" && r.supply_reconciled));
      const actual = eligible.filter(r => r.status === "COMMITTED" && number(r.committed_usd) !== null), estimates = eligible.filter(r => !actual.includes(r) && r.status !== "RESERVED");
      const usd = total(actual.map(r => number(r.committed_usd)));
      return { actualUsd: usd, estimatedUsd: total(estimates.map(reservedCash)), actualUnits: unit === "usd" ? usd : null, estimatedUnits: unit === "usd" ? total(estimates.map(reservedCash)) : total([...actual, ...estimates].map(r => amount(r, r.status === "COMMITTED" && number(r.committed_usd) !== null))) };
    };
    const consumption = { daily: period(ms => calendar(ms) === today, boundary(false)), rolling7d: period(ms => ms >= now - 7 * DAY && ms <= now, now - 7 * DAY), monthly: period(ms => calendar(ms).slice(0, 7) === month, boundary(true)) };
    const earliest = Math.min(...rows.flatMap(r => [date(r.created_at), date(r.updated_at)]).filter(Number.isFinite));
    const observedSince = Math.max(history, earliest), coveredDays = !bad && historyValid && Number.isFinite(observedSince) ? Math.min(14, Math.floor((now - observedSince) / DAY)) : 0;
    const samples = bad ? [] : rows.filter(r => r.method !== "capacity_hold" && r.status === "COMMITTED" && number(r.committed_usd) !== null && date(r.updated_at) >= Math.max(history, now - 14 * DAY) && date(r.updated_at) <= now);
    const activeDays = new Set(samples.map(r => calendar(date(r.updated_at)))).size, sum = total(samples.map(r => number(r.committed_usd)));
    const confidence = samples.length >= t.minimumSamples && activeDays >= t.minimumActiveDays && coveredDays >= t.minimumHistoryDays ? "HIGH" : samples.length ? "LOW" : "NONE";
    const daily = !bad && coveredDays > 0 && sum !== null ? sum / coveredDays : null, dailyUnits = unit === "usd" ? daily : daily !== null && price !== null ? number(daily / price) : null;
    const forecastable = confidence === "HIGH" && !unresolved && dailyUnits !== null && dailyUnits > 0;
    const coverage = forecastable && free !== null ? number(free / dailyUnits!) : null, target = (days: number) => forecastable ? number(dailyUnits! * days * (1 + t.bufferRatio)) : null;
    const seven = target(7), fourteen = target(14);
    let auditStatus = uncovered ? "CROSS_PRODUCT_LEDGER_COVERAGE_UNVERIFIED" : !enabledProviders.length ? "POLICY_DISABLED_OR_UNVERIFIED" : bad ? "LEDGER_OR_POLICY_UNVERIFIED" : snapshotConflict ? "SIMULTANEOUS_SNAPSHOT_CONFLICT" : !usable ? "BALANCE_UNVERIFIED_OR_STALE" : unresolved ? "UNRESOLVED_CHARGES" : unit !== "usd" ? "UNIT_CONSUMPTION_ESTIMATED" : "VERIFIED_LEDGER_ADJUSTMENT";
    if (invalidClock && !uncovered) auditStatus = "INVALID_SNAPSHOT_TIME";
    const verifiedCritical = freshApiEvidence && (available === 0 || s?.health === "DOWN");
    const level = verifiedCritical ? "RED" : !enabledProviders.length || available === null || bad || unresolved || !["OK", "DEGRADED", "DOWN"].includes(s?.health ?? "") ? "GRAY" : s?.health === "DOWN" || free === 0 || (coverage !== null && coverage <= t.redDays) ? "RED" : coverage === null ? "GRAY" : s?.health === "DEGRADED" || coverage <= t.amberDays ? "AMBER" : "GREEN";
    return { account, providers: members, enabledProviders, unit, level, available, estimatedAvailable, staleAvailable, balanceStatus, checkedAt: Number.isFinite(newest) ? new Date(newest).toISOString() : null, held: bad ? null : held, consumedSinceSnapshot: bad ? null : consumedSince, free, auditStatus, consumption,
      forecast: { confidence, samples: samples.length, activeDays, coveredDays, dailyActualUsd: daily, coverageDays: coverage, target7Units: seven, target14Units: fourteen, topUp7Units: seven !== null && free !== null ? Math.max(0, seven - free) : null, topUp14Units: fourteen !== null && free !== null ? Math.max(0, fourteen - free) : null, unitTargetsAreEstimates: true }, topUpUrl: OFFICIAL[account] ?? null };
  });
  const resources = (["gpu", "storage", "workers", "rate_limits"] as const).map(resource => {
    const rows = (input.telemetry ?? []).filter(x => x.resource === resource).sort((a, b) => date(b.checked_at) - date(a.checked_at)), r = rows[0];
    const usable = !rows.some(x => !Number.isFinite(date(x.checked_at))) && r?.verified === true && now - date(r.checked_at) >= 0 && now - date(r.checked_at) <= SUPPLY_REFRESH_INTERVAL_MS && number(r.used) !== null && number(r.limit) !== null && ["bytes", "gb", "gib", "mb", "slots", "workers", "requests/min", "requests", "percent"].includes(r.unit) && !rows.some(x => x.checked_at === r.checked_at && !same([x.used, x.limit, x.unit, x.verified], [r.used, r.limit, r.unit, r.verified]));
    return { resource, state: usable ? "VERIFIED" as const : "UNKNOWN" as const, used: usable ? number(r.used) : null, limit: usable ? number(r.limit) : null, unit: usable ? r.unit : null };
  });
  const totalsByUnit = [...new Set(accounts.map(x => x.unit).filter((x): x is CapacitySnapshot["unit"] => x !== null))].map(unit => ({ unit, verifiedAvailable: total(accounts.filter(x => x.unit === unit).map(x => x.available)), free: total(accounts.filter(x => x.unit === unit).map(x => x.free)) }));
  return { accounts, totalsByUnit, resources, accountingScope: "READ_ONLY_NOT_ATOMIC_ADMISSION" };
}
