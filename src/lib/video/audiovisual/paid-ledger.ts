/**
 * Registro DURABLE de operaciones pagadas (write-ahead), independiente de
 * que el video termine. Mismo modelo que el libro de gasto ya probado en
 * las muestras de Long Form (long-form/sample-manifest.ts), generalizado
 * para Reels y reutilizable en Long Form (segunda fase):
 *
 *  1. RESERVA persistida ANTES de llamar al proveedor (si no se puede
 *     guardar, no se llama). Nunca por encima del tope.
 *  2. Llamada.
 *  3. LIQUIDACIÓN persistida:
 *     - spent: costo real (usage del proveedor) o estimado documentado;
 *     - released: fallo con costo CERO conocido (la llamada no salió o el
 *       proveedor respondió error HTTP) → no cuenta;
 *     - uncertain: pudo cobrarse (timeout, respuesta rota, proceso caído
 *       tras reservar) → cuenta por su estimación y BLOQUEA repetir la misma
 *       operación hasta que alguien la reconozca explícitamente.
 *
 * Un registro por solicitud (no por intento): el gasto de intentos
 * fallidos se conserva y el tope se aplica al acumulado. Un solo escritor
 * por solicitud (attemptState/concurrency group del worker).
 */

export type PaidOperationKind = "script" | "voice" | "voice_retime" | "image" | "video";
/** De dónde sale el importe liquidado. */
export type CostBasis = "provider_usage" | "estimated";

export type PaidOperation = {
  /** Clave de idempotencia: la misma operación con la misma entrada. */
  key: string;
  kind: PaidOperationKind;
  provider: string;
  /** Reserva conservadora antes de llamar (USD). */
  reserveUsd: number;
  label?: string;
  units?: { characters?: number; images?: number; inputChars?: number; outputChars?: number; videoSeconds?: number };
};

export type PaidEntry = PaidOperation & {
  status: "reserved" | "spent" | "released" | "uncertain";
  actualUsd?: number;
  costBasis?: CostBasis;
  note?: string;
  attempt?: number;
  reservedAtIso: string;
  settledAtIso?: string;
  /** Reconocimiento manual de una operación incierta (sigue contando; permite volver a intentarla). */
  acknowledgedAtIso?: string;
  acknowledgedNote?: string;
};

export type PaidLedgerState = { version: 1; scope: string; capUsd?: number; entries: PaidEntry[]; updatedAtIso: string };

export interface PaidLedgerStore {
  load(): Promise<PaidLedgerState | null>;
  save(state: PaidLedgerState): Promise<void>;
}

export class PaidBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaidBudgetExceededError";
  }
}

/** Hay una operación pagada con resultado incierto (o ya pagada sin resultado guardado): no se repite sola. */
export class UncertainPaidOperationError extends Error {
  constructor(public readonly key: string, detail: string) {
    super(`La operación pagada «${key}» tiene un resultado incierto (${detail}). No se repite automáticamente para no cobrarla dos veces; requiere revisión y reconocimiento explícito.`);
    this.name = "UncertainPaidOperationError";
  }
}

export class LedgerWriteError extends Error {
  constructor(detail: string) {
    super(`No se pudo guardar el registro de gasto (${detail}). No se llama al proveedor sin registro previo.`);
    this.name = "LedgerWriteError";
  }
}

/** Fallo ANTES de llamar al proveedor (p. ej. no se pudo guardar el marcador previo): costo cero seguro. */
export class NotSentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotSentError";
  }
}

export type SettleOutcome = { actualUsd?: number; costBasis: CostBasis; note?: string };
/** «not_sent» = costo cero conocido; «uncertain» = pudo cobrarse. */
export type FailureClass = "not_sent" | "uncertain";

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function entryCostUsd(e: PaidEntry): number {
  if (e.status === "released") return 0;
  if (e.status === "spent") return e.actualUsd ?? e.reserveUsd;
  return e.reserveUsd; // reserved (proceso caído) o uncertain: cuenta por la reserva
}

