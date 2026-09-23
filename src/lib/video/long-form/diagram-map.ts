/**
 * Especificaciones DETERMINÍSTICAS (datos puros, sin IA, sin red) para los
 * shot.type "text", "diagram" y "map" — la composición Remotion
 * (remotion/LongFormDoc.tsx) las dibuja tal cual, sin interpretar ni
 * inventar nada. Para contenido geográfico/arqueológico esto es
 * deliberado: un mapa o diagrama generado por IA puede alucinar
 * posiciones o relaciones que parecen precisas sin serlo — dibujar a
 * partir de datos explícitos (coordenadas, etiquetas) es la única forma
 * de garantizar que lo que se muestra es exactamente lo que alguien
 * verificó, nunca una aproximación visual plausible.
 *
 * Los `buildFixture*` de este archivo producen datos de EJEMPLO,
 * explícitamente marcados como tales (`isFixture: true` + etiquetas con
 * "(fixture)") — nunca deben presentarse como investigación real. El
 * guion real (Fase B) deberá construir estas mismas specs a partir de un
 * research pack verificado, no de estos generadores de prueba.
 */

export type DiagramNode = {
  id: string;
  label: string;
  /** Posición normalizada (0-1) dentro del lienzo del diagrama. */
  x: number;
  y: number;
};

export type DiagramEdge = {
  from: string;
  to: string;
  label?: string;
};

export type DiagramSpec = {
  kind: "diagram";
  title: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  isFixture: boolean;
};

export type MapMarker = {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
};

export type MapBounds = {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
};

export type MapSpec = {
  kind: "map";
  title: string;
  bounds: MapBounds;
  markers: MapMarker[];
  isFixture: boolean;
};

export type TextCardSpec = {
  kind: "text";
  title: string;
  body: string;
  /** Fuente citada, si aplica — refuerza en pantalla la distinción hecho/interpretación. */
  citation?: string;
  isFixture: boolean;
};

export type DocumentaryGraphicSpec = DiagramSpec | MapSpec | TextCardSpec;

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Proyección equirrectangular simple (suficiente para un mapa ilustrativo, no de navegación) dentro del bounding box declarado. */
export function projectMarker(marker: MapMarker, bounds: MapBounds): { xNorm: number; yNorm: number } {
  const lonSpan = bounds.maxLon - bounds.minLon;
  const latSpan = bounds.maxLat - bounds.minLat;
  if (lonSpan <= 0 || latSpan <= 0) {
    throw new Error("projectMarker: bounds inválidos (minLon/minLat deben ser menores que max)");
  }
  const xNorm = clamp01((marker.longitude - bounds.minLon) / lonSpan);
  // La latitud crece hacia el norte; en pantalla "arriba" es yNorm=0.
  const yNorm = clamp01(1 - (marker.latitude - bounds.minLat) / latSpan);
  return { xNorm, yNorm };
}

export function validateDiagramSpec(spec: DiagramSpec): void {
  if (spec.nodes.length === 0) throw new Error("DiagramSpec necesita al menos un nodo");
  const ids = new Set(spec.nodes.map((n) => n.id));
  for (const edge of spec.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      throw new Error(`DiagramSpec: edge referencia un nodo inexistente (${edge.from} -> ${edge.to})`);
    }
  }
}

export function validateMapSpec(spec: MapSpec): void {
  if (spec.markers.length === 0) throw new Error("MapSpec necesita al menos un marcador");
  for (const marker of spec.markers) {
    projectMarker(marker, spec.bounds); // lanza si el marcador queda fuera de un bounds mal formado
  }
}

// --- Generadores FIXTURE (datos de ejemplo, nunca investigación real) -----

export function buildFixtureTextCardSpec(shotId: string, narrationSnippet: string): TextCardSpec {
  return {
    kind: "text",
    title: `Tarjeta de texto (fixture) — ${shotId}`,
    body: narrationSnippet.slice(0, 140),
    isFixture: true,
  };
}

export function buildFixtureDiagramSpec(shotId: string): DiagramSpec {
  const spec: DiagramSpec = {
    kind: "diagram",
    title: `Diagrama de ejemplo (fixture) — ${shotId}`,
    nodes: [
      { id: "a", label: "Elemento A (fixture)", x: 0.2, y: 0.3 },
      { id: "b", label: "Elemento B (fixture)", x: 0.5, y: 0.7 },
      { id: "c", label: "Elemento C (fixture)", x: 0.8, y: 0.3 },
    ],
    edges: [
      { from: "a", to: "b", label: "relación de prueba" },
      { from: "b", to: "c" },
    ],
    isFixture: true,
  };
  validateDiagramSpec(spec);
  return spec;
}

export function buildFixtureMapSpec(shotId: string): MapSpec {
  // Coordenadas de EJEMPLO (no representan un sitio real) — el research
  // pack de Fase B debe sustituir esto por coordenadas verificadas.
  const spec: MapSpec = {
    kind: "map",
    title: `Mapa de ejemplo (fixture) — ${shotId}`,
    bounds: { minLat: 0, maxLat: 10, minLon: 0, maxLon: 10 },
    markers: [
      { id: "site", label: "Sitio de ejemplo (fixture)", latitude: 5, longitude: 5 },
      { id: "ref", label: "Referencia (fixture)", latitude: 8, longitude: 2 },
    ],
    isFixture: true,
  };
  validateMapSpec(spec);
  return spec;
}
