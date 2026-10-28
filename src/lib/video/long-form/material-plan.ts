/**
 * Preflight de MATERIAL al configurar (incidente 2026-10-28, «Un día en la sabana africana»: la página mostró
 * «Económico» sin impedimento y la producción se detuvo a los 2 minutos con 34 escenas sin material).
 *
 * Mismo `materialAvailabilityPreflight` que produce() ejecuta antes de gastar (búsquedas gratuitas de archivo, mismo
 * criterio de pertinencia y unicidad), ahora ANTES de confirmar:
 *  - Económico (sin imágenes IA): una carencia inevitable se muestra y bloquea la confirmación (`unavoidable_gap`).
 *  - Equilibrado / Cinemático: cada escena de archivo sin material pertinente y único pasa a imagen IA (la ruta de
 *    imagen generada de siempre). El plan se recalcula con esas escenas, así su conteo, la allocation confirmada,
 *    el costo y el techo mostrado incluyen exactamente esas imágenes; después se vuelve a comprobar ese plan.
 *  - Si el proveedor de archivo falla, no se sabe: no se promueve nada y se informa (`temporary_error`).
 * La comprobación de produce() se mantiene como guarda final (las duraciones reales y la disponibilidad cambian).
 * Nunca relaja una protección: las escenas de identidad o prueba sin contrato no se promueven, y los topes de
 * imágenes/USD del plan siguen decidiendo (una escena sin capacidad vuelve a archivo y queda como carencia).
 */
import type { FootageCandidate, FootageProvider } from "@/lib/providers/types";
import { getFootageProvider } from "@/lib/providers/footage";
import { materialAvailabilityPreflight, type MaterialPreflight, type MaterialSearchCache } from "./material-preflight";
import { productPlan, type ProductPlanResult } from "./product-plan";
import { usesAnchoredVisuals, usesVisualIdentity, VISUAL_STRATEGIES, type VisualStrategy } from "./production-plan-types";
import { getRealLongFormProviderNames, type ProductionPlanBeatInput } from "./production-plan";

export type MaterialPlanCheck =
  | { status: "not_applicable"; reason: string }
  | { status: "ok"; promoted: number; searches: number }
  | { status: "unavoidable_gap"; missing: number; shotIds: string[]; promoted: number; searches: number }
  | { status: "temporary_error"; reason: string; searches: number };

/** Tiempo máximo de búsquedas gratuitas en una página o confirmación (el límite de Pexels puede esperar hasta 1 h). */
export const MATERIAL_CHECK_DEADLINE_MS = 75_000;

export function createMaterialSearchCache(): MaterialSearchCache {
  return new Map<string, Promise<FootageCandidate[]>>();
}

/** Proveedor real de archivo para la comprobación, o null si este entorno no lo tiene (fixture / sin clave). */
export function materialCheckFootageProvider(): FootageProvider | null {
  try {
    const provider = getFootageProvider();
    return provider.name === "fixture" ? null : provider;
  } catch {
    return null;
  }
}

/** El proveedor de la comprobación con su plazo ya aplicado (null si el entorno no tiene proveedor real). */
export function materialCheckProviderWithDeadline(deadlineMs = MATERIAL_CHECK_DEADLINE_MS): FootageProvider | null {
  const provider = materialCheckFootageProvider();
  return provider ? withSearchDeadline(provider, Date.now() + deadlineMs) : null;
}

/**
 * Las búsquedas de esta comprobación comparten un plazo: pasado, fallan como error temporal (la comprobación
 * informa «no se pudo comprobar» en vez de bloquear la página esperando la ventana del límite del proveedor).
 */
export function withSearchDeadline(provider: FootageProvider, deadlineAtMs: number, now: () => number = Date.now): FootageProvider {
  const race = <T>(p: Promise<T>): Promise<T> => {
    const left = deadlineAtMs - now();
    if (left <= 0) {
      p.catch(() => undefined);
      return Promise.reject(new Error("tiempo de comprobación de material agotado"));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("tiempo de comprobación de material agotado")), left);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  };
  return {
    ...provider,
    fetchFootage: (...args) => race(provider.fetchFootage(...args)),
    ...(provider.searchVideoCandidates ? { searchVideoCandidates: (...args: Parameters<NonNullable<FootageProvider["searchVideoCandidates"]>>) => race(provider.searchVideoCandidates!(...args)) } : {}),
    ...(provider.searchImageCandidates ? { searchImageCandidates: (...args: Parameters<NonNullable<FootageProvider["searchImageCandidates"]>>) => race(provider.searchImageCandidates!(...args)) } : {}),
  };
}

type CheckInput = {
  beats: ProductionPlanBeatInput[];
  topic: string;
  footageProvider: FootageProvider | null;
  searchCache?: MaterialSearchCache;
};

