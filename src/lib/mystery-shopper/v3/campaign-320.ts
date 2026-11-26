import type { Catalog } from "../catalog";
import type { ProductId } from "../types";

export const ISSUE_320_REQUIRED_MISSIONS = [
  { id: "youtube-real", product: "long-form", label: "YouTube / Long Form" },
  { id: "reels-real", product: "reels", label: "Reels" },
  { id: "video-podcast-real", product: "video-podcast", label: "Podcast audiovisual" },
  { id: "audio-real-es", product: "audio-podcast", label: "Audio Podcast" },
] as const satisfies readonly { id: string; product: ProductId; label: string }[];

export type Campaign320Row = {
  id: (typeof ISSUE_320_REQUIRED_MISSIONS)[number]["id"];
  product: ProductId;
  label: string;
  catalogued: boolean;
  implementedByWorker: boolean;
  readyForRealRun: boolean;
  reason: string;
};

/**
 * Fail-closed coverage gate for issue #320.
 *
 * This does not execute a provider or certify a product. It only prevents a
 * partial implementation from being described as a complete four-product
 * campaign. `workerMissionIds` must come from the executable worker inventory,
 * never from the desired campaign matrix itself.
 */
export function campaign320Coverage(
  catalog: Catalog,
  workerMissionIds: ReadonlySet<string>,
): Campaign320Row[] {
  const catalogById = new Map(catalog.missions.map((mission) => [mission.id, mission]));

  return ISSUE_320_REQUIRED_MISSIONS.map((required) => {
    const mission = catalogById.get(required.id);
    const catalogued = mission?.product === required.product;
    const implementedByWorker = workerMissionIds.has(required.id);
    const readyForRealRun = catalogued && implementedByWorker;
    const reason = !catalogued
      ? `Falta ${required.id} en el catálogo real.`
      : !implementedByWorker
        ? `El worker todavía no ejecuta ${required.id}.`
        : "Disponible para preflight; aún requiere evidencia real.";

    return { ...required, catalogued, implementedByWorker, readyForRealRun, reason };
  });
}

export function campaign320Ready(rows: readonly Campaign320Row[]): boolean {
  return rows.length === ISSUE_320_REQUIRED_MISSIONS.length && rows.every((row) => row.readyForRealRun);
}
