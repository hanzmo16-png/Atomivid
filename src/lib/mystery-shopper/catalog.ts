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
    requestedSeconds: 600,
  },
  {
    id: "video-oceano",
    product: "video-podcast",
    title: "Video Podcast: océano profundo",
    instructions: "Océano profundo, en español, 5 minutos, 2 presentadores, estilo documental.",
    expected: "MP4 con labios sincronizados",
    publishForbidden: false,
    requestedSeconds: 300,
  },
  {
    id: "reel-universo",
    product: "reels",
    title: "Reel: tres misterios del universo",
    instructions: "Tres misterios del universo, en inglés, 30 segundos, vertical 9:16.",
    expected: "MP4 vertical 9:16",
    publishForbidden: false,
    requestedSeconds: 30,
  },
  {
    id: "longform-nazca",
    product: "long-form",
    title: "Long Form: líneas de Nazca",
    instructions: "Líneas de Nazca, en español, 15 minutos, horizontal 16:9, con capítulos y metadatos.",
    expected: "MP4 16:9 con capítulos y metadatos",
    publishForbidden: false,
    requestedSeconds: 900,
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

/**
 * Misiones 2.0 que el worker real sabe recorrer en ATOMIVID. Gratuitas: el cliente llega hasta el costo y no pulsa
 * nada facturable. Cada criterio se comprueba en pantalla o queda sin comprobar (y entonces el producto no se califica).
 */
export const LIVE_MISSIONS: Mission[] = [
  { id: "cuenta-navegacion", product: "account-nav", title: "Cuenta y navegación", instructions: "Entrar, recorrer el menú principal en el celular, cerrar sesión y volver a entrar.", expected: "Sesión estable y menú completo", publishForbidden: false, auto: true,
    criteria: ["Inicia sesión con la cuenta QA", "El menú muestra los productos", "Cada enlace principal abre sin error", "Sin desbordamiento horizontal en el celular", "Cerrar sesión funciona", "Volver a entrar recupera el panel"],
    failure: ["No se puede entrar", "Un enlace principal da error", "La sesión no se cierra"] },
  { id: "audio-proyecto-prueba", product: "audio-podcast", title: "Audio Podcast: guardar y recuperar un proyecto", instructions: "Crear un episodio de prueba con título y guion, guardarlo y recuperarlo desde la biblioteca. Sin generar voz.", expected: "Proyecto guardado y recuperable", publishForbidden: false, auto: true,
    criteria: ["Encuentra Audio Podcast desde el menú", "Crea un episodio con título", "Escribe y guarda el guion", "El presupuesto o costo se ve antes de generar", "El episodio aparece en la biblioteca", "Tras recargar, el guion sigue guardado"],
    failure: ["No se puede crear", "El guion se pierde al recargar", "No aparece en la biblioteca"] },
  { id: "video-podcast-costo", product: "video-podcast", title: "Video Podcast: configurar hasta el costo", instructions: "Configurar un episodio de 2 presentadores hasta ver el costo por proveedor, sin autorizar el cargo.", expected: "Costo por proveedor antes de autorizar", publishForbidden: false,
    criteria: ["Encuentra Podcast desde el menú", "El asistente avanza por sus pasos", "Recargar conserva el borrador", "Se ve el costo por proveedor antes de autorizar", "Sin autorización no se puede generar"],
    failure: ["El asistente se bloquea", "El borrador se pierde", "Se puede generar sin autorizar"] },
  { id: "reel-formulario", product: "reels", title: "Reel: formulario hasta el costo", instructions: "Abrir Nuevo video, elegir Reel y llenar la idea sin crear la solicitud.", expected: "Formulario claro con límites visibles", publishForbidden: false,
    criteria: ["Encuentra Nuevo video", "Se puede elegir Reel", "El campo de idea acepta texto", "Se informa el costo o el límite antes de crear"],
    failure: ["No se encuentra el formulario", "No se informa el costo"] },
  { id: "longform-formulario", product: "long-form", title: "Long Form: formulario hasta el costo", instructions: "Abrir Nuevo video de YouTube y llenar el tema sin generar el guion.", expected: "Formulario claro con costo visible", publishForbidden: false,
    criteria: ["Encuentra el video de YouTube", "El formulario acepta tema y duración", "Se informa el costo antes de generar"],
    failure: ["No se encuentra el formulario", "No se informa el costo"] },
  { id: "biblioteca-recuperar", product: "library", title: "Biblioteca: encontrar y abrir proyectos", instructions: "Abrir Mis proyectos, abrir un proyecto existente y comprobar reproducción y descarga si hay un archivo.", expected: "Proyectos visibles y recuperables", publishForbidden: false, auto: true,
    criteria: ["Se ve la lista de proyectos", "Se puede abrir un proyecto", "Si hay archivo, se reproduce", "Si hay archivo, se descarga"],
    failure: ["La biblioteca no carga", "Un proyecto no abre"] },
  { id: "command-center-panel", product: "command-center", title: "Command Center: panel carga", instructions: "Abrir el Command Center con la cuenta QA y comprobar que carga o que niega el acceso con claridad.", expected: "Panel o negación clara", publishForbidden: false,
    criteria: ["La página responde sin error", "Muestra el panel o un mensaje de acceso claro"],
    failure: ["Error del servidor"] },
];

export type Catalog = { missions: Mission[] };

export function defaultCatalog(): Catalog {
  return { missions: [...LIVE_MISSIONS, ...DEFAULT_MISSIONS].map((m) => ({ ...m })) };
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
      ...(Array.isArray(m.criteria) ? { criteria: m.criteria.map(String).slice(0, 12) } : {}),
      ...(Array.isArray(m.failure) ? { failure: m.failure.map(String).slice(0, 12) } : {}),
      ...(typeof m.requestedSeconds === "number" ? { requestedSeconds: m.requestedSeconds } : {}),
      ...(m.auto === true ? { auto: true } : {}),
    };
    assertMission(mission);
    return mission;
  });
  if (new Set(missions.map((m) => m.id)).size !== missions.length) throw new CatalogError("Hay misiones con el mismo id.");
  return { missions };
}
