/**
 * ADVANCE 1 — Preflight de DISPONIBILIDAD de material, antes de cualquier llamada pagada.
 *
 * El ensayo 1080p (T-20261021-0530) detectó 31 escenas con «Material pendiente» solo DESPUÉS de pagar
 * voz e imágenes. Este preflight reconstruye las escenas del plan CONFIRMADO con duraciones estimadas
 * (mismo `planShotsFromScript` + `allocateShotTypes` con los mismos límites que usa produce()), y para
 * cada escena de archivo consulta el proveedor de stock elegido (búsqueda gratuita) con el MISMO criterio
 * de elegibilidad por metadatos que la selección real (`screenCandidate`), reservando cada candidato para
 * una sola escena (el registro de identidad prohíbe repetir recursos).
 *
 * Clasificación por escena:
 *  - available      → hay un candidato pertinente y único (o el recurso ya está guardado de un intento anterior).
 *  - generatable    → la escena es imagen/video IA dentro de la allocation aprobada (no se paga aquí).
 *  - deterministic  → tarjeta/diagrama/mapa del propio render.
 *  - nonexistent    → el proveedor responde, pero no hay material pertinente y único → carencia INEVITABLE.
 *  - temporary      → el proveedor falló (red/HTTP): no se sabe; estado recuperable, no se gasta.
 *
 * Límites (por eso la puerta FINAL de entrega se mantiene): las duraciones son estimadas (la allocation
 * real puede mover una escena), y lo que solo se sabe tras descargar (contenido duplicado por hash,
 * verificación de contenido, descarga fallida) no se comprueba aquí. La disponibilidad puede cambiar.
 */
import type { FootageCandidate, FootageProvider } from "@/lib/providers/types";
import { canonicalizeUrl } from "./asset-identity";
import { allocateShotTypes, getGenerativeUnitCosts, limitsWithinAllocation, planShotsFromScript, strategyLimits, type AllocatedShot, type ProductionPlanBeatInput } from "./production-plan";
import { usesAnchoredVisuals, usesVisualIdentity, type ProductionPlan, type ProductionPlanAllocation } from "./production-plan-types";
import { screenCandidate, searchCandidatesStrict, selectionQueries } from "./stock-selection";
import { requiresEvidence, requiresIdentity, type BeatVisual } from "./visual-intents";
import type { VerifiedAssetRegistry } from "./verified-assets";

export type MaterialShotStatus = "available" | "generatable" | "deterministic" | "nonexistent" | "temporary";
export type MaterialShotVerdict = { shotId: string; plannedType: string; status: MaterialShotStatus; reason: string };
export type MaterialPreflight = {
  status: "ok" | "unavoidable_gap" | "temporary_error";
  shots: MaterialShotVerdict[];
  missing: MaterialShotVerdict[];
  temporary: MaterialShotVerdict[];
  searches: number;
};

const STOCK_TYPES = new Set(["stock_video", "stock_image", "ken_burns_image"]);
const GENERATIVE_TYPES = new Set(["generated_placeholder", "ai_video"]);
/** Igual que shot-executor STOCK_CLIP_MARGIN_SEC (no se importa para no arrastrar el ejecutor completo). */
const CLIP_MARGIN_SEC = 1.2;

