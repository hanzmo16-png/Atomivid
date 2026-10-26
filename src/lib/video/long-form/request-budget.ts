/**
 * ADVANCE 2 — Presupuesto TOTAL por pedido, aplicado en el SERVIDOR (no solo mostrado).
 *
 * - El techo autorizado sale del calculador de PR173 (`pilotBudgetEnvelope`): todas las etapas
 *   (investigación, guion, estilo, voz, imágenes, video, música, render). Una etapa sin precio
 *   verificado bloquea (no se inventan precios). No hay calculador paralelo.
 * - La autorización se guarda UNA vez por pedido (create-only). Un reintento la lee y nunca la amplía:
 *   techo efectivo = mínimo(autorización guardada, techo recalculado).
 * - Aplicación: envoltura del LedgerStore por la que pasa TODA llamada pagada (guardPaidCall →
 *   executePaidOperation). Antes de escribir una reserva nueva y otra vez antes de pasar a SUBMITTED
 *   (justo antes del proveedor) se suma: gasto ya comprometido del pedido + reservas pendientes o
 *   ambiguas + la operación nueva. Si supera el techo, la reserva propia (nunca enviada) se libera y
 *   el proveedor NO se llama.
 * - Concurrencia: «insertar y luego verificar» (la suma incluye las reservas de otros workers). Dos
 *   reservas que juntas exceden se liberan ambas o una: nunca se gasta por encima del techo.
 * - Nada ambiguo se libera como si el proveedor hubiera confirmado «sin cargo»: SUBMITTED,
 *   PROVIDER_JOB_RECORDED, RECONCILIATION_REQUIRED y los REFUNDED de rechazos con facturación incierta
 *   cuentan por su importe reservado.
 */
import { LEDGER_USD_DECIMALS } from "@/lib/paid-calls/ledger-usd";
import type { LedgerStore, PaidOperation, PaidOpStatus } from "@/lib/production-intelligence/ledger";
import { pilotBudgetEnvelope, PILOT_COST_STAGES, type PilotBudgetEnvelope, type PilotCostStage, type PilotStageEstimate } from "./pilot-budget-envelope";

const SCALE = 10 ** LEDGER_USD_DECIMALS;
const units = (usd: number) => Math.round(usd * SCALE);
const usd = (u: number) => u / SCALE;

/** resultRef de una reserva propia liberada por el presupuesto del pedido ANTES de llamar al proveedor. */
export const RELEASED_REQUEST_BUDGET_REF = "released:request-budget-exceeded";

export type RequestBudgetAuthorization = {
  version: 1;
  requestId: string;
  ceilingUsd: number;
  stageCeilings: Record<PilotCostStage, number | null>;
  contingencyPct: number;
  /** Proyectos del ledger que cuentan para este pedido (el propio pedido + el del guion/investigación). */
  ledgerScopes: string[];
  authorizedAt: string;
};

export type RequestSpend = { committedUsd: number; pendingUsd: number; totalUsd: number; byStatus: Partial<Record<PaidOpStatus, number>> };

/** Importe que una operación compromete del presupuesto del pedido (conservador ante la ambigüedad). */
export function operationExposureUsd(op: PaidOperation): number {
  const reserved = op.reservedUsd ?? 0;
  const committed = op.committedUsd ?? 0;
  switch (op.status) {
    case "COMMITTED":
      return committed;
    case "RESERVED":
    case "SUBMITTED":
    case "PROVIDER_JOB_RECORDED":
    case "RECONCILIATION_REQUIRED":
      return Math.max(reserved, committed);
    case "REFUNDED": {
      const ref = op.resultRef ?? "";
      // Liberadas antes de llamar (nunca enviadas) o rechazo final confirmado antes de aceptar: 0.
      if (ref.startsWith("released:") || ref.startsWith("rejected:rejected_final:")) return 0;
      // Reembolso respaldado por evidencia del proveedor (reconcileWithProviderEvidence not_charged).
      if (ref.startsWith("reconciled:not_charged:")) return 0;
      // Cualquier otro REFUNDED (rechazo con facturación incierta, origen desconocido): cuenta lo reservado.
      return Math.max(reserved, committed);
    }
  }
}

export function requestSpend(ops: PaidOperation[]): RequestSpend {
  let committed = 0;
  let pending = 0;
  const byStatus: Partial<Record<PaidOpStatus, number>> = {};
  for (const op of ops) {
    const u = units(operationExposureUsd(op));
    byStatus[op.status] = usd((units(byStatus[op.status] ?? 0)) + u);
    if (op.status === "COMMITTED") committed += u;
    else pending += u;
  }
  return { committedUsd: usd(committed), pendingUsd: usd(pending), totalUsd: usd(committed + pending), byStatus };
}

