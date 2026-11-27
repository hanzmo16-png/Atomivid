import type { SentinelLevel, SentinelProvider, SentinelSnapshot, SentinelUnit } from "./contract";

/**
 * Vista PURA de RESOURCE SENTINEL: del contrato a lo que ve el administrador. Sin React para poder probarla.
 * Regla: lo desconocido se escribe «Desconocido» (con el motivo), nunca 0, nunca un color verde.
 */

/** Consola oficial de facturación o créditos de cada proveedor (enlace directo para recargar o revisar). */
export const PROVIDER_DIRECTORY: Record<string, { name: string; consoleUrl: string | null; role: string }> = {
  anthropic: { name: "Anthropic", consoleUrl: "https://console.anthropic.com/settings/billing", role: "Guiones y edición con IA" },
  openai: { name: "OpenAI", consoleUrl: "https://platform.openai.com/settings/organization/billing/overview", role: "Imágenes y texto" },
  elevenlabs: { name: "ElevenLabs", consoleUrl: "https://elevenlabs.io/app/subscription", role: "Voces" },
  heygen: { name: "HeyGen", consoleUrl: "https://app.heygen.com/settings", role: "Avatares" },
  runway: { name: "Runway", consoleUrl: "https://dev.runwayml.com/", role: "Video generativo" },
  luma: { name: "Luma", consoleUrl: "https://lumalabs.ai/", role: "Video generativo" },
  veo: { name: "Google Veo", consoleUrl: "https://console.cloud.google.com/billing", role: "Video generativo" },
  bfl: { name: "Black Forest Labs", consoleUrl: "https://dashboard.bfl.ai/", role: "Imágenes" },
  fal: { name: "fal.ai", consoleUrl: "https://fal.ai/dashboard/billing", role: "Imágenes (billetera compartida)" },
  ltx: { name: "LTX", consoleUrl: "https://ltx.studio/", role: "Video generativo" },
  beatoven: { name: "Beatoven", consoleUrl: "https://www.beatoven.ai/", role: "Música" },
};

export type Tone = "ok" | "warn" | "danger" | "muted" | "info";
export type SentinelAlert = { tone: Tone; text: string };
export type SentinelCard = {
  id: string; name: string; role: string; consoleUrl: string | null;
  /** Políticas que comparten esta billetera (p. ej. «FLUX · Recraft»); null si no comparte. */
  sharedBy: string | null;
  light: { level: SentinelLevel; label: string; tone: Tone; explanation: string };
  balance: { display: string; note: string; status: "REAL" | "ESTIMATED" | "STALE" | "UNKNOWN" };
  committed: string; free: string;
  consumption: { label: string; display: string }[];
  autonomy: { display: string; note: string; tone: Tone };
  limits: string;
  alerts: SentinelAlert[];
  updated: { display: string; iso: string | null };
};
export type SentinelView = {
  generatedAt: string; generatedDisplay: string; timezone: string; source: string;
  counts: { level: SentinelLevel; label: string; tone: Tone; count: number }[];
  attention: number; cards: SentinelCard[]; errors: string[]; empty: string | null;
};

const LIGHT: Record<SentinelLevel, { label: string; tone: Tone }> = {
  GREEN: { label: "Disponible", tone: "ok" }, YELLOW: { label: "Recargar pronto", tone: "warn" },
  RED: { label: "Recargar ya", tone: "danger" }, UNKNOWN: { label: "Desconocido", tone: "muted" },
};
/** Motivos técnicos del motor → explicación humana. */
const REASONS: [RegExp, string][] = [
  [/policy unconfigured/, "Sin política de suministro completa (saldo base, costo unitario, topes y evidencia)."],
  [/balance unverified or stale/, "No hay una lectura de saldo verificada de los últimos 5 minutos para autorizar gasto."],
  [/control unavailable/, "No se pudo consultar el control de suministro."],
  [/^RED$|urgent/, "Saldo libre crítico (≤ 15 %), menos de 24 h de cobertura o proveedor caído."],
  [/^YELLOW$|replenish/, "Saldo libre bajo (≤ 30 %), menos de 72 h de cobertura o proveedor degradado."],
  [/^GREEN$|covers/, "El saldo verificado cubre la previsión actual."],
];
export const explainReason = (reason: string) => REASONS.find(([re]) => re.test(reason))?.[1] ?? reason;

