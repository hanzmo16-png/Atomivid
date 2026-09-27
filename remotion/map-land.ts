/**
 * Tierra real para los mapas deterministas (costas de Natural Earth, dominio
 * público; contorno de Rhode Island del U.S. Census Bureau, dominio público).
 * Datos recortados y simplificados por región en map-land.json, generado con
 * content/long-form/ocean-deep-001/build_map_land.mjs. Cada región fija sus
 * límites con proporción real en una caja 2:1 (equirectangular local).
 */
import data from "./map-land.json";

export type MapLandBounds = { minLat: number; maxLat: number; minLon: number; maxLon: number };
/** Polígonos: cada uno es una lista de anillos [lon, lat] (el primero, exterior; el resto, huecos). */
export type MapLandRegion = { bounds: MapLandBounds; land: number[][][][]; highlight?: number[][][][] };

export const MAP_LAND_SOURCE: string = data.source;
export const MAP_LAND: Record<string, MapLandRegion> = data.regions as Record<string, MapLandRegion>;

/** Proyección lineal de la región a [0,1]² — la misma que usan los marcadores. */
export function projectLonLat(lon: number, lat: number, b: MapLandBounds): { x: number; y: number } {
  return { x: (lon - b.minLon) / (b.maxLon - b.minLon), y: 1 - (lat - b.minLat) / (b.maxLat - b.minLat) };
}

/** Trazado SVG (evenodd) de un conjunto de polígonos en un lienzo W×H. */
export function landPath(polygons: number[][][][], b: MapLandBounds, W: number, H: number): string {
  const parts: string[] = [];
  for (const poly of polygons) {
    for (const ring of poly) {
      parts.push(ring.map(([lon, lat], i) => {
        const { x, y } = projectLonLat(lon, lat, b);
        return `${i === 0 ? "M" : "L"}${(x * W).toFixed(1)},${(y * H).toFixed(1)}`;
      }).join("") + "Z");
    }
  }
  return parts.join("");
}

/** Error si la región no existe o si los límites del mapa no coinciden con los suyos. */
export function mapLandIssue(landKey: string, bounds: MapLandBounds): string | null {
  const region = MAP_LAND[landKey];
  if (!region) return `región de tierra desconocida: «${landKey}»`;
  const same = (["minLat", "maxLat", "minLon", "maxLon"] as const).every((k) => Math.abs(region.bounds[k] - bounds[k]) < 1e-6);
  return same ? null : `los límites del mapa no coinciden con la región «${landKey}»`;
}
