/**
 * Catálogo de misiones. Editable en memoria y, si hay directorio de trabajo, en un JSON local.
 * No toca código de producto ni Supabase.
 */
import { PRODUCTS, type Mission, type ProductId } from "./types";

export const DEFAULT_MISSIONS: Mission[] = [
  {
    id: "audio-flannan",
    product: "audio-podcast",
    title: "Audio Podcast: Islas Flannan",
    instructions: "Islas Flannan, en español, 10 minutos, 2 voces y música ambiental.",
    expected: "MP3",
    publishForbidden: false,
  },
  {
    id: "video-oceano",
    product: "video-podcast",
    title: "Video Podcast: océano profundo",
    instructions: "Océano profundo, en español, 5 minutos, 2 presentadores, estilo documental.",
    expected: "MP4 con labios sincronizados",
    publishForbidden: false,
  },
  {
    id: "reel-universo",
    product: "reels",
    title: "Reel: tres misterios del universo",
    instructions: "Tres misterios del universo, en inglés, 30 segundos, vertical 9:16.",
    expected: "MP4 vertical 9:16",
    publishForbidden: false,
  },
  {
    id: "longform-nazca",
    product: "long-form",
    title: "Long Form: líneas de Nazca",
    instructions: "Líneas de Nazca, en español, 15 minutos, horizontal 16:9, con capítulos y metadatos.",
    expected: "MP4 16:9 con capítulos y metadatos",
    publishForbidden: false,
  },
  {
    id: "youtube-borrador",
    product: "youtube",
    title: "YouTube: video ya autorizado",
    instructions: "Usa un video ATOMIVID ya autorizado. Evalúa la selección, el título, la descripción, las etiquetas, la miniatura, la privacidad, el borrador y la vista previa. Prohibido publicar o programar.",
    expected: "Borrador con vista previa, sin publicar ni programar",
    publishForbidden: true,
  },
];

export type Catalog = { missions: Mission[] };

export function defaultCatalog(): Catalog {
  return { missions: DEFAULT_MISSIONS.map((m) => ({ ...m })) };
}

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

const ID = /^[a-z0-9][a-z0-9-]{2,60}$/;

export function assertMission(m: Mission): void {
  if (!ID.test(m.id)) throw new CatalogError("El id de la misión no es válido.");
  if (!PRODUCTS.includes(m.product)) throw new CatalogError("El producto de la misión no existe.");
  const text = m.instructions.trim();
  if (text.length < 8 || text.length > 2000) throw new CatalogError("Las instrucciones deben tener entre 8 y 2000 caracteres.");
  if (!m.title.trim() || m.title.length > 120) throw new CatalogError("El título de la misión no es válido.");
  if (!m.expected.trim() || m.expected.length > 200) throw new CatalogError("El resultado esperado no es válido.");
  if (m.product === "youtube" && !m.publishForbidden) throw new CatalogError("La misión de YouTube no puede permitir publicar.");
  if (/publicar ahora|programar publicaci[oó]n/i.test(text) && m.product === "youtube") {
    throw new CatalogError("La misión de YouTube no puede pedir publicar ni programar.");
  }
}

export function editMission(catalog: Catalog, id: string, patch: Partial<Pick<Mission, "title" | "instructions" | "expected">>): Catalog {
  const current = catalog.missions.find((m) => m.id === id);
  if (!current) throw new CatalogError("No existe esa misión.");
  const next: Mission = {
    ...current,
    title: patch.title ?? current.title,
    instructions: patch.instructions ?? current.instructions,
    expected: patch.expected ?? current.expected,
    publishForbidden: current.product === "youtube" ? true : current.publishForbidden,
  };
  assertMission(next);
  return { missions: catalog.missions.map((m) => (m.id === id ? next : m)) };
}

export function missionById(catalog: Catalog, id: string): Mission {
  const m = catalog.missions.find((x) => x.id === id);
  if (!m) throw new CatalogError("No existe esa misión.");
  assertMission(m);
  return m;
}

export function missionsFor(catalog: Catalog, product: ProductId): Mission[] {
  return catalog.missions.filter((m) => m.product === product);
}

export function parseCatalog(raw: unknown): Catalog {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { missions?: unknown }).missions)) throw new CatalogError("El catálogo no tiene misiones.");
  const missions = (raw as { missions: unknown[] }).missions.map((item) => {
    if (!item || typeof item !== "object") throw new CatalogError("Misión ilegible.");
    const m = item as Partial<Mission>;
    const mission: Mission = {
      id: String(m.id ?? ""),
      product: m.product as ProductId,
      title: String(m.title ?? ""),
      instructions: String(m.instructions ?? ""),
      expected: String(m.expected ?? ""),
      publishForbidden: m.product === "youtube" ? true : Boolean(m.publishForbidden),
    };
    assertMission(mission);
    return mission;
  });
  if (new Set(missions.map((m) => m.id)).size !== missions.length) throw new CatalogError("Hay misiones con el mismo id.");
  return { missions };
}
