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

export type BalanceStatus = "REAL" | "ESTIMATED" | "STALE" | "UNKNOWN";
export type SentinelBalance = {
  /**
   * REAL: lectura de la API del proveedor de ≤ 5 min (la misma vigencia que exige el motor para admitir gasto).
   * ESTIMATED: registro manual; es una estimación, no un saldo de la API.
   * STALE: hubo una lectura de la API, pero caducó. UNKNOWN: no hay fuente verificable.
   */
  status: BalanceStatus;
  /** Solo con status REAL; en cualquier otro caso null. */
  value: number | null;
  /** Solo con status ESTIMATED (registro manual). */
  estimated: number | null;
  /** Solo con status STALE: último valor de la API, ya caducado (se muestra como referencia, nunca como saldo). */
  staleValue: number | null;
  /** Hora de la última lectura registrada; null = nunca se leyó. */
  checkedAt: string | null;
  source: BalanceSource | null;
  health: SentinelHealth | null;
};

export type SentinelProvider = {
  /** Cuenta de facturación (p. ej. "fal"); una billetera compartida es UNA tarjeta, nunca dos saldos sumados. */
  provider: string;
  /** Políticas que comparten esta billetera (p. ej. ["flux", "recraft"] en fal.ai); [provider] si no comparte. */
  aliases: string[];
  unit: SentinelUnit | null;
  balance: SentinelBalance;
  /** USD comprometidos por operaciones abiertas del ledger (enviadas, con trabajo registrado o por conciliar). */
  committedUsd: number | null;
  openOperations: number | null;
  /** Saldo libre en unidades del proveedor según el motor (saldo − retenido); null = el motor no lo certifica. */
  free: number | null;
  /**
   * Consumo en USD REGISTRADO en el ledger PI: hoy y mes en la zona horaria de la política, semana = últimos 7 días.
   * Es parcial (Audio/Podcast llevan contabilidad propia): no es el total facturado del proveedor.
   */
  consumptionUsd: { day: number | null; week: number | null; month: number | null };
  /** Días de autonomía certificados por el motor; la vista nunca los recalcula con saldo bruto o consumo parcial. */
  autonomy: { days: number | null; basis: "engine" | null };
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