export function summarizeLedger(state: PaidLedgerState) {
  const byKind: Record<string, { usd: number; count: number; characters: number; images: number }> = {};
  let committed = 0;
  let uncertain = 0;
  let estimatedPortion = 0;
  for (const e of state.entries) {
    const cost = entryCostUsd(e);
    committed += cost;
    if (e.status === "uncertain" || e.status === "reserved") uncertain += cost;
    if (e.status !== "released" && (e.status !== "spent" || e.costBasis !== "provider_usage")) estimatedPortion += cost;
    if (e.status === "released") continue;
    const k = (byKind[e.kind] ??= { usd: 0, count: 0, characters: 0, images: 0 });
    k.usd = round(k.usd + cost);
    k.count += 1;
    k.characters += e.units?.characters ?? 0;
    k.images += e.units?.images ?? 0;
  }
  return {
    committedUsd: round(committed),
    uncertainUsd: round(uncertain),
    /** Parte del comprometido que es estimación (no usage medido del proveedor). */
    estimatedUsd: round(estimatedPortion),
    capUsd: state.capUsd,
    byKind,
    openUncertainKeys: latestByKey(state).filter((e) => (e.status === "uncertain" || e.status === "reserved") && !e.acknowledgedAtIso).map((e) => e.key),
  };
}

function latestByKey(state: PaidLedgerState): PaidEntry[] {
  const map = new Map<string, PaidEntry>();
  for (const e of state.entries) map.set(e.key, e);
  return [...map.values()];
}

export class PaidLedger {
  private constructor(
    private readonly store: PaidLedgerStore,
    private state: PaidLedgerState,
    private readonly now: () => Date,
  ) {}

  /**
   * Abre (o crea) el registro. El tope vigente es el MENOR entre el guardado
   * y el pedido: nunca se amplía en un reintento. `otherCommittedUsd` resta
   * lo ya comprometido fuera de este registro (p. ej. otras muestras) para
   * aplicar un tope global.
   */
  static async open(
    store: PaidLedgerStore,
    opts: { scope: string; capUsd?: number; otherCommittedUsd?: number; now?: () => Date },
  ): Promise<PaidLedger> {
    const now = opts.now ?? (() => new Date());
    const existing = await store.load();
    const requestedCap = opts.capUsd === undefined ? undefined : Math.max(0, opts.capUsd - (opts.otherCommittedUsd ?? 0));
    const capUsd =
      existing?.capUsd === undefined ? requestedCap : requestedCap === undefined ? existing.capUsd : Math.min(existing.capUsd, requestedCap);
    const state: PaidLedgerState = existing
      ? { ...existing, capUsd }
      : { version: 1, scope: opts.scope, capUsd, entries: [], updatedAtIso: now().toISOString() };
    return new PaidLedger(store, state, now);
  }

  snapshot(): PaidLedgerState {
    return structuredClone(this.state);
  }

  summary() {
    return summarizeLedger(this.state);
  }

  latest(key: string): PaidEntry | undefined {
    for (let i = this.state.entries.length - 1; i >= 0; i--) if (this.state.entries[i].key === key) return this.state.entries[i];
    return undefined;
  }

  private async persist(next: PaidLedgerState): Promise<void> {
    const stamped = { ...next, updatedAtIso: this.now().toISOString() };
    try {
      await this.store.save(stamped);
    } catch (err) {
      throw new LedgerWriteError(err instanceof Error ? err.message : String(err));
    }
    this.state = stamped;
  }

  /**
   * Ejecuta UNA operación pagada con reserva previa y liquidación durable.
   * `call` debe envolver solo la llamada al proveedor (frontera de cobro).
   */
  async run<T>(
    op: PaidOperation,
    call: () => Promise<{ value: T; settle: SettleOutcome }>,
    classifyFailure: (err: unknown) => FailureClass,
    attempt?: number,
  ): Promise<T> {
    const prev = this.latest(op.key);
    if (prev && !prev.acknowledgedAtIso) {
      if (prev.status === "reserved" || prev.status === "uncertain") throw new UncertainPaidOperationError(op.key, prev.note ?? "reserva sin liquidar de un intento anterior");
      if (prev.status === "spent") throw new UncertainPaidOperationError(op.key, "ya se pagó y su resultado no está disponible para reutilizar");
    }
    const committed = summarizeLedger(this.state).committedUsd;
    if (this.state.capUsd !== undefined && committed + op.reserveUsd > this.state.capUsd + 1e-9) {
      throw new PaidBudgetExceededError(
        `«${op.label ?? op.key}» reservaría US$${op.reserveUsd.toFixed(4)} y el comprometido es US$${committed.toFixed(4)} de un tope de US$${this.state.capUsd.toFixed(2)}. No se llamó al proveedor.`,
      );
    }
    const reservedAtIso = this.now().toISOString();
    const entry: PaidEntry = { ...op, status: "reserved", reservedAtIso, ...(attempt !== undefined ? { attempt } : {}) };
    await this.persist({ ...this.state, entries: [...this.state.entries, entry] });
    const index = this.state.entries.length - 1;

    const settle = async (patch: Partial<PaidEntry>) => {
      const entries = this.state.entries.map((e, i) => (i === index ? { ...e, ...patch, settledAtIso: this.now().toISOString() } : e));
      await this.persist({ ...this.state, entries });
    };

    let result: { value: T; settle: SettleOutcome };
    try {
      result = await call();
    } catch (err) {
      const kind = err instanceof NotSentError ? "not_sent" : classifyFailure(err);
      const note = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
      await settle(kind === "not_sent" ? { status: "released", note } : { status: "uncertain", note });
      throw err;
    }
    await settle({ status: "spent", actualUsd: result.settle.actualUsd, costBasis: result.settle.costBasis, ...(result.settle.note ? { note: result.settle.note } : {}) });
    return result.value;
  }