async function check(result: ProductPlanResult, input: CheckInput & { footageProvider: FootageProvider }): Promise<MaterialPreflight | { error: string }> {
  const plan = result.plan;
  if (!plan.allocation) return { error: "plan sin allocation" };
  try {
    return await materialAvailabilityPreflight({
      plan,
      allocation: plan.allocation,
      beats: input.beats,
      topic: input.topic,
      footageProvider: input.footageProvider,
      // Igual que produce(): solo hay ranuras de video IA si el plan las reservó.
      aiVideoEnabled: plan.allocation.maxAiVideoClips > 0,
      searchCache: input.searchCache,
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message.slice(0, 160) : "error" };
  }
}

/**
 * Plan de UNA estrategia con su comprobación de material. `build(ids)` calcula el plan (con las escenas `ids`
 * promovidas a imagen IA); se llama sin ids y, si hace falta, una vez más con las escenas sin material.
 */
export async function materialAwarePlan(input: CheckInput & { build: (materialGapImages?: string[]) => ProductPlanResult }): Promise<{ result: ProductPlanResult; material: MaterialPlanCheck }> {
  const base = input.build();
  const plan = base.plan;
  if (plan.sequences || !usesAnchoredVisuals(plan) || usesVisualIdentity(plan)) {
    // v4+/v6 ya tienen su propia comprobación previa visual; v1/v2 no seleccionan por pertinencia.
    return { result: base, material: { status: "not_applicable", reason: "el plan no usa la comprobación de material de archivo del plan estándar" } };
  }
  if (!input.footageProvider) {
    return { result: base, material: { status: "not_applicable", reason: "proveedor de archivo no configurado en este entorno; la producción lo comprobará al iniciar" } };
  }
  const deps = { ...input, footageProvider: input.footageProvider };
  const first = await check(base, deps);
  if ("error" in first) return { result: base, material: { status: "temporary_error", reason: first.error, searches: 0 } };
  if (first.status === "ok") return { result: base, material: { status: "ok", promoted: 0, searches: first.searches } };
  if (first.status === "temporary_error") return { result: base, material: { status: "temporary_error", reason: first.temporary[0]?.reason ?? "error temporal del proveedor", searches: first.searches } };

  const gap = (pre: MaterialPreflight, promoted: number, searches: number): MaterialPlanCheck =>
    ({ status: "unavoidable_gap", missing: pre.missing.length, shotIds: pre.missing.map((m) => m.shotId), promoted, searches });
  const promotable = first.missing.filter((m) => m.promotable).map((m) => m.shotId);
  if (plan.strategy === "economical" || promotable.length === 0) return { result: base, material: gap(first, 0, first.searches) };

  const promoted = input.build(promotable);
  const promotedCount = promoted.plan.materialGapImages?.length ?? 0;
  if (promotedCount === 0) return { result: base, material: gap(first, 0, first.searches) };
  const second = await check(promoted, deps);
  if ("error" in second) return { result: promoted, material: { status: "temporary_error", reason: second.error, searches: first.searches } };
  const searches = first.searches + second.searches;
  if (second.status === "ok") return { result: promoted, material: { status: "ok", promoted: promotedCount, searches } };
  if (second.status === "temporary_error") return { result: promoted, material: { status: "temporary_error", reason: second.temporary[0]?.reason ?? "error temporal del proveedor", searches } };
  return { result: promoted, material: gap(second, promotedCount, searches) };
}

/** Los tres planes de Configurar (y de su ruta de actualización) con la comprobación de material, en paralelo. */
export async function configurePlansWithMaterial(input: {
  script: { topic?: string; beats: (ProductionPlanBeatInput & { purpose?: string })[] };
  topic: string;
  durationSeconds: number | null;
  cinematicV6: boolean;
  imageProvider?: "openai" | "recraft";
  footageProvider: FootageProvider | null;
  searchCache?: MaterialSearchCache;
}): Promise<{ results: Record<VisualStrategy, ProductPlanResult>; material: Record<VisualStrategy, MaterialPlanCheck> }> {
  const beats = input.script.beats.map((b) => ({ id: b.id, type: b.type, purpose: b.purpose, narration: b.narration, visuals: b.visuals }));
  const topic = input.script.topic || input.topic;
  const searchCache = input.searchCache ?? createMaterialSearchCache();
  // Mismos proveedores que configurePlans / confirm-production.
  const providers = { ...getRealLongFormProviderNames(), ...(input.imageProvider === "recraft" ? { image: "recraft" } : {}) };
  const entries = await Promise.all(VISUAL_STRATEGIES.map(async (strategy) => {
    const out = await materialAwarePlan({
      beats, topic, footageProvider: input.footageProvider, searchCache,
      build: (materialGapImages) => productPlan({
        beats, topic, strategy, providers,
        requestedDurationSeconds: input.durationSeconds ?? undefined, cinematicV6: input.cinematicV6, materialGapImages,
      }),
    });
    return [strategy, out] as const;
  }));
  return {
    results: Object.fromEntries(entries.map(([s, o]) => [s, o.result])) as Record<VisualStrategy, ProductPlanResult>,
    material: Object.fromEntries(entries.map(([s, o]) => [s, o.material])) as Record<VisualStrategy, MaterialPlanCheck>,
  };
}
