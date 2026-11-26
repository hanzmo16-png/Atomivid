import { SENTINEL_CONTRACT_VERSION, type BalanceSource, type BalanceStatus, type SentinelBalance, type SentinelHealth, type SentinelLevel, type SentinelProvider, type SentinelSnapshot, type SentinelUnit } from "./contract";

/**
 * Lector PROVISIONAL de SOLO LECTURA que llena el contrato Sentinel con las tablas que ya existen, hasta que el
 * adaptador del motor (Codex, src/lib/supply/) lo sustituya. No llama a proveedores, no escribe y no reimplementa
 * el motor: semáforo, saldo libre y cobertura salen de `pi_supply_state` tal cual; la vista no recalcula autonomía.
 * Quien lo llame debe haber verificado OWNER/ADMIN.
 */

/** Vigencia de una lectura de la API: la misma que exige el motor para admitir gasto (5 min). */
export const API_BALANCE_MAX_AGE_MS = 300_000;
/** Políticas que comparten billetera: una sola tarjeta por cuenta, sin sumar el saldo dos veces. */
export const BILLING_ACCOUNT: Readonly<Record<string, string>> = { flux: "fal", recraft: "fal" };
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
const accountOf = (provider: string) => BILLING_ACCOUNT[provider] ?? provider;

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

/** Estado del saldo de una lectura: REAL solo si es de la API y tiene ≤ 5 min; manual = ESTIMATED. */
export function balanceOf(snap: Row | null, now: Date): SentinelBalance {
  const reliability = snap?.reliability;
  const source: BalanceSource | null = reliability === "provider_api" || reliability === "manual_entry" ? reliability : null;
  const checkedAt = typeof snap?.checked_at === "string" ? snap.checked_at : null;
  const age = checkedAt ? now.getTime() - Date.parse(checkedAt) : NaN;
  const available = num(snap?.available);
  const plausible = source !== null && available !== null && available >= 0 && Number.isFinite(age) && age >= -60_000;
  const health = snap && HEALTH.has(String(snap.health)) ? (snap.health as SentinelHealth) : null;
  let status: BalanceStatus = "UNKNOWN";
  if (plausible && source === "manual_entry") status = "ESTIMATED";
  else if (plausible && age <= API_BALANCE_MAX_AGE_MS) status = "REAL";
  else if (plausible) status = "STALE";
  return {
    status, value: status === "REAL" ? available : null, estimated: status === "ESTIMATED" ? available : null,
    staleValue: status === "STALE" ? available : null, checkedAt, source, health,
  };
}

const WORST: SentinelLevel[] = ["RED", "UNKNOWN", "YELLOW", "GREEN"];
const sumOrNull = (xs: (number | null)[]) => (xs.some((x) => x === null) ? null : xs.reduce<number>((t, x) => t + (x ?? 0), 0));

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
  if (!open) errors.push("pi_paid_operations open operations unavailable");
  if (!alerts) errors.push("pi_supply_alerts unavailable");

  const names = new Set<string>(policies.map((p) => String(p.provider)));
  for (const s of snaps ?? []) if (typeof s.provider === "string" && s.provider !== "__global__") names.add(s.provider);

  // Una tarjeta por cuenta de facturación: las políticas que comparten billetera se agrupan.
  const accounts = new Map<string, string[]>();
  for (const n of [...names].sort()) accounts.set(accountOf(n), [...(accounts.get(accountOf(n)) ?? []), n]);

  const providers = await Promise.all([...accounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(async ([account, aliases]): Promise<SentinelProvider> => {
    const pols = policies.filter((p) => aliases.includes(String(p.provider)));
    const units = new Set(pols.map((p) => String(p.unit)).filter((u) => UNITS.has(u)));
    const policyUnit = units.size === 1 ? ([...units][0] as SentinelUnit) : null;
    // La billetera es una sola: la lectura más reciente de cualquiera de sus alias (las filas vienen en orden descendente).
    const snap = (snaps ?? []).find((s) => aliases.includes(String(s.provider)) && (!policyUnit || s.unit === policyUnit)) ?? null;
    const unit = policyUnit ?? (snap && UNITS.has(String(snap.unit)) ? (snap.unit as SentinelUnit) : null);
    const balance = balanceOf(snap, now);

    // Semáforo, saldo libre y cobertura del motor existente, por política. En una billetera compartida, el saldo
    // libre y la cobertura de cada alias no se pueden sumar ni combinar: quedan desconocidos.
    const states = await Promise.all(pols.map(async (p) => {
      const st = await db.rpc("pi_supply_state", { p_provider: p.provider }).then((r) => r, () => ({ data: null, error: true }));
      const s = !st.error && st.data && typeof st.data === "object" ? (st.data as Row) : null;
      if (!s) errors.push(`pi_supply_state ${p.provider} unavailable`);
      return s;
    }));
    let level: SentinelLevel = "UNKNOWN"; let reason = pols.length ? "control unavailable" : "policy unconfigured";
    let free: number | null = null; let coverageHours: number | null = null;
    if (pols.length && states.every(Boolean)) {
      const levels = states.map((s) => (LEVELS.has(String(s!.level)) ? (s!.level as SentinelLevel) : "UNKNOWN"));
      level = WORST.find((l) => levels.includes(l)) ?? "UNKNOWN";
      const worst = states[levels.indexOf(level)]!;
      reason = typeof worst.reason === "string" ? worst.reason : String(level);
      if (aliases.length === 1 && level !== "UNKNOWN") { free = num(worst.free); coverageHours = num(worst.coverageHours); }
    }

    const mine = ops?.filter((o) => aliases.includes(String(o.provider))) ?? null;
    const sum = (from: Date) => mine ? mine.reduce((t, o) => { const v = spend(o); return v !== null && Date.parse(String(o.created_at)) >= from.getTime() ? t + v : t; }, 0) : null;
    const openMine = open?.filter((o) => aliases.includes(String(o.provider))) ?? null;
    const caps = (k: string) => (pols.length ? sumOrNull(pols.map((p) => ((num(p[k]) ?? 0) > 0 ? num(p[k]) : null))) : null);

    return {
      provider: account, aliases, unit, balance,
      committedUsd: openMine ? openMine.reduce((t, o) => t + Math.max(num(o.reserved_usd) ?? 0, num(o.committed_usd) ?? 0), 0) : null,
      openOperations: openMine ? openMine.length : null, free,
      consumptionUsd: { day: sum(dayStart), week: sum(weekStart), month: sum(monthStart) },
      autonomy: coverageHours !== null ? { days: coverageHours / 24, basis: "engine" } : { days: null, basis: null },
      level, reason,
      limits: pols.length ? { dailyUsd: caps("daily_cap_usd"), monthlyUsd: caps("monthly_cap_usd"), enabled: pols.some((p) => p.enabled === true) } : null,
      recentAlerts: alerts ? alerts.filter((a) => aliases.includes(String(a.provider))).length : null,
    };
  }));
  return { version: SENTINEL_CONTRACT_VERSION, generatedAt, timezone: tz, source: "existing-supply-tables", providers, errors: [...new Set(errors)] };
}