export class RequestBudgetNotAuthorizedError extends Error {
  constructor(readonly envelope: PilotBudgetEnvelope) {
    super(`Presupuesto total del pedido NO autorizable: ${envelope.blockers.join(", ")}. No se ha llamado a ningún proveedor de pago.`);
    this.name = "RequestBudgetNotAuthorizedError";
  }
}

export class RequestBudgetExceededError extends Error {
  readonly recoverable = false;
  constructor(readonly detail: { ceilingUsd: number; spentUsd: number; newUsd: number; key: string }) {
    super(
      `PRESUPUESTO TOTAL DEL PEDIDO: la operación ${detail.key} (USD ${detail.newUsd.toFixed(4)}) llevaría el pedido a ` +
        `USD ${(detail.spentUsd + detail.newUsd).toFixed(4)} sobre un techo autorizado de USD ${detail.ceilingUsd.toFixed(4)} ` +
        `(ya comprometido o pendiente: USD ${detail.spentUsd.toFixed(4)}). No se llamó al proveedor; ampliar el techo exige una nueva autorización.`,
    );
    this.name = "RequestBudgetExceededError";
  }
}

export type AuthorizationStore = {
  read(requestId: string): Promise<RequestBudgetAuthorization | null>;
  /** Create-only: false si ya existe una autorización (nunca la sobrescribe). */
  create(auth: RequestBudgetAuthorization): Promise<boolean>;
};

export function memoryAuthorizationStore(): AuthorizationStore & { rows: Map<string, RequestBudgetAuthorization> } {
  const rows = new Map<string, RequestBudgetAuthorization>();
  return {
    rows,
    async read(id) { return rows.get(id) ?? null; },
    async create(a) { if (rows.has(a.requestId)) return false; rows.set(a.requestId, { ...a }); return true; },
  };
}

type StorageLike = { storage: { from(bucket: string): { download(p: string): Promise<{ data: { text(): Promise<string> } | null; error: unknown }>; upload(p: string, body: Buffer, o?: { contentType?: string; upsert?: boolean }): Promise<{ error: unknown }> } } };
export function storageAuthorizationStore(supabase: StorageLike, bucket: string): AuthorizationStore {
  const path = (id: string) => `${id}/state/request-budget.json`;
  return {
    async read(id) {
      const { data, error } = await supabase.storage.from(bucket).download(path(id));
      if (error || !data) return null;
      const parsed = JSON.parse(await data.text()) as RequestBudgetAuthorization;
      return parsed?.version === 1 && parsed.requestId === id && Number.isFinite(parsed.ceilingUsd) ? parsed : null;
    },
    async create(a) {
      if (await this.read(a.requestId)) return false;
      // upsert:false → el storage rechaza sobrescribir: la primera autorización gana.
      const { error } = await supabase.storage.from(bucket).upload(path(a.requestId), Buffer.from(JSON.stringify(a, null, 2)), { contentType: "application/json", upsert: false });
      return !error;
    },
  };
}

/**
 * Autoriza (o relee) el techo total del pedido. Nunca amplía una autorización existente.
 * `hardMaxUsd` = techo de producto/entorno (LONG_FORM_MAX_TOTAL_USD); el techo efectivo nunca lo supera.
 */
export async function authorizeRequestBudget(input: {
  requestId: string;
  stages: PilotStageEstimate[];
  contingencyPct?: number;
  hardMaxUsd: number;
  ledgerScopes: string[];
  store: AuthorizationStore;
  now?: () => string;
}): Promise<RequestBudgetAuthorization> {
  const existing = await input.store.read(input.requestId);
  const envelope = pilotBudgetEnvelope(input.stages, input.contingencyPct ?? 20);
  if (existing) {
    // Reintento: se respeta la autorización original. Si el recálculo pide más, NO se amplía.
    const recalculated = envelope.proposedAuthorizationCeilingUsd;
    // El techo de producto/entorno vigente (hardMax) se aplica SIEMPRE, también cuando el recálculo no es verificable.
    const hardMax = Number.isFinite(input.hardMaxUsd) ? Math.max(0, input.hardMaxUsd) : 0;
    const ceilingUsd = Math.min(existing.ceilingUsd, hardMax, recalculated === null ? Infinity : Math.max(recalculated, 0));
    return { ...existing, ceilingUsd, ledgerScopes: [...new Set([...existing.ledgerScopes, ...input.ledgerScopes])] };
  }
  if (!envelope.ready || envelope.proposedAuthorizationCeilingUsd === null) throw new RequestBudgetNotAuthorizedError(envelope);
  // The stages alone (before contingency) must fit the product/environment ceiling. Otherwise clipping to hardMax
  // would authorize less than the plan itself needs and the production could stop half-way, after paying voice and
  // images. Only the contingency may be clipped.
  const hardMaxUsd = Number.isFinite(input.hardMaxUsd) ? Math.max(0, input.hardMaxUsd) : 0;
  if ((envelope.subtotalUsd ?? Infinity) > hardMaxUsd) {
    throw new RequestBudgetNotAuthorizedError({ ...envelope, ready: false,
      blockers: [...envelope.blockers, `subtotal_exceeds_ceiling:${(envelope.subtotalUsd ?? 0).toFixed(2)}>${hardMaxUsd.toFixed(2)}`] });
  }
  const auth: RequestBudgetAuthorization = {
    version: 1,
    requestId: input.requestId,
    ceilingUsd: Math.min(envelope.proposedAuthorizationCeilingUsd, hardMaxUsd),
    stageCeilings: envelope.stageCeilings,
    contingencyPct: envelope.contingencyPct,
    ledgerScopes: [...new Set(input.ledgerScopes)],
    authorizedAt: (input.now ?? (() => new Date().toISOString()))(),
  };
  if (await input.store.create(auth)) return auth;
  // Carrera: otro worker la creó primero → manda la suya.
  const winner = await input.store.read(input.requestId);
  if (!winner) throw new Error("No se pudo crear ni leer la autorización de presupuesto del pedido");
  return { ...winner, ceilingUsd: Math.min(winner.ceilingUsd, auth.ceilingUsd) };
}