export async function materialAvailabilityPreflight(input: {
  plan: ProductionPlan;
  allocation: ProductionPlanAllocation;
  beats: ProductionPlanBeatInput[];
  topic: string;
  footageProvider: FootageProvider;
  aiVideoEnabled: boolean;
  verifiedAssets?: VerifiedAssetRegistry;
  /** Recursos ya guardados de intentos anteriores: cuentan como disponibles y su identidad queda reservada. */
  completedStock?: (shotId: string) => Promise<{ sourceId?: string; canonicalUrl?: string } | null>;
  verifyEntityLink?: Parameters<typeof screenCandidate>[3]["verifyEntityLink"];
  verifyEvidenceLink?: Parameters<typeof screenCandidate>[3]["verifyEvidenceLink"];
}): Promise<MaterialPreflight> {
  const { plan } = input;
  const anchored = usesAnchoredVisuals(plan);
  const { shots, narrationSeconds } = planShotsFromScript(input.beats, input.topic, plan.strategy, anchored, usesVisualIdentity(plan));
  const units = getGenerativeUnitCosts(plan.providers.aiVideo, plan.providers.image);
  const limits = {
    ...limitsWithinAllocation(strategyLimits(plan.strategy, plan.estimatedVoiceCostUsd ?? 0, { aiVideoEnabled: input.aiVideoEnabled, units }), input.allocation),
    cinematic: usesVisualIdentity(plan),
  };
  const allocated = allocateShotTypes(shots, narrationSeconds, limits);

  const searchCache = new Map<string, Promise<FootageCandidate[]>>();
  let searches = 0;
  const search = (provider: FootageProvider, query: string, preferVideo: boolean, minDur: number) => {
    const key = `${provider.name}|${preferVideo ? "v" : "i"}|${query}`;
    let hit = searchCache.get(key);
    if (!hit) {
      searches++;
      // Duración mínima redondeada hacia arriba al segundo: la caché no fragmenta por décimas.
      hit = searchCandidatesStrict(provider, query, preferVideo, Math.ceil(minDur));
      searchCache.set(key, hit);
    }
    return hit;
  };
  const reserved = new Set<string>();
  const keyOf = (c: { sourceId?: string; url?: string; canonicalUrl?: string }, provider: string) =>
    c.sourceId ? `${provider}#${c.sourceId}` : (c.canonicalUrl ?? (c.url ? canonicalizeUrl(c.url) : "") ?? "");

  // Primero: lo ya guardado de intentos anteriores queda reservado (un reintento nunca lo cuenta dos veces).
  const already = new Set<string>();
  if (input.completedStock) {
    for (const shot of allocated.shots) {
      const done = await input.completedStock(shot.id);
      if (done) {
        already.add(shot.id);
        const k = keyOf(done, input.footageProvider.name);
        if (k) reserved.add(k);
      }
    }
  }

  const verdicts: MaterialShotVerdict[] = [];
  // Fallo rápido: tras el primer error temporal del proveedor no se insiste escena por escena (cada búsqueda ya
  // reintenta con espera); el resultado no puede ser «ok» y el reintento del usuario repetirá la comprobación.
  let providerDown: string | null = null;
  for (const shot of allocated.shots) {
    if (providerDown && STOCK_TYPES.has(shot.type) && !already.has(shot.id)) {
      verdicts.push({ shotId: shot.id, plannedType: shot.type, status: "temporary", reason: `no comprobada: ${providerDown}` });
      continue;
    }
    const v = await judge(shot);
    if (v.status === "temporary") providerDown = v.reason;
    verdicts.push(v);
  }
  async function judge(shot: AllocatedShot): Promise<MaterialShotVerdict> {
    const base = { shotId: shot.id, plannedType: shot.type };
    if (GENERATIVE_TYPES.has(shot.type)) return { ...base, status: "generatable", reason: "generable dentro de la allocation aprobada" };
    if (!STOCK_TYPES.has(shot.type)) return { ...base, status: "deterministic", reason: "gráfico del propio render" };
    if (already.has(shot.id)) return { ...base, status: "available", reason: "recurso ya guardado (intento anterior)" };
    const visual: BeatVisual = shot.anchoredVisual ?? { description: shot.visualIntent, motion: false };
    if (requiresIdentity(visual) && !visual.identity) return { ...base, status: "nonexistent", reason: "escena de identidad sin identidad válida declarada" };
    if (requiresEvidence(visual) && !visual.evidence) return { ...base, status: "nonexistent", reason: "escena de prueba sin proposición declarada" };
    const provider = input.verifiedAssets ? input.verifiedAssets.providerFor(visual, input.footageProvider) : input.footageProvider;
    const deps = {
      footageProvider: provider,
      verifyEntityLink: input.verifiedAssets?.verifyEntityLink ?? input.verifyEntityLink,
      verifyEvidenceLink: input.verifiedAssets?.verifyEvidenceLink ?? input.verifyEvidenceLink,
    };
    const minDur = shot.durationSec + CLIP_MARGIN_SEC;
    const modes = shot.type === "stock_video" ? [true, false] : [false];
    let considered = 0;
    let duplicates = 0;
    for (const preferVideo of modes) {
      for (const [tier, query] of selectionQueries(visual).entries()) {
        let candidates: FootageCandidate[];
        try {
          candidates = await search(provider, query, preferVideo, minDur);
        } catch (err) {
          return { ...base, status: "temporary", reason: `error temporal del proveedor ${provider.name}: ${err instanceof Error ? err.message.slice(0, 120) : "error"}` };
        }
        for (const candidate of candidates) {
          considered++;
          const k = keyOf(candidate, provider.name);
          const screen = screenCandidate(visual, candidate, tier, deps);
          if ("reject" in screen) continue;
          if (k && reserved.has(k) && !screen.verifiedReuse) { duplicates++; continue; }
          if (k) reserved.add(k);
          return { ...base, status: "available", reason: `candidato pertinente y único (${query})` };
        }
      }
    }
    return {
      ...base,
      status: "nonexistent",
      reason: considered === 0
        ? "el proveedor no devolvió candidatos para esta intención"
        : `no existe material pertinente y único (${considered} evaluados, ${duplicates} ya reservados para otras escenas)`,
    };
  }

  const missing = verdicts.filter((v) => v.status === "nonexistent");
  const temporary = verdicts.filter((v) => v.status === "temporary");
  return {
    status: missing.length > 0 ? "unavoidable_gap" : temporary.length > 0 ? "temporary_error" : "ok",
    shots: verdicts,
    missing,
    temporary,
    searches,
  };
}

/** Carencia INEVITABLE detectada antes de gastar: no se llama a voz, imágenes, video ni render. */
export class LongFormMaterialUnavailableError extends Error {
  readonly recoverable = false;
  constructor(readonly missing: MaterialShotVerdict[]) {
    super(
      `IMPEDIMENTO ANTES DE GASTAR: no existe material pertinente y único para ${missing.length} escena(s) del plan confirmado ` +
        `(${missing.slice(0, 12).map((m) => `${m.shotId}: ${m.reason}`).join("; ")}${missing.length > 12 ? "; …" : ""}). ` +
        "No se ha llamado a ningún proveedor de pago (USD 0). Hace falta material verificado, otro proveedor aprobado o una adaptación editorial del plan.",
    );
    this.name = "LongFormMaterialUnavailableError";
  }
}

/** El proveedor de stock falló al comprobar disponibilidad: no se sabe si hay material. Reintentable, USD 0. */
export class LongFormMaterialPreflightTemporaryError extends Error {
  readonly recoverable = true;
  constructor(readonly temporary: MaterialShotVerdict[]) {
    super(
      `No se pudo comprobar el material (error temporal del proveedor de stock en ${temporary.length} escena(s): ${temporary[0]?.reason ?? ""}). ` +
        "No se ha gastado nada; reintenta la misma producción cuando el proveedor responda.",
    );
    this.name = "LongFormMaterialPreflightTemporaryError";
  }
}
