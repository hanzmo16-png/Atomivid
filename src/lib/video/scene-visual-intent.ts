/**
 * Intención visual OBSERVABLE de una escena del Reel (narración ↔ footage).
 *
 * Traduce lo que dice la narración a criterios que un plano de stock puede mostrar:
 * acción, entorno, postura, vestuario y emoción. Ej.: «confianza profesional» →
 * ropa ejecutiva, postura erguida, caminar decidido, entorno profesional/urbano.
 *
 * Qué verifica DE VERDAD: coincidencia textual entre esos criterios y los METADATOS
 * públicos del proveedor (en Pexels: el slug de la página del video o el `alt` de la
 * foto). NO inspecciona píxeles: un slug «confident businessman walking» no garantiza
 * que el plano lo muestre. Se rotula siempre como «coincidencia en metadatos».
 *
 * Nunca puntúa atractivo físico ni identidad de género: esos términos están prohibidos
 * en el léxico (test) y se ignoran al comparar. Personas = «person/people/professional».
 *
 * Determinista, sin red ni costo: no añade proveedores ni llamadas pagadas.
 */

export type VisualFacet = "action" | "setting" | "posture" | "wardrobe" | "emotion";

export type SceneVisualIntent = {
  id: string;
  /** Resumen legible del criterio observable (logs/QA). */
  label: string;
  /** Consulta enriquecida (inglés, ≤5 palabras) que conserva los criterios clave. */
  query: string;
  /** Reformulación MÁS CORTA que sigue conservando acción + entorno (nunca «las 2 primeras palabras»). */
  fallbackQuery: string;
  facets: Partial<Record<VisualFacet, string[]>>;
  /** Señales en metadatos que contradicen la intención (p. ej. «sad» en una escena de confianza). */
  contradicts: string[];
};

type IntentRule = SceneVisualIntent & { triggers: RegExp };

const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** Términos que NUNCA se usan para puntuar ni para consultar (atractivo físico, género). */
export const FORBIDDEN_SCORING_TERMS = [
  "beautiful", "handsome", "pretty", "sexy", "hot", "attractive", "gorgeous", "cute", "model", "slim", "fit body",
  "man", "men", "woman", "women", "male", "female", "girl", "boy", "guy", "lady", "gentleman",
];

const RULES: IntentRule[] = [
  {
    id: "professional_confidence",
    label: "confianza profesional: ropa ejecutiva, postura erguida, caminar decidido, entorno profesional",
    triggers: /\b(confian\w*|segur[oa]s? de (ti|si)|camina\w* con (firmeza|seguridad|confianza)|paso firme|cabeza en alto|confiden\w*|self[- ]assur\w*|walk\w* with (confidence|purpose)|head held high)\b/,
    query: "confident professional walking city",
    fallbackQuery: "business walking",
    facets: {
      action: ["walking", "walk", "walks", "striding", "stride", "commute", "commuting"],
      setting: ["city", "office", "street", "downtown", "corporate", "building", "urban", "business district"],
      posture: ["upright", "standing tall", "head held high", "posture"],
      wardrobe: ["suit", "business", "businessperson", "businessman", "businesswoman", "formal", "blazer", "executive"],
      emotion: ["confident", "determined", "smiling", "smile", "success", "successful"],
    },
    contradicts: ["sad", "tired", "crying", "sleeping", "lying", "sick", "lonely", "depressed", "drunk", "party"],
  },
  {
    id: "personal_transformation",
    label: "transformación personal: avanzar hacia adelante, amanecer/camino, gesto decidido",
    triggers: /\b(transformacion personal|tu transformacion|transformar tu vida|cambi(a|o|ar|aste) tu vida|nueva versi[oó]n|renac\w*|empez(ar|ó) de nuevo|nuevo comienzo|evolucion personal|crec(er|imiento) personal|personal transformation|self transformation|new beginning|fresh start|reinvent\w*|become who)\b/,
    query: "person walking forward sunrise",
    fallbackQuery: "walking forward",
    facets: {
      action: ["walking", "walk", "running", "climbing", "stepping", "rising", "forward"],
      setting: ["sunrise", "road", "path", "city", "mountain", "street", "horizon"],
      posture: ["upright", "arms raised", "standing tall"],
      emotion: ["determined", "confident", "hopeful", "smiling", "happy", "freedom"],
    },
    contradicts: ["sad", "crying", "sleeping", "sick", "depressed"],
  },
  {
    id: "discipline_training",
    label: "disciplina: entrenamiento o esfuerzo físico repetido, entorno de gimnasio/exterior",
    triggers: /\b(disciplin\w*|entren\w*|constancia|esfuerzo diario|tus habitos|habitos personales|workout|training|consisten\w*)\b/,
    query: "person training workout gym",
    fallbackQuery: "workout training",
    facets: {
      action: ["training", "workout", "exercise", "running", "lifting", "push ups", "jogging"],
      setting: ["gym", "track", "park", "outdoor"],
      emotion: ["focused", "determined", "sweat"],
    },
    contradicts: ["sleeping", "lazy", "eating", "party"],
  },
  {
    id: "focused_work",
    label: "concentración: persona trabajando en escritorio/portátil, mirada al trabajo",
    triggers: /\b(enfoc\w*|concentra\w*|trabaj\w* duro|productiv\w*|metas?|objetivos?|focus\w*|deep work|hard work|goals?)\b/,
    query: "person working focused laptop",
    fallbackQuery: "working laptop",
    facets: {
      action: ["working", "typing", "writing", "planning", "studying"],
      setting: ["office", "desk", "laptop", "workspace", "notebook"],
      emotion: ["focused", "concentrated", "serious"],
    },
    contradicts: ["sleeping", "party", "vacation"],
  },
  {
    id: "doubt_struggle",
    label: "duda/dificultad: persona pensativa o abatida, entorno sobrio",
    triggers: /\b(dud\w*|miedo\w*|fracas\w*|dif[ií]cil|luch\w*|ansiedad|estr[eé]s|doubt\w*|fear\w*|fail\w*|struggl\w*|anxiety|stress\w*)\b/,
    query: "person thinking alone window",
    fallbackQuery: "thoughtful person",
    facets: {
      action: ["thinking", "sitting", "looking", "waiting"],
      setting: ["window", "room", "rain", "night"],
      emotion: ["thoughtful", "worried", "sad", "pensive", "stress"],
    },
    contradicts: ["party", "celebration", "laughing"],
  },
  {
    id: "success_celebration",
    label: "logro: gesto de celebración, brazos en alto, cumbre o meta",
    triggers: /\b([eé]xito\w*|logr\w*|ganar|victoria|celebra\w*|success\w*|achiev\w*|win|wins|winning|victory)\b/,
    query: "person celebrating success arms raised",
    fallbackQuery: "celebrating success",
    facets: {
      action: ["celebrating", "cheering", "jumping", "arms raised", "reaching"],
      setting: ["summit", "mountain", "top", "finish line", "stage"],
      emotion: ["happy", "joy", "success", "proud", "excited"],
    },
    contradicts: ["sad", "crying", "tired"],
  },
  {
    id: "calm_peace",
    label: "calma: respiración pausada, naturaleza serena, plano lento",
    triggers: /\b(calma|paz|serenidad|respira\w*|tranquil\w*|calm\w*|peace\w*|breath\w*|mindful\w*)\b/,
    query: "person breathing calm nature",
    fallbackQuery: "calm nature",
    facets: {
      action: ["breathing", "meditating", "meditation", "relaxing", "yoga"],
      setting: ["nature", "beach", "lake", "forest", "sunset", "sunrise"],
      emotion: ["calm", "peaceful", "relaxed", "serene"],
    },
    contradicts: ["traffic", "crowd", "stress", "party"],
  },
];

