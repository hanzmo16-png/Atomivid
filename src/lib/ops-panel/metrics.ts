/**
 * M5 · Panel operativo y financiero — agregación PURA (sin red, sin Supabase, sin proveedor).
 *
 * Recibe filas con forma de ledger (pi_paid_operations) y, opcionalmente, trabajos (video_requests), topes
 * (pi_supply_policies / topes por proyecto) y precios. Devuelve métricas con aritmética decimal EXACTA:
 * todos los importes se cuentan en enteros de diezmilésimas de USD (BigInt, la misma escala que numeric(12,4))
 * y se exponen como cadenas de 4 decimales. Nunca hay deriva de coma flotante.
 *
 * Semántica del ledger (idéntica a pi_supply_state / pi_submit_with_supply en supabase/migrations):
 *  - RESERVED: no hubo llamada HTTP. NUNCA cuenta como gasto (se muestra aparte como "reservado sin gastar").
 *  - SUBMITTED, PROVIDER_JOB_RECORDED, RECONCILIATION_REQUIRED: gasto INCIERTO; exposición = reserved_usd.
 *  - COMMITTED: gasto confirmado = coalesce(committed_usd, reserved_usd).
 *  - REFUNDED con supply_reconciled = true: liberado, gasto 0.
 *  - REFUNDED sin conciliar: INCIERTO (el proveedor pudo cobrar); exposición = reserved_usd.
 *  - Estado desconocido: INCIERTO (fail-closed) y se cuenta en unknownStatusOps.
 *  - method = 'capacity_hold': retención de capacidad, no es una llamada; se excluye del gasto.
 *  - Consumo contra topes: greatest(reserved_usd, coalesce(committed_usd, 0)) para todo lo que no sea RESERVED
 *    ni REFUNDED conciliado (misma fórmula que daily_spend / monthly_spend del SQL).
 *
 * Separación de fuentes: la entrada declara UNA fuente ("synthetic" | "real") y cada fila declara su `origin`.
 * Si alguna fila no coincide se lanza MIXED_DATA_SOURCES: una vista nunca mezcla datos reales y simulados.
 */

export type DataKind = "synthetic" | "real";
export type DataSource = { kind: DataKind; label: string; asOf: string };

export type LedgerRow = {
  origin: DataKind;
  projectId: string;
  provider: string;
  method: string;
  status: string;
  reservedUsd: string | number;
  committedUsd: string | number | null;
  supplyReconciled: boolean;
  createdAt: string;
};
export type JobRow = { origin: DataKind; id: string; status: string; mode: string | null };
export type ProviderCapRow = { origin: DataKind; provider: string; dailyCapUsd: string | number; monthlyCapUsd: string | number; enabled: boolean };
export type ProjectCapRow = { origin: DataKind; projectId: string; capUsd: string | number; kind: string };
/** Un precio por proyecto. Sin precios, el margen es "sin fuente de precio": nunca se inventa. */
export type PriceRow = { origin: DataKind; projectId: string; priceUsd: string | number; basis: string };

export type OpsInput = {
  source: DataSource;
  period: { fromIso: string; toIso: string };
  /** Inicio del día y del mes en la zona de los topes (pi_supply_policies.timezone), ya resuelto por quien llama. */
  dayStartIso: string;
  monthStartIso: string;
  /** Desplazamiento para agrupar por día (Cancún = -300). Por defecto 0 (UTC). */
  utcOffsetMinutes?: number;
  ledger: LedgerRow[];
  /** null = no hay fuente de trabajos (distinto de una lista vacía). */
  jobs?: JobRow[] | null;
  providerCaps?: ProviderCapRow[] | null;
  projectCaps?: ProjectCapRow[] | null;
  prices?: PriceRow[] | null;
};

export class OpsMetricsError extends Error {
  constructor(readonly code: string, detail: string) { super(`${code}: ${detail}`); this.name = "OpsMetricsError"; }
}

// ---------- decimal exacto (diezmilésimas de USD) ----------
const ZERO = BigInt(0), TEN_THOUSAND = BigInt(10_000);
/** Máximo de numeric(12,4) por fila, en diezmilésimas. */
const ROW_MAX_UNITS = BigInt("999999999999");

