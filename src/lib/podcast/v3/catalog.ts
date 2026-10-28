/**
 * Podcast — catálogo de anfitriones (ampliable). Cada anfitrión trae rostro, voz y estilo de conversación estables: al
 * elegirlo se cargan su voz y su avatar (no hay que escoger voz). Son PERSONAJES VIRTUALES de Atomicvid: no se les
 * atribuyen credenciales profesionales.
 *  - Valeria Montclair: copresentadora virtual registrada por el dueño (asset de HeyGen dcf70e13…); conserva
 *    EXACTAMENTE la voz de su episodio real b9c6784d: «Callie» (7YaUDeaStRuoYg3FKsmU).
 *  - Ximena Duarte y Víctor Albarrán: personajes nuevos (retratos generados), con voces nativas en español de la cuenta.
 * Las fotos y los recortes viven en el almacenamiento PRIVADO (bucket «videos», carpeta podcast-catalog/): la página
 * los muestra con enlaces firmados; nunca en el repositorio público.
 */
export type CatalogHost = {
  id: "valeria" | "ximena" | "victor";
  name: string;
  gender: "femenino" | "masculino";
  role: string;
  description: string;
  style: string;
  personality: string;
  voiceId: string;
  voiceName: string;
  /** Muestra de voz: un fragmento ya pagado (Valeria, de su episodio real) o la muestra pública de ElevenLabs. */
  sample: { kind: "storage"; path: string } | { kind: "elevenlabs" };
  /** Foto (para el avatar de HeyGen y la foto fija de quien escucha) y recorte con alfa (vista previa del estudio). */
  photo: string;
  cutout: string;
  /** Tamaño del recorte y cara detectada en él (px), para colocarlo en su asiento igual que el render. */
  cutoutSize: [number, number];
  face: [number, number, number, number];
  /** Asset de HeyGen ya creado (Valeria): se reutiliza tal cual para no alterar su identidad. */
  heygenAsset?: string;
};

const DIR = "podcast-catalog/hosts";
export const HOST_CATALOG: CatalogHost[] = [
  { id: "valeria", name: "Valeria Montclair", gender: "femenino", role: "Anfitriona",
    description: "Cercana y curiosa; guía la conversación y aterriza las ideas para que se entiendan.",
    style: "Cálido, cercano", personality: "Curiosa, hace preguntas claras y resume lo importante",
    voiceId: "7YaUDeaStRuoYg3FKsmU", voiceName: "Callie", sample: { kind: "storage", path: `${DIR}/valeria/muestra.mp3` },
    photo: `${DIR}/valeria/foto.jpg`, cutout: `${DIR}/valeria/recorte.png`, cutoutSize: [1946, 1524], face: [758, 182, 423, 423],
    heygenAsset: "asset:dcf70e13d7b44cd2ad95836412120ab4" },
  { id: "ximena", name: "Ximena Duarte", gender: "femenino", role: "Anfitriona",
    description: "Elegante y serena; conduce con calma y da contexto a cada tema.",
    style: "Suave, pausado", personality: "Serena, contextualiza y conecta las ideas con historias",
    voiceId: "fuVibWsnIUtzBVjB2PCa", voiceName: "Ximena", sample: { kind: "elevenlabs" },
    photo: `${DIR}/ximena/foto.jpg`, cutout: `${DIR}/ximena/recorte.png`, cutoutSize: [1636, 1568], face: [605, 238, 510, 510] },
  { id: "victor", name: "Víctor Albarrán", gender: "masculino", role: "Divulgador científico (personaje virtual)",
    description: "Divulgador entusiasta: explica con ejemplos, separa los datos de las hipótesis.",
    style: "Claro, entusiasta", personality: "Explica con ejemplos y distingue lo comprobado de lo especulativo",
    voiceId: "TbvhqFC7AApJv7hnNvmY", voiceName: "Víctor", sample: { kind: "elevenlabs" },
    photo: `${DIR}/victor/foto.jpg`, cutout: `${DIR}/victor/recorte.png`, cutoutSize: [1636, 1568], face: [449, 207, 591, 591] },
];

export const catalogHost = (id: string | null | undefined) => HOST_CATALOG.find((h) => h.id === id) ?? null;
/** Referencia de avatar de un anfitrión del catálogo en la especificación del episodio. */
export const catalogRef = (id: string) => `catalogo:${id}`;
/** Una ruta pertenece al catálogo compartido (lectura permitida a cualquier episodio del estudio). */
export const isCatalogPath = (p: string) => p.startsWith(`${DIR}/`) && !p.includes("..");