  /**
   * Reanuda una operación YA reservada cuyo trabajo sigue vivo en el
   * proveedor (p. ej. una operación de video aceptada cuyo sondeo se cortó):
   * NO crea una reserva nueva ni vuelve a enviar nada — liquida la MISMA
   * entrada. Solo admite una entrada reservada o incierta sin reconocer; el
   * costo ya está contado desde la reserva original.
   */
  async resumeReserved<T>(key: string, call: () => Promise<{ value: T; settle: SettleOutcome }>): Promise<T> {
    const prev = this.latest(key);
    if (!prev || (prev.status !== "reserved" && prev.status !== "uncertain") || prev.acknowledgedAtIso) {
      throw new UncertainPaidOperationError(key, "no hay una reserva abierta que reanudar");
    }
    const index = this.state.entries.lastIndexOf(prev);
    const settle = async (patch: Partial<PaidEntry>) => {
      const entries = this.state.entries.map((e, i) => (i === index ? { ...e, ...patch, settledAtIso: this.now().toISOString() } : e));
      await this.persist({ ...this.state, entries });
    };
    let result: { value: T; settle: SettleOutcome };
    try {
      result = await call();
    } catch (err) {
      const note = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
      // Una reanudación nunca libera: la operación ya existía en el proveedor.
      await settle({ status: "uncertain", note: `reanudación: ${note}` });
      throw err;
    }
    await settle({ status: "spent", actualUsd: result.settle.actualUsd, costBasis: result.settle.costBasis, ...(result.settle.note ? { note: result.settle.note } : {}) });
    return result.value;
  }

  /** Marca una operación ya pagada cuyo resultado se perdió (p. ej. fallo al guardarlo): sigue contando y bloquea repetirla. */
  async markResultLost(key: string, note: string): Promise<void> {
    const prev = this.latest(key);
    if (!prev || prev.status !== "spent") return;
    const idx = this.state.entries.lastIndexOf(prev);
    const entries = this.state.entries.map((e, i) => (i === idx ? { ...e, note } : e));
    await this.persist({ ...this.state, entries });
  }

  /**
   * Reconocimiento MANUAL (operador) de una operación incierta o pagada sin
   * resultado: su costo sigue contando y la operación puede intentarse de
   * nuevo (una nueva reserva). Nunca se usa de forma automática.
   *
   * Primitiva de bajo nivel: por sí sola NO desbloquea el marcador de imagen
   * ni el registro de voz. Para recuperar una operación usa
   * recovery.ts (recoverPaidOperation), que comprueba presupuesto y libera
   * ambos estados de forma coherente.
   */
  async acknowledge(key: string, note: string): Promise<boolean> {
    const prev = this.latest(key);
    if (!prev || prev.status === "released" || prev.acknowledgedAtIso) return false;
    const idx = this.state.entries.lastIndexOf(prev);
    const nowIso = this.now().toISOString();
    const entries = this.state.entries.map((e, i) =>
      i === idx ? { ...e, ...(e.status === "reserved" ? { status: "uncertain" as const } : {}), acknowledgedAtIso: nowIso, acknowledgedNote: note } : e,
    );
    await this.persist({ ...this.state, entries });
    return true;
  }
}

export function memoryLedgerStore(initial: PaidLedgerState | null = null): PaidLedgerStore & { saved: PaidLedgerState[]; failNextSave?: boolean } {
  let current = initial ? structuredClone(initial) : null;
  const store = {
    saved: [] as PaidLedgerState[],
    failNextSave: false,
    async load() {
      return current ? structuredClone(current) : null;
    },
    async save(state: PaidLedgerState) {
      if (store.failNextSave) {
        store.failNextSave = false;
        throw new Error("fallo simulado de escritura");
      }
      current = structuredClone(state);
      store.saved.push(structuredClone(state));
    },
  };
  return store;
}
