/**
 * RESOURCE SENTINEL — contrato de datos entre el motor (Codex) y la vista del Command Center (Claude).
 *
 * Reglas del contrato:
 * - `null` significa DESCONOCIDO. La vista nunca lo convierte en 0 ni inventa un valor.
 * - Los saldos y el saldo libre van en la unidad del proveedor (`unit`); el consumo, siempre en USD del ledger.
 * - El motor decide el semáforo (`level`) y la autonomía. La vista solo los muestra y explica.
 * - Ningún lector de este contrato llama a un proveedor de pago, recarga saldo ni escribe en el ledger.
 *
 * Mientras el motor no publique su propia fuente, `read.ts` llena este contrato en solo lectura con las tablas
 * existentes (pi_supply_policies, pi_capacity_snapshots, pi_supply_state, pi_paid_operations, pi_supply_alerts).
 * El motor puede sustituirla implementando `SentinelSource` sin tocar la vista.
 */
export const SENTINEL_CONTRACT_VERSION = "resource-sentinel/1" as const;

export type SentinelLevel = "GREEN" | "YELLOW" | "RED" | "UNKNOWN";
export type SentinelUnit = "usd" | "credit" | "character";
export type SentinelHealth = "OK" | "DEGRADED" | "DOWN" | "UNCHECKED";
export type BalanceSource = "provider_api" | "manual_entry";

export type SentinelBalance = {
  /** Saldo o créditos disponibles según la última lectura vigente; null = desconocido o no vigente. */
  value: number | null;
  /** Hora de la última lectura registrada (aunque no esté vigente); null = nunca se leyó. */
  checkedAt: string | null;
  source: BalanceSource | null;
  /** Hubo una lectura, pero ya no es vigente: `value` es null y la vista lo explica. */
  stale: boolean;
  health: SentinelHealth | null;
};

export type SentinelProvider = {
  provider: string;
  unit: SentinelUnit | null;
  balance: SentinelBalance;
  /** USD comprometidos por operaciones abiertas del ledger (enviadas, con trabajo registrado o por conciliar). */
  committedUsd: number | null;
  openOperations: number | null;
  /** Saldo libre en unidades del proveedor según el motor (saldo − retenido); null = el motor no lo certifica. */
  free: number | null;
  /** Consumo en USD: hoy y mes en la zona horaria de la política, semana = últimos 7 días. */
  consumptionUsd: { day: number | null; week: number | null; month: number | null };
  /** Días de autonomía; `basis` explica de dónde salen. */
  autonomy: { days: number | null; basis: "engine" | "avg7d" | null };
  level: SentinelLevel;
  /** Motivo técnico del motor (p. ej. "policy unconfigured", "balance unverified or stale"). */
  reason: string;
  limits: { dailyUsd: number | null; monthlyUsd: number | null; enabled: boolean } | null;
  /** Avisos del motor en los últimos 7 días; null = no se pudieron leer. */
  recentAlerts: number | null;
};

export type SentinelSnapshot = {
  version: typeof SENTINEL_CONTRACT_VERSION;
  generatedAt: string;
  timezone: string;
  source: "existing-supply-tables" | "sentinel-engine";
  providers: SentinelProvider[];
  /** Fuentes que no se pudieron leer (texto técnico corto, sin secretos). */
  errors: string[];
};

export interface SentinelSource {
  read(): Promise<SentinelSnapshot>;
}