/**
 * Envoltura del ledger que aplica el techo total del pedido en cada reserva nueva y antes de cada envío.
 * Exige `listByProjects` (fail-closed: sin forma de sumar, no se paga).
 */
export function withRequestBudget(inner: LedgerStore, auth: Pick<RequestBudgetAuthorization, "ceilingUsd" | "ledgerScopes">, now: () => string = () => new Date().toISOString()): LedgerStore & { authorization: typeof auth; precheck(amountUsd: number, label?: string): Promise<void> } {
  if (!inner.listByProjects) throw new Error("El ledger no permite sumar el gasto del pedido (listByProjects): no se paga sin presupuesto total aplicable");
  const ceiling = units(auth.ceilingUsd);
  const scopes = [...new Set(auth.ledgerScopes)];
  const check = async (op: PaidOperation) => {
    const ops = await inner.listByProjects!(scopes);
    const others = ops.filter((o) => o.idempotencyKey !== op.idempotencyKey);
    const spent = units(requestSpend(others).totalUsd);
    const mine = units(Math.max(op.reservedUsd ?? 0, op.committedUsd ?? 0));
    return { ok: spent + mine <= ceiling, spent, mine };
  };
  const exceeded = (op: PaidOperation, c: { spent: number; mine: number }) =>
    new RequestBudgetExceededError({ ceilingUsd: usd(ceiling), spentUsd: usd(c.spent), newUsd: usd(c.mine), key: op.idempotencyKey });
  /** Tras escribir la reserva (carrera con otro worker): si ya no cabe, se libera la PROPIA reserva, nunca enviada. */
  const verify = async (op: PaidOperation) => {
    const c = await check(op);
    if (!c.ok) {
      await inner.update(op.idempotencyKey, "RESERVED", { status: "REFUNDED", committedUsd: 0, resultRef: RELEASED_REQUEST_BUDGET_REF, updatedAt: now() }).catch(() => false);
      throw exceeded(op, c);
    }
  };
  const wrapped: LedgerStore & { authorization: typeof auth; precheck(amountUsd: number, label?: string): Promise<void> } = {
    authorization: auth,
    /** Comprobación SIN escribir nada (p. ej. antes de que la caché TTS marque STARTED). */
    async precheck(amountUsd, label = "pre-reserva") {
      const probe = { idempotencyKey: `precheck:${label}`, reservedUsd: amountUsd, committedUsd: null } as PaidOperation;
      const c = await check(probe);
      if (!c.ok) throw exceeded(probe, c);
    },
    get: (k) => inner.get(k),
    listByProjects: (ids) => inner.listByProjects!(ids),
    async insert(op) {
      if (!scopes.includes(op.projectId)) throw new Error(`operación fuera del pedido presupuestado (${op.projectId})`);
      // Caso normal: si no cabe, no se escribe NADA (un reintento con presupuesto puede usar la misma clave).
      const pre = await check(op);
      if (!pre.ok && !(await inner.get(op.idempotencyKey))) throw exceeded(op, pre);
      const ok = await inner.insert(op);
      if (!ok) return false; // ya existía: no añade gasto (COMMITTED se reutiliza, vivo/ambiguo ya cuenta)
      await verify(op);
      return true;
    },
    async update(key, expected, patch) {
      if (expected === "RESERVED" && patch.status === "SUBMITTED") {
        const cur = await inner.get(key);
        if (cur) await verify(cur);
      }
      return inner.update(key, expected, patch);
    },
  };
  if (inner.submit) {
    wrapped.submit = async (op, at) => {
      const cur = (await inner.get(op.idempotencyKey)) ?? op;
      await verify(cur);
      return inner.submit!(op, at);
    };
  }
  return wrapped;
}

export { PILOT_COST_STAGES };