/** "12.34" | 12.34 → 123400n. Rechaza negativos, NaN, notación exponencial, más de 4 decimales y > numeric(12,4). */
export function toUnits(value: string | number, field = "usd"): bigint {
  if (typeof value === "number" && !Number.isFinite(value)) throw new OpsMetricsError("INVALID_AMOUNT", `${field} no finito`);
  const text = typeof value === "number" ? String(value) : value.trim();
  const m = /^(\d+)(?:\.(\d{1,4}))?$/.exec(text);
  if (!m) throw new OpsMetricsError("INVALID_AMOUNT", `${field}=${text} no es un importe de 4 decimales no negativo`);
  const units = BigInt(m[1]) * TEN_THOUSAND + BigInt((m[2] ?? "").padEnd(4, "0") || "0");
  if (units > ROW_MAX_UNITS) throw new OpsMetricsError("INVALID_AMOUNT", `${field}=${text} excede numeric(12,4)`);
  return units;
}
/** 123400n → "12.3400"; admite negativos (margen u holgura excedida). */
export function formatUnits(units: bigint): string {
  const neg = units < ZERO, abs = neg ? -units : units;
  return `${neg ? "-" : ""}${(abs / TEN_THOUSAND).toString()}.${(abs % TEN_THOUSAND).toString().padStart(4, "0")}`;
}
const max = (a: bigint, b: bigint) => (a > b ? a : b);
/** Porcentaje con 1 decimal, redondeo half-up exacto (num/den en la misma escala). */
function pct1(num: bigint, den: bigint): string {
  if (den === ZERO) return "—";
  const neg = (num < ZERO) !== (den < ZERO);
  const n = num < ZERO ? -num : num, d = den < ZERO ? -den : den;
  const tenths = (n * BigInt(2000) + d) / (BigInt(2) * d); // round(n*1000/d)
  return `${neg && tenths !== ZERO ? "-" : ""}${(tenths / BigInt(10)).toString()}.${(tenths % BigInt(10)).toString()}`;
}

// ---------- clasificación ----------
export const UNCERTAIN_STATUSES = ["SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED"] as const;
const KNOWN_STATUSES = new Set(["RESERVED", "COMMITTED", "REFUNDED", ...UNCERTAIN_STATUSES]);
export type RowClass = "reserved" | "committed" | "uncertain" | "released" | "excluded";

export type ClassifiedRow = { cls: RowClass; spentUnits: bigint; uncertainUnits: bigint; reservedUnits: bigint; capUnits: bigint; committedFallback: boolean; unknownStatus: boolean };

export function classifyRow(r: LedgerRow): ClassifiedRow {
  const reserved = toUnits(r.reservedUsd, "reserved_usd");
  const committed = r.committedUsd === null ? null : toUnits(r.committedUsd, "committed_usd");
  const base = { spentUnits: ZERO, uncertainUnits: ZERO, reservedUnits: ZERO, capUnits: ZERO, committedFallback: false, unknownStatus: false };
  if (r.method === "capacity_hold") return { ...base, cls: "excluded" };
  if (r.status === "RESERVED") return { ...base, cls: "reserved", reservedUnits: reserved };
  if (r.status === "REFUNDED" && r.supplyReconciled) return { ...base, cls: "released" };
  const capUnits = max(reserved, committed ?? ZERO);
  if (r.status === "COMMITTED") return { ...base, cls: "committed", spentUnits: committed ?? reserved, capUnits, committedFallback: committed === null };
  // SUBMITTED / PJR / RR / REFUNDED sin conciliar / estado desconocido: exposición incierta, nunca gasto confirmado.
  return { ...base, cls: "uncertain", uncertainUnits: reserved, capUnits, unknownStatus: !KNOWN_STATUSES.has(r.status) };
}

// ---------- salida ----------
export type Money = string; // 4 decimales, p. ej. "12.3400"
export type StatusCount = { status: string; count: number };
export type ProviderSpend = { provider: string; committedUsd: Money; uncertainUsd: Money; ops: number };
export type DaySpend = { day: string; committedUsd: Money; uncertainUsd: Money };
export type ProjectCost = {
  projectId: string; ops: number; committedUsd: Money; uncertainUsd: Money; complete: boolean;
  cap: { capUsd: Money; kind: string; headroomUsd: Money; exceeded: boolean } | null;
  margin: { state: "KNOWN"; priceUsd: Money; basis: string; marginUsd: Money; marginPct: string } | { state: "UNCERTAIN"; priceUsd: Money; basis: string } | { state: "NO_PRICE_SOURCE" };
};
export type ProviderHeadroom = { provider: string; enabled: boolean; daily: CapWindow; monthly: CapWindow };
export type CapWindow = { capUsd: Money | null; usedUsd: Money; headroomUsd: Money | null; usedPct: string | null; exceeded: boolean };

