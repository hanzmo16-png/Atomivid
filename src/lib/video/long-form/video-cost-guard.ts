/**
 * Barrera técnica de costo ESPECÍFICA para un video concreto (hoy: VIDEO
 * #001, Göbekli Tepe) — capa adicional sobre el presupuesto genérico de
 * Long Form (cost.ts, LONG_FORM_MAX_TOTAL_USD=$12, aplicable a cualquier
 * video). Esta capa existe porque el usuario autorizó topes MÁS
 * ESTRICTOS y específicos para este primer documental concreto:
 *   - Visual Test V2 (3 imágenes de prueba): máximo $0.50 USD.
 *   - Producción completa de VIDEO #001: hard stop de $3.00 USD
 *     incrementales (acumulado, no por-llamada).
 *
 * El registro de gasto (`CostLedger`) es PERSISTENTE en disco (ver
 * readCostLedgerFromDisk/recordSpendToDisk) precisamente para que un
 * reintento accidental — correr el script dos veces, un crash a mitad de
 * proceso, etc. — no pueda superar el hard stop: cada gasto real
 * confirmado se anota ANTES de continuar, así que la siguiente
 * invocación, aunque sea un proceso nuevo, ve el gasto acumulado real.
 *
 * Todas las funciones de decisión (assertCanSpend, totalSpentUsd) son
 * puras — no tocan disco — para que se puedan probar sin I/O. Solo
 * readCostLedgerFromDisk/recordSpendToDisk tocan el sistema de archivos.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Tope autorizado para las 3 imágenes de prueba del Visual Test V2 — ver content/long-form/gobekli-tepe-001/HANDOFF-PRODUCTION-V1.md sección 14. */
export const VISUAL_TEST_V2_MAX_USD = 0.5;

/** Hard stop incremental para TODO el gasto de producción de VIDEO #001 (Visual Test V2 incluido) — autorizado explícitamente por el usuario, no se sube sin una autorización nueva y explícita. */
export const VIDEO_001_HARD_STOP_USD = 3.0;

export type CostLedgerCategory = "visual_test_v2" | "production";

export type CostLedgerEntry = {
  timestampIso: string;
  category: CostLedgerCategory;
  amountUsd: number;
  note: string;
};

export type CostLedger = {
  videoId: string;
  entries: CostLedgerEntry[];
};

export function emptyLedger(videoId: string): CostLedger {
  return { videoId, entries: [] };
}

export function totalSpentUsd(ledger: CostLedger): number {
  return round4(ledger.entries.reduce((sum, e) => sum + e.amountUsd, 0));
}

export function spentUsdByCategory(ledger: CostLedger, category: CostLedgerCategory): number {
  return round4(ledger.entries.filter((e) => e.category === category).reduce((sum, e) => sum + e.amountUsd, 0));
}

export class VideoCostGuardExceededError extends Error {
  constructor(
    public readonly reason: "visual_test_v2_cap" | "hard_stop",
    public readonly wouldSpendUsd: number,
    public readonly capUsd: number,
  ) {
    super(
      `Barrera de costo de VIDEO #001 activada (${reason}): este gasto llevaría el total a $${wouldSpendUsd.toFixed(4)}, ` +
        `por encima del tope de $${capUsd.toFixed(2)}. No se autoriza — requiere una decisión explícita nueva del usuario, ` +
        `nunca se sube el tope automáticamente ni se reintenta de forma silenciosa.`,
    );
    this.name = "VideoCostGuardExceededError";
  }
}

/**
 * Verifica, ANTES de gastar, que sumar `amountUsd` (categoría `category`)
 * al ledger actual no rompa ni el tope específico de la categoría
 * (visual_test_v2: $0.50) ni el hard stop total de VIDEO #001 ($3.00).
 * Pura — no toca disco, no hace la llamada — solo decide si es seguro
 * continuar. Lanza VideoCostGuardExceededError si no lo es.
 */
export function assertCanSpend(ledger: CostLedger, category: CostLedgerCategory, amountUsd: number): void {
  if (amountUsd < 0) throw new Error("assertCanSpend: amountUsd no puede ser negativo");

  if (category === "visual_test_v2") {
    const wouldSpend = round4(spentUsdByCategory(ledger, "visual_test_v2") + amountUsd);
    if (wouldSpend > VISUAL_TEST_V2_MAX_USD) {
      throw new VideoCostGuardExceededError("visual_test_v2_cap", wouldSpend, VISUAL_TEST_V2_MAX_USD);
    }
  }

  const wouldSpendTotal = round4(totalSpentUsd(ledger) + amountUsd);
  if (wouldSpendTotal > VIDEO_001_HARD_STOP_USD) {
    throw new VideoCostGuardExceededError("hard_stop", wouldSpendTotal, VIDEO_001_HARD_STOP_USD);
  }
}

/** Añade un gasto YA CONFIRMADO (después de una llamada paga real exitosa) al ledger en memoria — pura, no toca disco. Vuelve a validar assertCanSpend antes de anotar: nunca se anota un gasto que rompería el guard, aunque se haya validado antes de la llamada (defensa en profundidad ante una carrera entre dos procesos). */
export function recordSpend(
  ledger: CostLedger,
  category: CostLedgerCategory,
  amountUsd: number,
  note: string,
): CostLedger {
  assertCanSpend(ledger, category, amountUsd);
  return {
    ...ledger,
    entries: [...ledger.entries, { timestampIso: new Date().toISOString(), category, amountUsd, note }],
  };
}

// --- I/O (persistencia en disco) -------------------------------------------

export function defaultLedgerPath(videoId: string): string {
  return `.atomivid-state/long-form/${videoId}-cost-ledger.json`;
}

/** Lee el ledger persistido — devuelve un ledger vacío (nunca lanza) si el archivo todavía no existe, que es el estado esperado antes del primer gasto real. */
export function readCostLedgerFromDisk(videoId: string, filePath = defaultLedgerPath(videoId)): CostLedger {
  if (!existsSync(filePath)) return emptyLedger(videoId);
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as CostLedger;
  if (parsed.videoId !== videoId) {
    throw new Error(
      `readCostLedgerFromDisk: el ledger en "${filePath}" pertenece a videoId="${parsed.videoId}", se esperaba "${videoId}" — nunca se mezclan gastos de dos videos distintos en un mismo archivo.`,
    );
  }
  return parsed;
}

/**
 * Valida y anota un gasto YA CONFIRMADO, persistiéndolo en disco de forma
 * SÍNCRONA antes de devolver — así, si el proceso se cae inmediatamente
 * después de una llamada paga real, el gasto ya quedó registrado y una
 * siguiente ejecución (aunque sea un proceso nuevo) lo ve. Nunca se llama
 * esto ANTES de que la llamada paga haya realmente ocurrido y tenga un
 * costo confirmado.
 */
export function recordSpendToDisk(
  videoId: string,
  category: CostLedgerCategory,
  amountUsd: number,
  note: string,
  filePath = defaultLedgerPath(videoId),
): CostLedger {
  const current = readCostLedgerFromDisk(videoId, filePath);
  const updated = recordSpend(current, category, amountUsd, note);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(updated, null, 2));
  return updated;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
