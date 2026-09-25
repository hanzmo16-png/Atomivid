/**
 * Informe visual PREVIO al render (calidad visual M1): qué se va a ver en
 * cada escena, contra qué narración, de dónde viene, cuántos recursos son
 * únicos, qué se repite, qué quedó incierto y qué falta.
 *
 * Honestidad del informe:
 * - "keyword_match" = coincidencia LÉXICA entre la intención y el texto del
 *   proveedor; nunca se presenta como validación semántica de la imagen.
 * - Registros anteriores a v3 no traen identidad de contenido: sin
 *   `identityOverrides` (p. ej. hashes calculados por la auditoría) el
 *   informe NO puede detectar sus duplicados y lo declara en `limitations`.
 */
import type { AssetIdentity } from "./asset-identity";
import { hammingHex, PERCEPTUAL_DUPLICATE_MAX_DISTANCE } from "./asset-identity";
import type { ShotExecution } from "./shot-executor";
import type { Shot, ShotType } from "./types";

export const OPENING_WINDOW_SECONDS = 60;

export type VisualReportScene = {
  shotId: string;
  beatId: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  narrationFragment: string | null;
  intent: { description: string; subject?: string; place?: string; era?: string; anchoredBy?: string; reuseIndex?: number };
  plannedType: ShotType;
  executedType: ShotType;
  display: "video" | "image" | "card";
  provenance: "archival_documentary" | "stock_illustrative" | "ai_recreation" | "text_card" | "unknown";
  provider?: string;
  license?: string;
  pageUrl?: string;
  author?: string;
  assetRef?: string;
  relevance: "keyword_match" | "unverified" | "generated_from_intent" | "card" | "unknown";
  matchedTerms?: string[];
  candidateDescription?: string;
  reusedFromPreviousAttempt: boolean;
  cardTitle?: string;
  gap?: string;
  deviation?: string;
};

export type RepeatedAsset = {
  shots: string[];
  matchedBy: string[];
  /** Justificación editorial explícita; ausente = repetición NO intencional. */
  justification?: string;
};

export type VisualReport = {
  version: 1;
  requestId: string;
  planVersion: number;
  pipeline: "anchored_v1" | "legacy";
  generatedAtIso: string;
  scenes: VisualReportScene[];
  summary: {
    scenes: number;
    uniqueAssets: number;
    mediaScenes: number;
    repeatedAssets: RepeatedAsset[];
    coverageSeconds: { video: number; image: number; card: number };
    uncertainScenes: string[];
    gaps: { shotId: string; reason: string }[];
    titleCards: string[];
    openingWindow: { seconds: number; scenes: number; repeatedScenes: string[]; titleCards: string[]; uncertainScenes: string[]; gaps: string[] };
  };
  limitations: string[];
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Agrupa escenas que comparten cualquier clave de identidad (unión-búsqueda). */
function groupRepeats(entries: { shotId: string; identity?: AssetIdentity; assetRef?: string }[]): RepeatedAsset[] {
  const parent = entries.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const reasons = new Map<number, Set<string>>();
  const union = (a: number, b: number, why: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
    const root = find(a);
    const set = reasons.get(root) ?? new Set<string>();
    set.add(why);
    for (const r of reasons.get(rb) ?? []) set.add(r);
    reasons.set(root, set);
  };
  const byKey = new Map<string, number>();
  entries.forEach((e, i) => {
    const keys: [string, string | undefined][] = [
      ["sourceId", e.identity?.sourceId ? `${e.identity.provider ?? ""}:${e.identity.sourceId}` : undefined],
      ["canonicalUrl", e.identity?.canonicalUrl],
      ["sha256", e.identity?.sha256],
      ["objeto", e.assetRef],
    ];
    for (const [name, value] of keys) {
      if (!value) continue;
      const k = `${name}=${value}`;
      const prev = byKey.get(k);
      if (prev === undefined) byKey.set(k, i);
      else union(prev, i, name);
    }
  });
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i].identity?.dhash;
      const b = entries[j].identity?.dhash;
      if (a && b && hammingHex(a, b) <= PERCEPTUAL_DUPLICATE_MAX_DISTANCE) union(i, j, "hash perceptual");
    }
  }
  const groups = new Map<number, string[]>();
  entries.forEach((e, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), e.shotId]);
  });
  return [...groups.entries()].filter(([, shots]) => shots.length > 1).map(([root, shots]) => ({ shots, matchedBy: [...(reasons.get(root) ?? [])] }));
}