const nf = (max: number) => new Intl.NumberFormat("es-MX", { maximumFractionDigits: max, minimumFractionDigits: 0 });
export const usd = (v: number) => `${new Intl.NumberFormat("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)} USD`;
export function amount(v: number, unit: SentinelUnit | null): string {
  if (unit === "usd") return usd(v);
  if (unit === "character") return `${nf(0).format(v)} caracteres`;
  if (unit === "credit") return `${nf(2).format(v)} créditos`;
  return nf(2).format(v);
}
/** «hace 3 min», «hace 5 h», «hace 2 d»; futuro o inválido → la fecha tal cual. */
export function ago(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < -60_000) return iso;
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return "hace menos de 1 min";
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}
export function stamp(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("es-MX", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(d);
}

export function cardOf(p: SentinelProvider, now: number, tz: string): SentinelCard {
  const dir = PROVIDER_DIRECTORY[p.provider] ?? { name: p.provider, consoleUrl: null, role: "Proveedor" };
  const ALIAS: Record<string, string> = { flux: "FLUX", recraft: "Recraft" };
  const sharedBy = p.aliases.length > 1 ? p.aliases.map((a) => ALIAS[a] ?? a).join(" · ") : null;
  const light = { level: p.level, ...LIGHT[p.level], explanation: explainReason(p.reason) };
  const b = p.balance;
  const when = b.checkedAt ? ago(b.checkedAt, now) : "";
  const balance = b.status === "REAL" && b.value !== null
    ? { status: b.status, display: amount(b.value, p.unit), note: `Saldo real: API del proveedor ${when} (vigente 5 min).` }
    : b.status === "ESTIMATED" && b.estimated !== null
      ? { status: b.status, display: `≈ ${amount(b.estimated, p.unit)}`, note: `Estimado por registro manual ${when}; no es un saldo leído de la API.` }
      : b.status === "STALE"
        ? { status: b.status, display: "Desconocido", note: `La lectura de la API ${when}${b.staleValue !== null ? ` (${amount(b.staleValue, p.unit)})` : ""} ya no es vigente: no se usa como saldo.` }
        : { status: "UNKNOWN" as const, display: "Desconocido", note: b.checkedAt ? "La última lectura no es una fuente verificable." : "Nunca se registró un saldo verificable de este proveedor." };
  const committed = p.committedUsd === null ? "Desconocido" : p.committedUsd === 0 ? "Nada comprometido" : `${usd(p.committedUsd)}${p.openOperations ? ` · ${p.openOperations} ${p.openOperations === 1 ? "operación abierta" : "operaciones abiertas"}` : ""}`;
  const free = p.free === null ? "Desconocido" : amount(p.free, p.unit);
  const consumption = ([["Hoy", p.consumptionUsd.day], ["7 días", p.consumptionUsd.week], ["Mes", p.consumptionUsd.month]] as const)
    .map(([label, v]) => ({ label, display: v === null ? "Desconocido" : usd(v) }));
  const days = p.autonomy.days;
  const autonomy = days === null
    ? { display: "Desconocida", note: sharedBy ? "Billetera compartida: el control aún no certifica una autonomía conjunta." : "El control de suministro no la certifica con los datos actuales.", tone: "muted" as Tone }
    : { display: days >= 365 ? "Más de 1 año" : days < 1 ? `${nf(0).format(days * 24)} h` : `${nf(days < 10 ? 1 : 0).format(days)} días`,
        note: "Calculada por el control de suministro.",
        tone: (days <= 3 ? "danger" : days <= 7 ? "warn" : "ok") as Tone };
  const lim = p.limits;
  const limits = !lim ? "Sin política configurada" : `${lim.enabled ? "Gasto habilitado" : "Gasto deshabilitado"} · tope diario ${lim.dailyUsd === null ? "sin definir" : usd(lim.dailyUsd)} · mensual ${lim.monthlyUsd === null ? "sin definir" : usd(lim.monthlyUsd)}`;

  // Alertas preventivas: nunca proponen recargar desde aquí; dicen qué revisar y enlazan a la consola.
  const alerts: SentinelAlert[] = [];
  if (b.health === "DOWN") alerts.push({ tone: "danger", text: "El proveedor reporta caída: las generaciones que dependen de él quedan en espera." });
  if (p.level === "RED") alerts.push({ tone: "danger", text: "Recarga urgente: el saldo libre no garantiza la producción de las próximas 24 h." });
  else if (p.level === "YELLOW") alerts.push({ tone: "warn", text: "Recarga preventiva recomendada antes de quedar por debajo del 15 % o de 24 h de cobertura." });
  if (days !== null && p.level !== "RED" && days <= 7) alerts.push({ tone: days <= 3 ? "danger" : "warn", text: `Autonomía estimada de ${autonomy.display}: programa la recarga.` });
  if (b.status === "STALE") alerts.push({ tone: "warn", text: "Saldo no vigente: el gasto queda en espera hasta una lectura de la API de menos de 5 minutos." });
  else if (b.status === "UNKNOWN") alerts.push({ tone: "warn", text: "Saldo desconocido: no se autoriza gasto con este proveedor hasta verificarlo." });
  else if (b.status === "ESTIMATED") alerts.push({ tone: "info", text: "Saldo estimado (registro manual): confírmalo en la consola del proveedor." });
  if (lim && lim.monthlyUsd !== null && p.consumptionUsd.month !== null && p.consumptionUsd.month >= lim.monthlyUsd * 0.8)
    alerts.push({ tone: p.consumptionUsd.month >= lim.monthlyUsd ? "danger" : "warn", text: `Consumo del mes al ${nf(0).format(p.consumptionUsd.month / lim.monthlyUsd * 100)} % del tope mensual.` });
  if (p.recentAlerts) alerts.push({ tone: "info", text: `${p.recentAlerts} aviso${p.recentAlerts === 1 ? "" : "s"} del control de suministro en los últimos 7 días.` });

  return {
    id: p.provider, name: dir.name, role: dir.role, consoleUrl: dir.consoleUrl, sharedBy, light, balance, committed, free, consumption, autonomy, limits, alerts,
    updated: b.checkedAt ? { display: `${stamp(b.checkedAt, tz)} (${ago(b.checkedAt, now)})`, iso: b.checkedAt } : { display: "Sin lecturas", iso: null },
  };
}

const ORDER: Record<SentinelLevel, number> = { RED: 0, YELLOW: 1, UNKNOWN: 2, GREEN: 3 };
export function buildSentinelView(s: SentinelSnapshot | null): SentinelView {
  if (!s) return { generatedAt: "", generatedDisplay: "—", timezone: "America/Cancun", source: "", counts: [], attention: 0, cards: [], errors: ["Sentinel no disponible"], empty: "No se pudo leer el estado de los recursos. No se autoriza gasto con datos desconocidos." };
  const now = Date.parse(s.generatedAt);
  const cards = s.providers.map((p) => cardOf(p, now, s.timezone)).sort((a, b) => ORDER[a.light.level] - ORDER[b.light.level] || a.name.localeCompare(b.name, "es"));
  const counts = (["RED", "YELLOW", "UNKNOWN", "GREEN"] as SentinelLevel[]).map((level) => ({ level, ...LIGHT[level], count: cards.filter((c) => c.light.level === level).length }));
  return {
    generatedAt: s.generatedAt, generatedDisplay: stamp(s.generatedAt, s.timezone), timezone: s.timezone,
    source: s.source === "sentinel-engine" ? "Motor Sentinel" : "Control de suministro existente (solo lectura)",
    counts, attention: cards.filter((c) => c.light.level === "RED" || c.light.level === "YELLOW").length,
    cards, errors: s.errors,
    empty: cards.length ? null : s.errors.length ? "No se pudo leer el estado de los recursos. No se autoriza gasto con datos desconocidos." : "Aún no hay proveedores con política de suministro.",
  };
}
