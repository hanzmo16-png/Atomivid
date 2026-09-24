/**
 * Convierte los shots de PLANEACIÓN de un storyboard real ya aprobado (p.
 * ej. gobekli-storyboard-003.json) en los Shot[] reales que el resto del
 * pipeline consume (asset-resolver.ts, LongFormDoc.tsx).
 *
 * A diferencia de shotsForSpan() (shots.ts) — que genera un ciclo
 * genérico de tipos de asset sin relación con ningún storyboard curado, y
 * que además marca todo como source:"fixture" sin importar el modo —
 * esta función preserva el assetType/visualIntent/queryOrPrompt/licencia
 * que ya se decidió shot por shot en preproducción, y nunca inventa un
 * shot que el storyboard no tenga.
 *
 * Las duraciones `durationApprox` del storyboard son de PLANEACIÓN — no
 * coinciden exactamente con la duración REAL narrada del beat (que solo
 * se conoce después de sintetizar la voz, ver timeline.ts). Esta función
 * escala proporcionalmente cada shot para que la suma cuadre exactamente
 * con el span real del beat, preservando el ORDEN y las proporciones
 * relativas que el storyboard ya definió — nunca recorta ni estira un
 * shot individual de forma arbitraria.
 */
import type { BeatType, Shot, ShotType } from "./types";

/** Rango de hold razonable para un storyboard CURADO (a diferencia de shots.ts, pensado para un ciclo genérico que necesitaba cortes rápidos). Un plano de 15-20s con Ken Burns lento es normal en un documental real cuando el asset fue elegido a propósito para ese momento. */
export const MIN_HOLD_SEC = 2.5;
export const MAX_HOLD_SEC = 22;

/** Mapa 1:1 con el `assetTypeMapping` ya documentado en meta.assetTypeMapping de cada storyboard — cualquier valor nuevo debe agregarse aquí Y allá. */
const ASSET_TYPE_MAP: Record<string, ShotType> = {
  stock_video: "stock_video",
  stock_image: "stock_image",
  documentary_image: "stock_image",
  map: "map",
  diagram: "diagram",
  timeline: "diagram",
  text: "text",
  ken_burns_image: "ken_burns_image",
  generated_image: "generated_placeholder",
};

export function mapStoryboardAssetType(assetType: string): ShotType {
  const mapped = ASSET_TYPE_MAP[assetType];
  if (!mapped) {
    throw new Error(
      `mapStoryboardAssetType: assetType de storyboard desconocido: "${assetType}" — agregar a ASSET_TYPE_MAP antes de usarlo.`,
    );
  }
  return mapped;
}

function sourceFor(hybridClassification: string | undefined): Shot["source"] {
  switch (hybridClassification) {
    case "AI_RECREATION":
      return "generated";
    case "REAL_DOCUMENTARY":
    case "STOCK_REAL":
      return "stock";
    case "DETERMINISTIC":
    case "TEXT":
      return "local";
    default:
      return "local";
  }
}

export type StoryboardShotInput = {
  shotId: string;
  durationApprox: number;
  assetType: string;
  visualIntent: string;
  description?: string | null;
  queryOrPrompt?: string | null;
  sourceRequirement?: string | null;
  hybridClassification?: string;
  licensing?: { status?: string } | null;
};

/** Escala los shots de planeación de UN beat a su span real narrado y los convierte a Shot[] reales. Lanza si el storyboard no tiene ningún shot para ese beat, o si tras escalar algún hold queda fuera de un rango razonable — nunca distorsiona en silencio. */
export function buildShotsFromStoryboard(input: {
  beatId: string;
  beatType: BeatType;
  startSec: number;
  endSec: number;
  storyboardShots: StoryboardShotInput[];
}): Shot[] {
  const { beatId, beatType, startSec, endSec, storyboardShots } = input;
  const span = endSec - startSec;
  if (!(span > 0)) throw new Error(`buildShotsFromStoryboard: beat ${beatId} tiene un span no positivo`);
  if (storyboardShots.length === 0) {
    throw new Error(
      `buildShotsFromStoryboard: no hay shots de storyboard para el beat ${beatId} — nunca se inventa uno en su lugar.`,
    );
  }

  const plannedTotal = storyboardShots.reduce((sum, s) => sum + s.durationApprox, 0);
  if (!(plannedTotal > 0)) {
    throw new Error(`buildShotsFromStoryboard: duración planeada total inválida para el beat ${beatId}`);
  }
  const scale = span / plannedTotal;

  const shots: Shot[] = [];
  let cursor = startSec;
  storyboardShots.forEach((sbShot, i) => {
    const isLast = i === storyboardShots.length - 1;
    const scaledDuration = sbShot.durationApprox * scale;
    const shotStart = cursor;
    // El último shot del beat siempre cierra exacto en endSec — evita que
    // el redondeo acumulado dEje un hueco o una superposición de milisegundos.
    const shotEnd = isLast ? endSec : cursor + scaledDuration;
    cursor = shotEnd;

    const shotType = mapStoryboardAssetType(sbShot.assetType);
    const isDeterministic = shotType === "text" || shotType === "diagram" || shotType === "map";
    const licenseStatus = sbShot.licensing?.status ?? (isDeterministic ? "N/A (determinístico, sin asset externo)" : "unknown");

    shots.push({
      id: sbShot.shotId,
      beatId,
      startSec: round3(shotStart),
      endSec: round3(shotEnd),
      durationSec: round3(shotEnd - shotStart),
      type: shotType,
      source: sourceFor(sbShot.hybridClassification),
      assetId: sbShot.shotId,
      visualIntent: sbShot.queryOrPrompt || sbShot.visualIntent,
      motion: shotType === "ken_burns_image" ? "ken_burns" : shotType === "stock_video" ? "pan" : "static",
      overlay: isDeterministic ? beatType.toUpperCase() : undefined,
      // OJO: `description` en el storyboard es una NOTA DE PRODUCCIÓN para
      // quien diseña el shot, no el texto a mostrar en pantalla —
      // `visualIntent` sí lleva, para los shots de texto/diagrama/mapa, la
      // cita/dato literal ya redactado (real-graphics.ts lo parsea).
      captionText: sbShot.visualIntent,
      license: sbShot.sourceRequirement || "ver storyboard",
      attribution: `ATOMIVID Long Form — storyboard shot ${sbShot.shotId}, licensing status: ${licenseStatus}`,
      dedupKey: `${beatId}:${sbShot.shotId}`,
      status: "planned",
      validationStatus: "pending",
    });
  });

  for (const shot of shots) {
    if (shot.durationSec < MIN_HOLD_SEC - 0.05 || shot.durationSec > MAX_HOLD_SEC + 0.05) {
      throw new Error(
        `buildShotsFromStoryboard: el shot ${shot.id} del beat ${beatId} quedó en ${shot.durationSec}s tras escalar ` +
          `(fuera de ${MIN_HOLD_SEC}-${MAX_HOLD_SEC}s) — la duración narrada real difiere demasiado de la ` +
          `planeada en el storyboard; revisar el guion o el storyboard antes de renderizar.`,
      );
    }
  }

  return shots;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
