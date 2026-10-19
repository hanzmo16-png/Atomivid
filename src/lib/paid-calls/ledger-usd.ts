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
 *  - Un positivo se redondea HACIA ARRIBA (techo exacto, sin tolerancia) a la unidad mínima registrable (0.0001 USD):
 *    resultado ≥ entrada y < entrada + 0.0001. Es un importe de RESERVA/LIQUIDACIÓN contable redondeado, nunca el
 *    costo exacto del proveedor; jamás baja a 0 ni por debajo de la entrada (0.00010000001 → 0.0002).
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

/**
 * Techo EXACTO a 4 decimales del valor decimal que representa el número (su forma más corta de ida y vuelta,
 * String(x)), con aritmética entera BigInt: nunca devuelve menos que la entrada (QA-20261019-1337/1407).
 * Sin tolerancias: un importe con ruido binario por encima de una unidad (0.1 + 0.2 = 0.30000000000000004) sube a
 * la siguiente (0.3001). Es una reserva contable conservadora; el exceso máximo es < 0.0001 USD por importe.
 */
export function ceilToLedgerUnit(x: number): number {
  if (!(x > 0)) return x === 0 ? 0 : Number.NaN;
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(x));
  if (!m) return Number.NaN;
  const digits = m[1] + (m[2] ?? ""); const exp = Number(m[3] ?? 0) - (m[2]?.length ?? 0); // x = digits · 10^exp
  const shift = exp + LEDGER_USD_DECIMALS; // unidades de 0.0001 = digits · 10^shift
  // Sin literales BigInt (target del tsconfig < ES2020).
  const TEN = BigInt(10), ZERO = BigInt(0), ONE = BigInt(1);
  let units: bigint;
  if (shift >= 0) units = BigInt(digits) * TEN ** BigInt(shift);
  else { const d = TEN ** BigInt(-shift); const n = BigInt(digits); units = n / d + (n % d === ZERO ? ZERO : ONE); }
  return Number(units) / SCALE;
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
