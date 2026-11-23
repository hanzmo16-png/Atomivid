/**
 * Modo real: implementado y cerrado.
 * Aunque la autorización de Hans esté completa, Mystery Shopper 1.0 no llama a ningún proveedor.
 * El cerrojo es una constante de código, no una variable de entorno: un secreto filtrado no puede gastar.
 */
import type { RunMode } from "./types";

/** Cerrojo de la versión 1.0. Cambiarlo exige un diff revisado por Hans. */
export const PROVIDER_CALLS_ENABLED = false;

export const REAL_AUTH_ENV = "MYSTERY_SHOPPER_HANS_AUTH";
export const MAX_RETRY_CAP = 2;

const BILLABLE_HOST = /elevenlabs|anthropic|openai|api\.stripe|stripe\.com|fal\.(ai|run)|heygen|pexels|recraft|d-id|runway/i;

export type LedgerReservation = {
  id: string;
  idempotencyKey: string;
  missionId: string;
  usd: number;
  state: "reserved" | "released" | "reconciled";
  spentUsd: number;
  note: string;
};

export type Ledger = { reservations: LedgerReservation[] };

export function emptyLedger(): Ledger {
  return { reservations: [] };
}

export type RealInput = {
  mode: RunMode;
  approver?: string;
  missionId: string;
  expectedMissionId: string;
  maxBudgetUsd?: number;
  estimateUsd?: number | null;
  estimateVerified?: boolean;
  knownCost?: boolean;
  reservationId?: string;
  idempotencyKey: string;
  maxRetries?: number;
  attempt?: number;
  cancelRequested?: boolean;
  /** Secreto que solo Hans configura. Ausente = bloqueado. Nunca se registra. */
  hansAuth?: string;
};

export type RealDecision = {
  execute: false;
  code: string;
  reason: string;
  spentUsd: 0;
  ledger: Ledger;
};

export class RealModeBlocked extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RealModeBlocked";
  }
}

function num(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** Reserva o reutiliza la fila. La misma clave no abre una segunda reserva. */
export function reserveSpend(ledger: Ledger, row: Omit<LedgerReservation, "state" | "spentUsd" | "note"> & { note?: string }): { ledger: Ledger; created: boolean; row: LedgerReservation } {
  const existing = ledger.reservations.find((r) => r.idempotencyKey === row.idempotencyKey);
  if (existing) {
    if (existing.usd !== row.usd || existing.missionId !== row.missionId) {
      throw new RealModeBlocked("double_charge", "La misma ejecución ya tiene una reserva distinta. No se abre otra.");
    }
    return { ledger, created: false, row: existing };
  }
  const next: LedgerReservation = { ...row, state: "reserved", spentUsd: 0, note: row.note ?? "reserva" };
  return { ledger: { reservations: [...ledger.reservations, next] }, created: true, row: next };
}

export function releaseReservation(ledger: Ledger, idempotencyKey: string, note: string): Ledger {
  return {
    reservations: ledger.reservations.map((r) => r.idempotencyKey === idempotencyKey ? { ...r, state: "reconciled", spentUsd: 0, note } : r),
  };
}

/**
 * Decide el modo real. Siempre devuelve execute: false en esta versión.
 * Si la política no se cumple, no reserva. Si la política se cumple, reserva y concilia a USD 0 por el cerrojo.
 */
export function decideRealMode(input: RealInput, ledger: Ledger): RealDecision {
  const blocked = (code: string, reason: string, next: Ledger = ledger): RealDecision => ({ execute: false, code, reason, spentUsd: 0, ledger: next });

  if (input.mode !== "real") return blocked("fixture", "Modo gratuito: no hay proveedor que llamar.");
  if (input.cancelRequested) return blocked("cancelled", "Cancelado antes de cualquier gasto.");
  if ((input.approver ?? "").trim().toLowerCase() !== "hans") return blocked("approver", "Hace falta la autorización explícita de Hans para esta misión.");
  if (!input.hansAuth) return blocked("hans_secret", `Falta el secreto ${REAL_AUTH_ENV}. Sin él el modo real queda bloqueado.`);
  if (input.hansAuth.length < 16) return blocked("hans_secret", "El secreto de autorización de Hans no es verificable.");
  if (input.missionId !== input.expectedMissionId) return blocked("mission", "La autorización no corresponde a esta misión.");
  if (!input.knownCost || !input.estimateVerified || !num(input.estimateUsd)) {
    return blocked("unknown_cost", "No se puede comprobar el costo máximo. El modo real queda bloqueado.");
  }
  if (!num(input.maxBudgetUsd) || input.maxBudgetUsd <= 0) return blocked("budget", "El presupuesto máximo tiene que ser un número mayor que cero y verificable.");
  if (input.estimateUsd > input.maxBudgetUsd) return blocked("budget", `La estimación (USD ${input.estimateUsd.toFixed(2)}) supera el presupuesto máximo (USD ${input.maxBudgetUsd.toFixed(2)}).`);
  if (input.estimateUsd < 0) return blocked("unknown_cost", "Una estimación negativa no es un costo comprobable.");
  const retries = input.maxRetries ?? 0;
  if (!Number.isInteger(retries) || retries < 0 || retries > MAX_RETRY_CAP) return blocked("retries", `El límite de reintentos debe estar entre 0 y ${MAX_RETRY_CAP}.`);
  const attempt = input.attempt ?? 0;
  if (attempt > retries) return blocked("retries", "Se alcanzó el límite de reintentos. No hay otra llamada.");
  if (!input.reservationId || !/^[a-zA-Z0-9_-]{8,80}$/.test(input.reservationId)) return blocked("reservation", "Falta un id de reserva único.");
  if (!/^[a-zA-Z0-9:_-]{8,120}$/.test(input.idempotencyKey)) return blocked("idempotency", "Falta un id de ejecución válido.");

  let reserved: { ledger: Ledger; row: LedgerReservation };
  try {
    reserved = reserveSpend(ledger, { id: input.reservationId, idempotencyKey: input.idempotencyKey, missionId: input.missionId, usd: input.estimateUsd });
  } catch (e) {
    if (e instanceof RealModeBlocked) return blocked(e.code, e.message);
    throw e;
  }
  if (!PROVIDER_CALLS_ENABLED) {
    const reconciled = releaseReservation(reserved.ledger, input.idempotencyKey, "cerrojo 1.0: reserva liberada, gasto USD 0");
    return blocked("provider_lock", "La autorización pasó las comprobaciones, pero Mystery Shopper 1.0 tiene el cerrojo de proveedores cerrado. No se llamó a nadie. Gasto USD 0.", reconciled);
  }
  return blocked("provider_lock", "Cerrojo cerrado.");
}

/** Última línea de defensa. Rechaza destinos facturables y no llama a la red. */
export function assertNoBillableRequest(url: string): void {
  if (BILLABLE_HOST.test(url)) throw new RealModeBlocked("billable_host", "Corte: el destino parece un proveedor facturable.");
}

export async function executeRealProvider(url: string, fetchImpl: typeof fetch = fetch): Promise<never> {
  void fetchImpl;
  assertNoBillableRequest(url);
  throw new RealModeBlocked("provider_lock", "Mystery Shopper 1.0 no ejecuta proveedores.");
}