/** Intención observable de la escena según su narración (y sus conceptos); null si no hay una regla clara. */
export function sceneVisualIntent(narration: string | undefined, concepts: readonly string[] = []): SceneVisualIntent | null {
  const text = fold(narration?.trim() || concepts.join(" "));
  if (!text.trim()) return null;
  // Primera regla que coincide (el orden refleja especificidad: confianza profesional antes que transformación).
  const rule = RULES.find((r) => r.triggers.test(text));
  if (!rule) return null;
  const { id, label, query, fallbackQuery, facets, contradicts } = rule;
  return { id, label, query, fallbackQuery, facets, contradicts };
}

const STOP = new Set(["a", "an", "the", "of", "and", "or", "in", "on", "at", "to", "with", "for", "from", "by", "b", "roll", "stock", "video"]);
const FORBIDDEN = new Set(FORBIDDEN_SCORING_TERMS.map(fold));

function words(s: string): string[] {
  return fold(s).split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w) && !FORBIDDEN.has(w));
}
function containsTerm(desc: string, term: string): boolean {
  const t = fold(term);
  if (FORBIDDEN.has(t)) return false;
  return new RegExp(`(^|[^a-z])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(desc);
}

export type MetadataMatch = {
  /** Puntos de pertinencia (pueden ser negativos). */
  points: number;
  matchedFacets: VisualFacet[];
  contradicted: string[];
  conceptWords: string[];
  /** Explicación honesta: siempre dice que es texto de metadatos, no verificación visual. */
  reason: string;
};

/**
 * Pertinencia por METADATOS. Con intención: +2 por faceta observable presente en la descripción
 * (máx. 5 facetas → +10), −4 por cada señal contradictoria. Sin intención: +1 por palabra de
 * contenido del concepto presente (máx. +3). Sin descripción: 0 puntos y se dice.
 */
export function metadataMatch(description: string | undefined, intent: SceneVisualIntent | null, concept: string): MetadataMatch {
  if (!description || !description.trim()) {
    return { points: 0, matchedFacets: [], contradicted: [], conceptWords: [], reason: "sin metadatos descriptivos del proveedor: pertinencia NO comprobada" };
  }
  const desc = ` ${fold(description)} `;
  const matchedFacets: VisualFacet[] = [];
  const contradicted: string[] = [];
  if (intent) {
    for (const [facet, terms] of Object.entries(intent.facets) as [VisualFacet, string[]][]) {
      if (terms.some((t) => containsTerm(desc, t))) matchedFacets.push(facet);
    }
    for (const t of intent.contradicts) if (containsTerm(desc, t)) contradicted.push(t);
  }
  const descWords = new Set(words(description));
  const conceptWords = [...new Set(words(concept))].filter((w) => descWords.has(w));
  const points = intent
    ? matchedFacets.length * 2 - contradicted.length * 4
    : Math.min(3, conceptWords.length);
  const parts = intent
    ? [`criterios «${intent.id}» en metadatos: ${matchedFacets.length ? matchedFacets.join(", ") : "ninguno"}`]
    : [`palabras del concepto en metadatos: ${conceptWords.length ? conceptWords.join(", ") : "ninguna"}`];
  if (contradicted.length) parts.push(`contradice: ${contradicted.join(", ")}`);
  return { points, matchedFacets, contradicted, conceptWords, reason: `${parts.join("; ")} (${points >= 0 ? "+" : ""}${points}; coincidencia textual, no verificación visual)` };
}