export function buildVisualReport(input: {
  requestId: string;
  planVersion: number;
  topic: string;
  shots: Shot[];
  executions: ShotExecution[];
  /** Identidad calculada fuera del pipeline (auditoría de registros anteriores a v3). */
  identityOverrides?: Map<string, AssetIdentity>;
  /** Ruta del objeto por escena cuando la ejecución no la trae (registros anteriores a v3). */
  objectPaths?: Map<string, string>;
  openingWindowSec?: number;
  now?: () => number;
}): VisualReport {
  const pipeline = input.planVersion >= 3 ? "anchored_v1" : "legacy";
  const topicNorm = input.topic.trim().toLowerCase();
  const scenes: VisualReportScene[] = input.shots.map((shot, i) => {
    const ex = input.executions[i];
    const meta = ex?.assetMeta;
    const isCard = ex?.asset.kind === "graphic";
    const display: VisualReportScene["display"] = isCard ? "card" : ex?.asset.kind === "media" && ex.asset.mediaType === "video" ? "video" : "image";
    const cardTitle = isCard && ex.asset.kind === "graphic" && "title" in ex.asset.graphic ? ex.asset.graphic.title : undefined;
    const provenance: VisualReportScene["provenance"] = isCard
      ? "text_card"
      : (meta?.provenance?.kind ??
        (ex?.executedType === "generated_placeholder" || ex?.executedType === "ai_video"
          ? "ai_recreation"
          : ex?.executedType === "stock_video" || ex?.executedType === "ken_burns_image" || ex?.executedType === "stock_image"
            ? "stock_illustrative"
            : "unknown"));
    const relevance: VisualReportScene["relevance"] = isCard ? "card" : (meta?.selection?.relevance ?? "unknown");
    return {
      shotId: shot.id,
      beatId: shot.beatId,
      startSec: shot.startSec,
      endSec: shot.endSec,
      durationSec: shot.durationSec,
      narrationFragment: shot.narrationFragment ?? null,
      intent: {
        description: shot.visualIntent,
        subject: shot.anchoredVisual?.subject,
        place: shot.anchoredVisual?.place,
        era: shot.anchoredVisual?.era,
        anchoredBy: shot.intentAnchor?.anchoredBy,
        reuseIndex: shot.intentAnchor?.reuseIndex,
      },
      plannedType: shot.type,
      executedType: ex?.executedType ?? shot.type,
      display,
      provenance,
      provider: meta?.provenance?.provider ?? (isCard ? "deterministic" : ex?.providerUsed),
      license: meta?.provenance?.license,
      pageUrl: meta?.provenance?.pageUrl,
      author: meta?.provenance?.author,
      assetRef: meta?.objectPath ?? input.objectPaths?.get(shot.id),
      relevance,
      matchedTerms: meta?.selection?.matchedTerms,
      candidateDescription: meta?.selection?.candidateDescription,
      reusedFromPreviousAttempt: ex?.reused ?? false,
      cardTitle,
      gap: meta?.gap?.reason,
      deviation: ex?.deviation?.reason,
    };
  });

  const media = scenes.filter((s) => s.display !== "card");
  const repeatedAssets = groupRepeats(
    media.map((s) => ({
      shotId: s.shotId,
      identity: input.identityOverrides?.get(s.shotId) ?? input.executions[input.shots.findIndex((x) => x.id === s.shotId)]?.assetMeta?.identity,
      assetRef: s.assetRef,
    })),
  );
  const repeatedExtra = repeatedAssets.reduce((sum, g) => sum + g.shots.length - 1, 0);
  const coverage = { video: 0, image: 0, card: 0 };
  for (const s of scenes) coverage[s.display] += s.durationSec;
  const titleCards = scenes.filter((s) => s.cardTitle && s.cardTitle.trim().toLowerCase() === topicNorm).map((s) => s.shotId);
  const uncertainScenes = scenes.filter((s) => s.relevance === "unverified" || s.relevance === "unknown").map((s) => s.shotId);
  const gaps = scenes.filter((s) => s.gap).map((s) => ({ shotId: s.shotId, reason: s.gap as string }));
  const windowSec = input.openingWindowSec ?? OPENING_WINDOW_SECONDS;
  const opening = scenes.filter((s) => s.startSec < windowSec);
  const openingIds = new Set(opening.map((s) => s.shotId));
  const repeatedInOpening = repeatedAssets.flatMap((g) => {
    const inside = g.shots.filter((id) => openingIds.has(id));
    return inside.length > 1 ? inside.slice(1) : [];
  });

  const limitations = [
    "La pertinencia es léxica (intención vs. texto del proveedor): no se analiza el contenido visual de la imagen.",
    "El hash perceptual es de imagen completa (y de un solo fotograma en video): no detecta recortes fuertes, espejados ni el mismo sujeto desde otro ángulo.",
  ];
  if (pipeline === "legacy" && !input.identityOverrides) {
    limitations.push("Plan anterior a v3: los registros no traen identidad de contenido; los duplicados de contenido NO se pueden detectar sin la auditoría de hashes.");
  }

  return {
    version: 1,
    requestId: input.requestId,
    planVersion: input.planVersion,
    pipeline,
    generatedAtIso: new Date((input.now ?? Date.now)()).toISOString(),
    scenes,
    summary: {
      scenes: scenes.length,
      uniqueAssets: media.length - repeatedExtra,
      mediaScenes: media.length,
      repeatedAssets,
      coverageSeconds: { video: round2(coverage.video), image: round2(coverage.image), card: round2(coverage.card) },
      uncertainScenes,
      gaps,
      titleCards,
      openingWindow: {
        seconds: windowSec,
        scenes: opening.length,
        repeatedScenes: repeatedInOpening,
        titleCards: titleCards.filter((id) => openingIds.has(id)),
        uncertainScenes: uncertainScenes.filter((id) => openingIds.has(id)),
        gaps: gaps.filter((g) => openingIds.has(g.shotId)).map((g) => g.shotId),
      },
    },
    limitations,
  };
}