export type OpsMetrics = {
  source: DataSource;
  period: { fromIso: string; toIso: string };
  totals: {
    committedUsd: Money; uncertainUsd: Money; reservedNotSpentUsd: Money;
    ops: number; committedOps: number; uncertainOps: number; reservedOps: number; releasedOps: number; excludedOps: number;
    committedWithoutAmount: number; unknownStatusOps: number;
  };
  byStatus: StatusCount[];
  byProvider: ProviderSpend[];
  byDay: DaySpend[];
  byProject: ProjectCost[];
  activity: {
    activeProviderCalls: number; reconciliationRequired: number; refundsUnreconciled: number;
    jobs: { state: "KNOWN"; running: number; queued: number; failed: number; completed: number; other: number } | { state: "NO_SOURCE" };
  };
  headroom: { state: "KNOWN"; providers: ProviderHeadroom[] } | { state: "NO_SOURCE" };
  margins: { state: "KNOWN" | "PARTIAL"; priced: number; unpriced: number } | { state: "NO_PRICE_SOURCE" };
};

function time(iso: string, field: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new OpsMetricsError("INVALID_DATE", `${field}=${iso}`);
  return t;
}

export function computeOpsMetrics(input: OpsInput): OpsMetrics {
  const { source } = input;
  if (source.kind !== "synthetic" && source.kind !== "real") throw new OpsMetricsError("INVALID_SOURCE", String(source.kind));
  const check = (rows: { origin: DataKind }[] | null | undefined, what: string) => {
    for (const r of rows ?? []) if (r.origin !== source.kind) throw new OpsMetricsError("MIXED_DATA_SOURCES", `${what} con origen ${r.origin} en una vista ${source.kind}`);
  };
  check(input.ledger, "ledger"); check(input.jobs, "jobs"); check(input.providerCaps, "providerCaps"); check(input.projectCaps, "projectCaps"); check(input.prices, "prices");

  const from = time(input.period.fromIso, "period.fromIso"), to = time(input.period.toIso, "period.toIso");
  if (to < from) throw new OpsMetricsError("INVALID_PERIOD", "toIso < fromIso");
  const dayStart = time(input.dayStartIso, "dayStartIso"), monthStart = time(input.monthStartIso, "monthStartIso");
  const offsetMs = (input.utcOffsetMinutes ?? 0) * 60_000;

  let committed = ZERO, uncertain = ZERO, reservedNotSpent = ZERO;
  let ops = 0, committedOps = 0, uncertainOps = 0, reservedOps = 0, releasedOps = 0, excludedOps = 0, committedWithoutAmount = 0, unknownStatusOps = 0;
  let activeProviderCalls = 0, reconciliationRequired = 0, refundsUnreconciled = 0;
  const statusCount = new Map<string, number>();
  const prov = new Map<string, { c: bigint; u: bigint; ops: number }>();
  const days = new Map<string, { c: bigint; u: bigint }>();
  const proj = new Map<string, { c: bigint; u: bigint; ops: number }>();
  const capDay = new Map<string, bigint>(), capMonth = new Map<string, bigint>();

  for (const r of input.ledger) {
    const t = time(r.createdAt, "createdAt");
    const k = classifyRow(r);
    // Consumo contra topes: todas las filas recibidas, por fecha de creación (como el SQL), independiente del periodo.
    if (k.cls === "committed" || k.cls === "uncertain") {
      if (t >= dayStart) capDay.set(r.provider, (capDay.get(r.provider) ?? ZERO) + k.capUnits);
      if (t >= monthStart) capMonth.set(r.provider, (capMonth.get(r.provider) ?? ZERO) + k.capUnits);
    }
    if (t < from || t >= to) continue;
    ops++;
    statusCount.set(r.status, (statusCount.get(r.status) ?? 0) + 1);
    if (r.method !== "capacity_hold") {
      if (r.status === "SUBMITTED" || r.status === "PROVIDER_JOB_RECORDED") activeProviderCalls++;
      if (r.status === "RECONCILIATION_REQUIRED") reconciliationRequired++;
      if (r.status === "REFUNDED" && !r.supplyReconciled) refundsUnreconciled++;
    }
    switch (k.cls) {
      case "excluded": excludedOps++; continue;
      case "reserved": reservedOps++; reservedNotSpent += k.reservedUnits; continue;
      case "released": releasedOps++; break;
      case "committed": committedOps++; committed += k.spentUnits; if (k.committedFallback) committedWithoutAmount++; break;
      case "uncertain": uncertainOps++; uncertain += k.uncertainUnits; if (k.unknownStatus) unknownStatusOps++; break;
    }
    const p = prov.get(r.provider) ?? { c: ZERO, u: ZERO, ops: 0 };
    prov.set(r.provider, { c: p.c + k.spentUnits, u: p.u + k.uncertainUnits, ops: p.ops + 1 });
    const day = new Date(t + offsetMs).toISOString().slice(0, 10);
    const d = days.get(day) ?? { c: ZERO, u: ZERO };
    days.set(day, { c: d.c + k.spentUnits, u: d.u + k.uncertainUnits });
    const j = proj.get(r.projectId) ?? { c: ZERO, u: ZERO, ops: 0 };
    proj.set(r.projectId, { c: j.c + k.spentUnits, u: j.u + k.uncertainUnits, ops: j.ops + 1 });
  }

  const caps = new Map((input.projectCaps ?? []).map(c => [c.projectId, c]));
  const prices = new Map<string, PriceRow>();
  for (const p of input.prices ?? []) {
    if (prices.has(p.projectId)) throw new OpsMetricsError("DUPLICATE_PRICE", p.projectId);
    prices.set(p.projectId, p);
  }
  const byProject: ProjectCost[] = [...proj.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([projectId, v]) => {
    const c = caps.get(projectId);
    const capUnits = c ? toUnits(c.capUsd, "capUsd") : null;
    const headroom = capUnits === null ? null : capUnits - v.c - v.u; // misma fórmula que el tope por Reel: committed + pending ≤ cap
    const p = prices.get(projectId);
    let margin: ProjectCost["margin"] = { state: "NO_PRICE_SOURCE" };
    if (p) {
      const price = toUnits(p.priceUsd, "priceUsd");
      margin = v.u > ZERO ? { state: "UNCERTAIN", priceUsd: formatUnits(price), basis: p.basis }
        : { state: "KNOWN", priceUsd: formatUnits(price), basis: p.basis, marginUsd: formatUnits(price - v.c), marginPct: pct1(price - v.c, price) };
    }
    return {
      projectId, ops: v.ops, committedUsd: formatUnits(v.c), uncertainUsd: formatUnits(v.u), complete: v.u === ZERO,
      cap: c && headroom !== null && capUnits !== null ? { capUsd: formatUnits(capUnits), kind: c.kind, headroomUsd: formatUnits(headroom), exceeded: headroom < ZERO } : null,
      margin,
    };
  });

  const window = (capRaw: string | number, used: bigint): CapWindow => {
    const cap = toUnits(capRaw, "capUsd");
    if (cap === ZERO) return { capUsd: null, usedUsd: formatUnits(used), headroomUsd: null, usedPct: null, exceeded: false };
    return { capUsd: formatUnits(cap), usedUsd: formatUnits(used), headroomUsd: formatUnits(cap - used), usedPct: pct1(used, cap), exceeded: used > cap };
  };
  const headroom: OpsMetrics["headroom"] = input.providerCaps
    ? { state: "KNOWN", providers: [...input.providerCaps].sort((a, b) => (a.provider < b.provider ? -1 : 1)).map(c => ({ provider: c.provider, enabled: c.enabled, daily: window(c.dailyCapUsd, capDay.get(c.provider) ?? ZERO), monthly: window(c.monthlyCapUsd, capMonth.get(c.provider) ?? ZERO) })) }
    : { state: "NO_SOURCE" };

  let jobs: OpsMetrics["activity"]["jobs"] = { state: "NO_SOURCE" };
  if (input.jobs) {
    const j = { running: 0, queued: 0, failed: 0, completed: 0, other: 0 };
    for (const r of input.jobs) {
      if (r.status === "processing") j.running++;
      else if (r.status === "pending" || r.status === "script_ready") j.queued++;
      else if (r.status === "failed") j.failed++;
      else if (r.status === "completed") j.completed++;
      else j.other++;
    }
    jobs = { state: "KNOWN", ...j };
  }

  const priced = byProject.filter(p => p.margin.state !== "NO_PRICE_SOURCE").length;
  const margins: OpsMetrics["margins"] = !input.prices || input.prices.length === 0 ? { state: "NO_PRICE_SOURCE" }
    : { state: priced === byProject.length ? "KNOWN" : "PARTIAL", priced, unpriced: byProject.length - priced };

  return {
    source, period: input.period,
    totals: { committedUsd: formatUnits(committed), uncertainUsd: formatUnits(uncertain), reservedNotSpentUsd: formatUnits(reservedNotSpent), ops, committedOps, uncertainOps, reservedOps, releasedOps, excludedOps, committedWithoutAmount, unknownStatusOps },
    byStatus: [...statusCount.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([status, count]) => ({ status, count })),
    byProvider: [...prov.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([provider, v]) => ({ provider, committedUsd: formatUnits(v.c), uncertainUsd: formatUnits(v.u), ops: v.ops })),
    byDay: [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, v]) => ({ day, committedUsd: formatUnits(v.c), uncertainUsd: formatUnits(v.u) })),
    byProject,
    activity: { activeProviderCalls, reconciliationRequired, refundsUnreconciled, jobs },
    headroom, margins,
  };
}
