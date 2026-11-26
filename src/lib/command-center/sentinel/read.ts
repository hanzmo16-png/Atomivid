import { SENTINEL_CONTRACT_VERSION, type BalanceSource, type SentinelHealth, type SentinelLevel, type SentinelProvider, type SentinelSnapshot, type SentinelUnit } from "./contract";

/**
 * Lector de SOLO LECTURA que llena el contrato Sentinel con las tablas que ya existen. No llama a proveedores,
 * no escribe en ninguna tabla y no reimplementa el motor: el semáforo, el saldo libre y la cobertura salen
 * de `pi_supply_state` tal cual. Quien lo llame debe haber verificado OWNER/ADMIN.
 */

/** Una lectura de la API del proveedor deja de ser vigente para el panel a las 24 h; la manual persiste (política existente). */
export const API_BALANCE_MAX_AGE_MS = 24 * 3600_000;
const OPEN = new Set(["SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED"]);
const UNITS = new Set(["usd", "credit", "character"]);
const HEALTH = new Set(["OK", "DEGRADED", "DOWN", "UNCHECKED"]);
const LEVELS = new Set(["GREEN", "YELLOW", "RED", "UNKNOWN"]);
const DEFAULT_TZ = "America/Cancun";

type Row = Record<string, unknown>;
type Result<T> = { data: T | null; error: unknown };
/** Subconjunto de supabase-js que usa este lector (solo select y rpc de lectura). */
export type SentinelDb = {
  from(table: string): {
    select(cols: string): {
      neq(col: string, v: unknown): PromiseLike<Result<Row[]>>;
      gte(col: string, v: unknown): { order(col: string, o: { ascending: boolean }): { limit(n: number): PromiseLike<Result<Row[]>> } };
      order(col: string, o: { ascending: boolean }): { limit(n: number): PromiseLike<Result<Row[]>> };
    };
  };
  rpc(fn: string, args: Row): PromiseLike<Result<unknown>>;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Inicio del día (o del mes) local de `tz` en UTC, sin dependencias: usa el desfase real de esa zona en `now`. */
export function startOf(kind: "day" | "month", now: Date, tz: string): Date {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(now).filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offset = localAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(parts.year, parts.month - 1, kind === "day" ? parts.day : 1) - offset);
}

/** Importe que cuenta como consumo, igual que pi_supply_state: excluye reservas sin enviar y reembolsos conciliados. */
function spend(op: Row): number | null {
  if (op.method === "capacity_hold") return null;
  if (op.status === "RESERVED") return null;
  if (op.status === "REFUNDED" && op.supply_reconciled === true) return null;
  return Math.max(num(op.reserved_usd) ?? 0, num(op.committed_usd) ?? 0);
}