export class LongFormVisualQualityError extends Error {
  constructor(readonly problems: string[]) {
    super(`El control visual previo al render no pasó: ${problems.join("; ")}. Los recursos ya obtenidos quedan guardados; un reintento no los vuelve a pagar.`);
    this.name = "LongFormVisualQualityError";
  }
}

/**
 * Control previo al render (solo planes v3): ninguna repetición de recurso
 * sin justificación y ninguna tarjeta que repita el título. Las carencias
 * no fallan aquí (ya las limita el guard de tarjetas de produce.ts), pero
 * quedan en el informe.
 */
export function assertVisualQuality(report: VisualReport): void {
  if (report.pipeline !== "anchored_v1") return;
  const problems: string[] = [];
  const unjustified = report.summary.repeatedAssets.filter((g) => !g.justification);
  if (unjustified.length > 0) problems.push(`${unjustified.length} recurso(s) repetido(s) sin justificación (${unjustified.map((g) => g.shots.join("=")).join(", ")})`);
  if (report.summary.titleCards.length > 0) problems.push(`${report.summary.titleCards.length} tarjeta(s) que repiten el título`);
  if (problems.length > 0) throw new LongFormVisualQualityError(problems);
}

/**
 * Recalcula repeticiones con identidades calculadas FUERA del pipeline
 * (auditoría de registros anteriores a v3: SHA-256/dHash de los objetos
 * descargados). No toca escenas, solo el resumen.
 */
export function applyIdentities(report: VisualReport, identities: Map<string, AssetIdentity>): VisualReport {
  const media = report.scenes.filter((s) => s.display !== "card");
  const repeatedAssets = groupRepeats(media.map((s) => ({ shotId: s.shotId, identity: identities.get(s.shotId), assetRef: s.assetRef })));
  const repeatedExtra = repeatedAssets.reduce((sum, g) => sum + g.shots.length - 1, 0);
  const openingIds = new Set(report.scenes.filter((s) => s.startSec < report.summary.openingWindow.seconds).map((s) => s.shotId));
  return {
    ...report,
    summary: {
      ...report.summary,
      uniqueAssets: media.length - repeatedExtra,
      repeatedAssets,
      openingWindow: {
        ...report.summary.openingWindow,
        repeatedScenes: repeatedAssets.flatMap((g) => {
          const inside = g.shots.filter((id) => openingIds.has(id));
          return inside.length > 1 ? inside.slice(1) : [];
        }),
      },
    },
    limitations: report.limitations.filter((l) => !l.includes("anterior a v3")).concat(
      "Identidades de contenido calculadas por la auditoría (SHA-256 + dHash de los objetos guardados); sin id del proveedor en registros anteriores a v3.",
    ),
  };
}
