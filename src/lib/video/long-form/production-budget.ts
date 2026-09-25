/**
 * Presupuesto DURABLE de una producción de Long Form — un solo registro
 * por solicitud (no por intento), así que los topes del plan confirmado se
 * respetan aunque el worker muera y reintente.
 *
 * Reserva write-ahead: cada llamada pagada NUEVA (imagen IA, envío de
 * video IA) reserva y persiste ANTES de llamar al proveedor. Si el
 * proceso muere después de reservar, esa reserva queda contada — puede
 * sub-usar la allocation, nunca excederla. Reutilizar un asset ya
 * generado nunca reserva. Solo un fallo con costo CONOCIDO cero
 * (moderación, 4xx de validación, 429) libera su reserva.
 *
 * Un solo escritor por solicitud: el worker de GitHub Actions serializa
 * por requestId (concurrency group) y attemptState() garantiza un único
 * intento activo — no hace falta CAS sobre este archivo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProductionPlanAllocation } from "./production-plan-types";

export type BudgetDeviation = {
  shotId: string;
  planned: string;
  executed: string;
  reason: string;
  atIso: string;
};

export type ProductionBudgetState = {
  version: 1;
  allocation: ProductionPlanAllocation;
  used: { aiImageGenerations: number; aiVideoSubmits: number; generativeUsd: number };
  deviations: BudgetDeviation[];
  updatedAtIso: string;
};

export interface BudgetStore {
  load(): Promise<ProductionBudgetState | null>;
  save(state: ProductionBudgetState): Promise<void>;
}

const EPSILON = 1e-9;
const MAX_DEVIATIONS_KEPT = 500;

export class ProductionBudget {
  private constructor(
    private readonly store: BudgetStore,
    private state: ProductionBudgetState,
  ) {}

  /**
   * Abre (o crea) el presupuesto de la solicitud. Si ya existía de un
   * intento anterior conserva lo consumido; la allocation vigente es el
   * mínimo entre la guardada y la del snapshot — nunca se amplía.
   */
  static async open(store: BudgetStore, allocation: ProductionPlanAllocation): Promise<ProductionBudget> {
    const existing = await store.load();
    const now = new Date().toISOString();
    const state: ProductionBudgetState = existing
      ? {
          ...existing,
          allocation: {
            maxAiImageGenerations: Math.min(existing.allocation.maxAiImageGenerations, allocation.maxAiImageGenerations),
            maxAiVideoClips: Math.min(existing.allocation.maxAiVideoClips, allocation.maxAiVideoClips),
            maxGenerativeUsd: Math.min(existing.allocation.maxGenerativeUsd, allocation.maxGenerativeUsd),
          },
        }
      : {
          version: 1,
          allocation,
          used: { aiImageGenerations: 0, aiVideoSubmits: 0, generativeUsd: 0 },
          deviations: [],
          updatedAtIso: now,
        };
    await store.save({ ...state, updatedAtIso: now });
    return new ProductionBudget(store, state);
  }

  snapshot(): ProductionBudgetState {
    return structuredClone(this.state);
  }

  private async persist(): Promise<void> {
    this.state = { ...this.state, updatedAtIso: new Date().toISOString() };
    await this.store.save(this.state);
  }

  async reserveAiImage(usd: number): Promise<boolean> {
    const { allocation, used } = this.state;
    if (used.aiImageGenerations + 1 > allocation.maxAiImageGenerations) return false;
    if (used.generativeUsd + usd > allocation.maxGenerativeUsd + EPSILON) return false;
    this.state = { ...this.state, used: { ...used, aiImageGenerations: used.aiImageGenerations + 1, generativeUsd: used.generativeUsd + usd } };
    await this.persist();
    return true;
  }

  /** Solo para fallos con costo conocido CERO — nunca para un fallo incierto. */
  async releaseAiImage(usd: number): Promise<void> {
    const { used } = this.state;
    this.state = {
      ...this.state,
      used: { ...used, aiImageGenerations: Math.max(0, used.aiImageGenerations - 1), generativeUsd: Math.max(0, used.generativeUsd - usd) },
    };
    await this.persist();
  }

  async reserveAiVideoSubmit(usd: number): Promise<boolean> {
    const { allocation, used } = this.state;
    if (used.aiVideoSubmits + 1 > allocation.maxAiVideoClips) return false;
    if (used.generativeUsd + usd > allocation.maxGenerativeUsd + EPSILON) return false;
    this.state = { ...this.state, used: { ...used, aiVideoSubmits: used.aiVideoSubmits + 1, generativeUsd: used.generativeUsd + usd } };
    await this.persist();
    return true;
  }

  async recordDeviation(deviation: Omit<BudgetDeviation, "atIso">): Promise<void> {
    const deviations = [...this.state.deviations, { ...deviation, atIso: new Date().toISOString() }].slice(-MAX_DEVIATIONS_KEPT);
    this.state = { ...this.state, deviations };
    await this.persist();
  }
}

export function productionBudgetPath(requestId: string): string {
  return `${requestId}/state/production-budget.json`;
}

export function supabaseBudgetStore(supabase: SupabaseClient, requestId: string, bucket = "videos"): BudgetStore {
  const path = productionBudgetPath(requestId);
  return {
    async load() {
      const { data, error } = await supabase.storage.from(bucket).download(path);
      if (error || !data) return null;
      const text = await data.text();
      return text ? (JSON.parse(text) as ProductionBudgetState) : null;
    },
    async save(state) {
      const { error } = await supabase.storage
        .from(bucket)
        .upload(path, Buffer.from(JSON.stringify(state, null, 2)), { contentType: "application/json", upsert: true });
      if (error) throw new Error(`No se pudo guardar el presupuesto de producción ("${path}"): ${error.message}`);
    },
  };
}

export function memoryBudgetStore(initial: ProductionBudgetState | null = null): BudgetStore & { current(): ProductionBudgetState | null } {
  let state = initial ? structuredClone(initial) : null;
  return {
    async load() {
      return state ? structuredClone(state) : null;
    },
    async save(next) {
      state = structuredClone(next);
    },
    current: () => state,
  };
}
