/**
 * Política única de precisión monetaria del ledger (T-20261019-1553, Grok).
 *
 * pi_paid_operations.reserved_usd / committed_usd son numeric(12,4): Postgres redondea a 4 decimales
 * (half-up) y rechaza |x| >= 1e8. Un importe positivo menor que 0.00005 se guardaba como 0.0000, es decir,
 * una llamada facturable quedaba registrada como gratuita.
 *
 * Política:
 *  - NaN, ±Infinity, negativos o desbordamiento de numeric(12,4) → LedgerAmountError ANTES de escribir el
 *    ledger y antes del proveedor (fail-closed).
 *  - 0 se conserva (recursos realmente gratuitos y reservas que ya eran 0 por diseño).
 *  - Un positivo se redondea HACIA ARRIBA a la unidad mínima registrable (0.0001 USD). Es un importe de
 *    RESERVA/LIQUIDACIÓN contable redondeado, nunca el costo exacto del proveedor; jamás baja a 0.
 */
export const LEDGER_USD_DECIMALS = 4;
export const LEDGER_USD_MIN_UNIT = 0.0001;
/** Máximo absoluto representable en numeric(12,4). */
export const LEDGER_USD_MAX = 99_999_999.9999;

export class LedgerAmountError extends Error {
  constructor(readonly field: string, readonly value: unknown, detail: string) {
    super(`Importe de ledger no representable (${field}=${String(value)}): ${detail}. No se llamó al proveedor.`);
    this.name = "LedgerAmountError";
  }
}

const SCALE = 10 ** LEDGER_USD_DECIMALS;

/** Redondeo hacia arriba a 4 decimales tolerante a ruido binario (0.0001*3 no debe subir a 0.0004). */
export function ceilToLedgerUnit(x: number): number {
  const scaled = x * SCALE;
  const nearest = Math.round(scaled);
  const units = Math.abs(scaled - nearest) <= 1e-6 ? nearest : Math.ceil(scaled);
  return units / SCALE;
}

/** Importe ≥ 0 listo para numeric(12,4); lanza LedgerAmountError si no es representable de forma segura. */
export function ledgerUsd(value: unknown, field = "usd"): number {
  if (typeof value !== "number" || Number.isNaN(value)) throw new LedgerAmountError(field, value, "no es un número");
  if (!Number.isFinite(value)) throw new LedgerAmountError(field, value, "infinito");
  if (value < 0) throw new LedgerAmountError(field, value, "negativo");
  if (value === 0) return 0;
  const rounded = ceilToLedgerUnit(value);
  if (!(rounded > 0)) throw new LedgerAmountError(field, value, "un positivo no puede registrarse como 0");
  if (rounded > LEDGER_USD_MAX) throw new LedgerAmountError(field, value, "excede numeric(12,4)");
  return rounded;
}

/** Igual que ledgerUsd pero exige > 0 (tarifas facturables verificadas). */
export function ledgerBillableUsd(value: unknown, field = "usd"): number {
  const v = ledgerUsd(value, field);
  if (!(v > 0)) throw new LedgerAmountError(field, value, "una tarifa facturable debe ser positiva");
  return v;
}