export async function readSentinelSnapshot(db: SentinelDb, now: Date = new Date()): Promise<SentinelSnapshot> {
  const errors: string[] = [];
  const generatedAt = now.toISOString();
  const policiesRes = await db.from("pi_supply_policies").select("provider,enabled,unit,daily_cap_usd,monthly_cap_usd,timezone").neq("provider", "__global__");
  if (policiesRes.error || !Array.isArray(policiesRes.data)) {
    return { version: SENTINEL_CONTRACT_VERSION, generatedAt, timezone: DEFAULT_TZ, source: "existing-supply-tables", providers: [], errors: ["pi_supply_policies unavailable"] };
  }
  const policies = policiesRes.data;
  const tz = String(policies.find((p) => typeof p.timezone === "string" && p.timezone)?.timezone ?? DEFAULT_TZ);
  const monthStart = startOf("month", now, tz);
  const weekStart = new Date(now.getTime() - 7 * 24 * 3600_000);
  const since = new Date(Math.min(monthStart.getTime(), weekStart.getTime()));
  const dayStart = startOf("day", now, tz);

  const [snapsRes, opsRes, openRes, alertsRes] = await Promise.all([
    db.from("pi_capacity_snapshots").select("provider,unit,available,health,reliability,checked_at").order("checked_at", { ascending: false }).limit(500),
    db.from("pi_paid_operations").select("provider,method,status,reserved_usd,committed_usd,supply_reconciled,created_at").gte("created_at", since.toISOString()).order("created_at", { ascending: false }).limit(20_000),
    db.from("pi_paid_operations").select("provider,method,status,reserved_usd,committed_usd").gte("created_at", new Date(now.getTime() - 90 * 24 * 3600_000).toISOString()).order("created_at", { ascending: false }).limit(20_000),
    db.from("pi_supply_alerts").select("provider,created_at").gte("created_at", weekStart.toISOString()).order("created_at", { ascending: false }).limit(1000),
  ]);
  const snaps = snapsRes.error || !Array.isArray(snapsRes.data) ? null : snapsRes.data;
  const ops = opsRes.error || !Array.isArray(opsRes.data) ? null : opsRes.data;
  const open = openRes.error || !Array.isArray(openRes.data) ? null : openRes.data.filter((o) => o.method !== "capacity_hold" && OPEN.has(String(o.status)));
  const alerts = alertsRes.error || !Array.isArray(alertsRes.data) ? null : alertsRes.data;
  if (!snaps) errors.push("pi_capacity_snapshots unavailable");
  if (!ops) errors.push("pi_paid_operations unavailable");
  if (!alerts) errors.push("pi_supply_alerts unavailable");

  const names = new Set<string>(policies.map((p) => String(p.provider)));
  for (const s of snaps ?? []) if (typeof s.provider === "string" && s.provider !== "__global__") names.add(s.provider);

  const providers = await Promise.all([...names].sort().map(async (provider): Promise<SentinelProvider> => {
    const policy = policies.find((p) => p.provider === provider) ?? null;
    const policyUnit = policy && UNITS.has(String(policy.unit)) ? (policy.unit as SentinelUnit) : null;
    const snap = (snaps ?? []).find((s) => s.provider === provider && (!policyUnit || s.unit === policyUnit)) ?? null;
    const unit = policyUnit ?? (snap && UNITS.has(String(snap.unit)) ? (snap.unit as SentinelUnit) : null);

    // Saldo: solo lecturas del proveedor o registro manual, no negativas y no futuras. La API caduca a las 24 h.
    const reliability = snap?.reliability;
    const source: BalanceSource | null = reliability === "provider_api" || reliability === "manual_entry" ? reliability : null;
    const checkedAt = typeof snap?.checked_at === "string" ? snap.checked_at : null;
    const age = checkedAt ? now.getTime() - Date.parse(checkedAt) : NaN;
    const available = num(snap?.available);
    const plausible = source !== null && available !== null && available >= 0 && Number.isFinite(age) && age >= -60_000;
    const fresh = plausible && (source === "manual_entry" || age <= API_BALANCE_MAX_AGE_MS);
    const balance = {
      value: fresh ? available : null, checkedAt, source, stale: plausible && !fresh,
      health: snap && HEALTH.has(String(snap.health)) ? (snap.health as SentinelHealth) : null,
    };

    // Semáforo, saldo libre y cobertura: los decide el motor existente (pi_supply_state); si falla, DESCONOCIDO.
    let level: SentinelLevel = "UNKNOWN"; let reason = "control unavailable"; let free: number | null = null; let coverageHours: number | null = null;
    if (policy) {
      const st = await db.rpc("pi_supply_state", { p_provider: provider }).then((r) => r, () => ({ data: null, error: true }));
      const s = !st.error && st.data && typeof st.data === "object" ? (st.data as Row) : null;
      if (s) {
        level = LEVELS.has(String(s.level)) ? (s.level as SentinelLevel) : "UNKNOWN";
        reason = typeof s.reason === "string" ? s.reason : String(level);
        if (level !== "UNKNOWN") { free = num(s.free); coverageHours = num(s.coverageHours); }
      } else errors.push(`pi_supply_state ${provider} unavailable`);
    } else reason = "policy unconfigured";

    const mine = ops?.filter((o) => o.provider === provider) ?? null;
    const sum = (from: Date) => mine ? mine.reduce((t, o) => { const v = spend(o); return v !== null && Date.parse(String(o.created_at)) >= from.getTime() ? t + v : t; }, 0) : null;
    const consumptionUsd = { day: sum(dayStart), week: sum(weekStart), month: sum(monthStart) };
    const openMine = open?.filter((o) => o.provider === provider) ?? null;
    const committedUsd = openMine ? openMine.reduce((t, o) => t + Math.max(num(o.reserved_usd) ?? 0, num(o.committed_usd) ?? 0), 0) : null;

    // Autonomía: la del motor si la certifica; si no, saldo USD vigente libre de lo comprometido ÷ consumo medio de 7 días.
    let autonomy: SentinelProvider["autonomy"] = { days: null, basis: null };
    if (coverageHours !== null) autonomy = { days: coverageHours / 24, basis: "engine" };
    else if (unit === "usd" && balance.value !== null && committedUsd !== null && consumptionUsd.week !== null && consumptionUsd.week > 0)
      autonomy = { days: Math.max(0, balance.value - committedUsd) / (consumptionUsd.week / 7), basis: "avg7d" };

    return {
      provider, unit, balance, committedUsd, openOperations: openMine ? openMine.length : null, free, consumptionUsd, autonomy, level, reason,
      limits: policy ? { dailyUsd: (num(policy.daily_cap_usd) ?? 0) > 0 ? num(policy.daily_cap_usd) : null, monthlyUsd: (num(policy.monthly_cap_usd) ?? 0) > 0 ? num(policy.monthly_cap_usd) : null, enabled: policy.enabled === true } : null,
      recentAlerts: alerts ? alerts.filter((a) => a.provider === provider).length : null,
    };
  }));
  if (!open) errors.push("pi_paid_operations open operations unavailable");
  return { version: SENTINEL_CONTRACT_VERSION, generatedAt, timezone: tz, source: "existing-supply-tables", providers, errors: [...new Set(errors)] };
}
