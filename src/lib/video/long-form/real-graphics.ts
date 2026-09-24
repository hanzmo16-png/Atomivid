/**
 * Generador de especificaciones gráficas REALES (isFixture:false) para los
 * shots text/diagram/map de un video ya guionado y storyboardeado — a
 * diferencia de buildFixtureTextCardSpec/DiagramSpec/MapSpec (diagram-map.ts),
 * que producen datos de EJEMPLO explícitamente marcados como tales.
 *
 * No depende de ninguna llamada de red ni de IA: toma el texto ya
 * redactado en preproducción (transportado en `shot.captionText` por
 * buildShotsFromStoryboard(), ver storyboard-shots.ts) y lo estructura en
 * la forma que espera LongFormDoc.tsx. Es determinístico y gratuito, como
 * el resto de este módulo.
 *
 * Cobertura honesta: los mapas SOLO llevan coordenadas para los shots que
 * de verdad tienen una coordenada verificada asociada en el storyboard
 * (hoy: el mapa de ubicación de Göbekli Tepe). El mapa regional de Taş
 * Tepeler (b9-s1) NO inventa coordenadas por sitio para los ~12 sitios de
 * la red — eso requeriría investigación adicional no hecha en este
 * checkpoint — y en su lugar marca solo el sitio con coordenada
 * verificada, dejando el resto como contexto textual del propio título.
 */
import type { Shot } from "./types";
import {
  validateDiagramSpec,
  validateMapSpec,
  type DiagramSpec,
  type DocumentaryGraphicSpec,
  type MapSpec,
  type TextCardSpec,
} from "./diagram-map";

/** Coordenadas verificadas por shotId — mismas que gobekli-storyboard-003.json `verifiedCoordinates` (ver research-pack-002.json para el detalle de la verificación y su limitación de precisión). Mantener sincronizado si el storyboard cambia. */
const KNOWN_MAP_COORDINATES: Record<string, { latitude: number; longitude: number; label: string }> = {
  "b2-s1": { latitude: 37.22, longitude: 38.92, label: "Göbekli Tepe" },
  "b9-s1": { latitude: 37.22, longitude: 38.92, label: "Göbekli Tepe (red Taş Tepeler)" },
};

/**
 * Extrae, de un `visualIntent` con el patrón "'texto literal' — contexto"
 * (patrón usado consistentemente en gobekli-storyboard-003.json para los
 * shots de texto), la cita literal entre comillas simples y el contexto
 * restante. Si no hay comillas, usa el texto completo como cuerpo — nunca
 * lanza, nunca inventa contenido que no esté ya en el texto de entrada.
 */
export function parseQuotedIntent(visualIntent: string): { body: string; context?: string } {
  const match = visualIntent.match(/^'([^']+)'\s*[—-]?\s*(.*)$/);
  if (match) {
    return { body: match[1], context: match[2]?.trim() || undefined };
  }
  return { body: visualIntent };
}

function buildTextSpec(shot: Shot): TextCardSpec {
  const { body, context } = parseQuotedIntent(shot.captionText);
  const citation =
    shot.license && shot.license !== "ver storyboard" && !shot.license.toLowerCase().startsWith("ninguno")
      ? shot.license
      : undefined;
  return {
    kind: "text",
    title: context ?? "",
    body,
    citation,
    isFixture: false,
  };
}

/** Divide un visualIntent tipo "Título: paso1 -> paso2 -> paso3" en pasos secuenciales, si el patrón existe. */
function splitSequentialSteps(text: string): { title: string; steps: string[] } | null {
  const [head, ...rest] = text.split(":");
  const body = rest.join(":").trim();
  if (!body.includes("->")) return null;
  const steps = body
    .split("->")
    .map((s) => s.trim())
    .filter(Boolean);
  if (steps.length < 2) return null;
  return { title: head.trim(), steps };
}

function buildDiagramSpec(shot: Shot): DiagramSpec {
  const sequential = splitSequentialSteps(shot.captionText);
  let spec: DiagramSpec;
  if (sequential) {
    const n = sequential.steps.length;
    spec = {
      kind: "diagram",
      title: sequential.title,
      nodes: sequential.steps.map((label, i) => ({
        id: `n${i}`,
        label,
        // Distribución horizontal uniforme — una cadena de pasos secuenciales, sin superponerse.
        x: n === 1 ? 0.5 : (i / (n - 1)) * 0.8 + 0.1,
        y: 0.5,
      })),
      edges: sequential.steps.slice(1).map((_, i) => ({ from: `n${i}`, to: `n${i + 1}` })),
      isFixture: false,
    };
  } else {
    // Sin patrón secuencial detectable: un solo nodo central con el texto
    // completo — sigue siendo contenido REAL (no un placeholder de
    // ejemplo), solo con una disposición visual más simple.
    spec = {
      kind: "diagram",
      title: "",
      nodes: [{ id: "n0", label: shot.captionText, x: 0.5, y: 0.5 }],
      edges: [],
      isFixture: false,
    };
  }
  validateDiagramSpec(spec);
  return spec;
}

function buildMapSpec(shot: Shot): MapSpec {
  const known = KNOWN_MAP_COORDINATES[shot.id];
  if (!known) {
    throw new Error(
      `buildMapSpec: el shot ${shot.id} es de tipo "map" pero no tiene coordenadas verificadas registradas en ` +
        `KNOWN_MAP_COORDINATES — agregar la coordenada (o su ausencia documentada) antes de producir este shot.`,
    );
  }
  // Bounding box holgado (~2.5° alrededor del punto) para mostrar contexto
  // regional sin implicar precisión de zoom que no se tiene.
  const spec: MapSpec = {
    kind: "map",
    title: shot.captionText.split(":")[0]?.trim() || known.label,
    bounds: {
      minLat: known.latitude - 2.5,
      maxLat: known.latitude + 2.5,
      minLon: known.longitude - 2.5,
      maxLon: known.longitude + 2.5,
    },
    markers: [{ id: shot.id, label: known.label, latitude: known.latitude, longitude: known.longitude }],
    isFixture: false,
  };
  validateMapSpec(spec);
  return spec;
}

/**
 * GraphicSpecProvider real — mismo tipo que espera
 * ResolveShotAssetContext.graphicSpecFor en asset-resolver.ts. Se pasa en
 * lugar del provider fixture por defecto cuando se renderiza a partir de
 * un storyboard real (ver --storyboard en produce-long-form-video.ts).
 */
export function realGraphicSpecProvider(shot: Shot): DocumentaryGraphicSpec | undefined {
  switch (shot.type) {
    case "text":
      return buildTextSpec(shot);
    case "diagram":
      return buildDiagramSpec(shot);
    case "map":
      return buildMapSpec(shot);
    default:
      return undefined;
  }
}
