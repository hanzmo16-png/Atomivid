/**
 * Intención visual REAL por shot para la ruta de producto de Long Form.
 * Antes de esto, shotsForSpan() rellenaba visualIntent con
 * "<shotType> for <beatType>" (p. ej. "generated_placeholder for hook") —
 * texto de fixture que en modo real se habría enviado tal cual como
 * búsqueda a Pexels y como prompt pagado a OpenAI.
 *
 * Fuente preferida: `visuals` que el guionista (Claude) declara por beat
 * en inglés al generar el guion (ver documentary-script.ts). Guiones sin
 * ese campo (creados antes) derivan descripciones del tema + palabras
 * clave de la narración — sin red, sin costo, nunca contenido inventado.
 */
import type { TextCardSpec } from "./diagram-map";

/**
 * Qué AFIRMA la escena (Visual Excellence V1, planes v4). La declara la misma
 * llamada del planner que escribe la escena; nunca se infiere de nombres.
 * RECONSTRUCTION no es una clase: es procedencia (ai_recreation).
 */
export const VISUAL_BEAT_CLASSES = ["IDENTITY", "PLACE", "EVIDENCE", "PROCESS", "TRANSITION", "METAPHOR"] as const;
export type VisualBeatClass = (typeof VISUAL_BEAT_CLASSES)[number];

/**
 * Persona concreta que la escena DEBE representar (Visual Excellence V1).
 * Contrato explícito: un humano genérico, una parte del cuerpo, una
 * profesión o un parecido nunca la sustituyen, y un nombre en el texto de
 * un candidato no la verifica. `sourceIds` dice qué fuentes sustentan que
 * el GUION habla de esta persona; nunca verifica que un recurso la muestre.
 * Solo los planes v4 la leen (normalizeDeclaredVisuals con identity: true).
 */
export type VisualIdentity = {
  name: string;
  kind: "person";
  /** Fuentes del research pack que anclan la identidad. */
  sourceIds?: string[];
};

/**
 * Proposición que una escena EVIDENCE debe probar (planes v4): las fuentes del
 * research pack (y, si las hay, las afirmaciones del beat) que sostienen el
 * hecho. No verifica ningún recurso por sí misma: un recurso solo prueba la
 * proposición si el verificador del servidor lo vincula a esas mismas fuentes.
 * "newspaper", "document" o "court paper" no prueban el contenido.
 */
export type VisualEvidence = {
  sourceIds: string[];
  claimIds?: string[];
};

export type BeatVisual = {
  /** Escena concreta y filmable, idealmente en inglés (búsqueda de stock y prompt de imagen/video). */
  description: string;
  /** true si la escena depende de una acción/movimiento que una imagen fija perdería (insumo del eligibility de video IA). */
  motion: boolean;
  // --- Anclaje y pertinencia (calidad visual M1, todos opcionales: guiones
  // anteriores no los traen y siguen funcionando) ---
  /** Cita LITERAL (en el idioma de la narración) del pasaje que esta escena ilustra — ancla la intención a su momento exacto. */
  quote?: string;
  /** Sujeto principal visible (en inglés), p. ej. "steam shovel". */
  subject?: string;
  /** Acción visible (en inglés), p. ej. "digging". */
  action?: string;
  /** Lugar (en inglés), p. ej. "Panama". */
  place?: string;
  /** Época (texto libre o año), p. ej. "1910s" — contexto histórico que el material NO debe contradecir. */
  era?: string;
  /** Búsquedas alternativas (en inglés) del MISMO contenido — amplían candidatos sin cambiar de tema. */
  alternates?: string[];
  /** true si NO la declaró el guionista (derivada de palabras de la narración): su pertinencia no se puede comprobar contra el texto del proveedor. */
  derived?: boolean;
  /** v4: qué afirma la escena. Ausente en guiones y planes anteriores. */
  beatClass?: VisualBeatClass;
  /** Persona que la escena exige representar; ver VisualIdentity. Nunca se copia a otras escenas del beat. */
  identity?: VisualIdentity;
  /** v4, escenas EVIDENCE: la proposición que el recurso debe probar. Sin ella, nada puede ocupar la escena. */
  evidence?: VisualEvidence;
  /**
   * v4: la clasificación es incierta o contradictoria según datos estructurados
   * del propio planner (clase ausente en un beat clasificado, o identidad en una
   * escena que no es IDENTITY). Falla cerrada: se trata como escena de identidad.
   */
  classificationGap?: true;
  /**
   * v4, escenas de CONTEXTO en un beat que declara a una persona: lo que la
   * persona hace en sus propias escenas (acción de la escena IDENTITY; sujeto y
   * acción de las escenas que fallaron cerradas), sin su nombre. Un candidato
   * que lo muestra sustituye a la persona: se rechaza aquí también. Solo
   * restringe; nunca verifica a nadie.
   */
  personActions?: string[];
};

/**
 * La escena exige una persona concreta: declaró identity, o es IDENTITY
 * aunque su identity fuera inválida (fail-closed: entonces nada la representa).
 */
export function requiresIdentity(visual: BeatVisual): boolean {
  return visual.identity !== undefined || visual.beatClass === "IDENTITY" || visual.classificationGap === true;
}

const personKey = (name: string) => name.toLowerCase().replace(/\s+/g, " ").trim();

/** Lo que hacen las personas del beat en sus propias escenas (acción de IDENTITY; sujeto y acción de las que fallaron cerradas), sin sus nombres. */
function beatPersonActions(visuals: BeatVisual[]): string[] {
  const names = new Set(visuals.flatMap((v) => (v.identity ? v.identity.name.toLowerCase().split(/\s+/) : [])));
  return [
    ...new Set(
      visuals
        .filter((v) => requiresIdentity(v))
        .flatMap((v) => (v.identity ? [v.action] : [v.subject, v.action]))
        .flatMap((text) => (text ?? "").toLowerCase().split(/[^a-z0-9]+/))
        .filter((w) => w.length >= 3 && !names.has(w)),
    ),
  ];
}

/**
 * v4: acciones de cada persona declarada en TODO el guion (por nombre declarado,
 * nunca inferido). Así una escena de contexto rechaza a quien muestra lo que la
 * persona hace aunque lo haga en otro beat, sin depender del orden de ejecución.
 */
export function personActionIndex(beats: { visuals?: unknown }[]): Map<string, string[]> {
  const index = new Map<string, Set<string>>();
  for (const beat of beats) {
    const visuals = normalizeDeclaredVisuals(beat.visuals, { identity: true });
    const actions = beatPersonActions(visuals);
    for (const v of visuals) {
      if (!v.identity) continue;
      const set = index.get(personKey(v.identity.name)) ?? new Set<string>();
      for (const a of actions) set.add(a);
      index.set(personKey(v.identity.name), set);
    }
  }
  return new Map([...index].map(([k, v]) => [k, [...v]]));
}

/** v4: la escena afirma probar un hecho; solo un recurso vinculado por el servidor a su proposición puede ocuparla. */
export function requiresEvidence(visual: BeatVisual): boolean {
  return visual.beatClass === "EVIDENCE";
}

/** Restrictividad de un contrato cuando dos escenas compiten por el MISMO tramo narrado (mayor = gana). */
export function contractRestrictiveness(visual: BeatVisual): number {
  if (visual.beatClass === undefined && !visual.identity && !visual.classificationGap) return 0;
  if (requiresIdentity(visual)) return 4;
  return visual.beatClass === "EVIDENCE" ? 3 : visual.beatClass === "PLACE" ? 2 : visual.beatClass === "PROCESS" ? 1 : 0;
}

function declaredEvidence(item: Record<string, unknown>): VisualEvidence | undefined {
  const raw = item.evidence;
  if (!raw || typeof raw !== "object") return undefined;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : []);
  const sourceIds = strings((raw as Record<string, unknown>).sourceIds);
  const claimIds = strings((raw as Record<string, unknown>).claimIds);
  if (sourceIds.length === 0) return undefined;
  return { sourceIds, ...(claimIds.length > 0 ? { claimIds } : {}) };
}

function declaredIdentity(item: Record<string, unknown>): VisualIdentity | undefined {
  const raw = item.identity;
  if (!raw || typeof raw !== "object") return undefined;
  const { name, kind, sourceIds } = raw as Record<string, unknown>;
  if (typeof name !== "string" || !name.trim() || kind !== "person") return undefined;
  const ids = Array.isArray(sourceIds) ? sourceIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((id) => id.trim()) : [];
  return { name: name.replace(/\s+/g, " ").trim().slice(0, MAX_FIELD_CHARS), kind: "person", ...(ids.length > 0 ? { sourceIds: ids } : {}) };
}

const MAX_VISUALS_PER_BEAT = 16;
const MAX_FIELD_CHARS = 80;
const MAX_DESCRIPTION_CHARS = 180;

const STOPWORDS = new Set(
  (
    "a al algo algunas algunos ante antes aquel aquella aquello aqui aquí asi así aun aún cada casi como cómo con contra cual cuál cuando cuándo de del desde donde dónde dos el él ella ellas ellos en entre era eran es esa esas ese eso esos esta está estaba estaban estas este esto estos fue fueron gran grande ha había habían han hasta hay la las le les lo los mas más me mientras mismo muy nada ni no nos nosotros o otra otras otro otros para pero poco por porque puede pueden que qué quien quién se sea ser si sí sido sin sobre solo sólo son su sus también tan tanto te tenía tiene tienen todo todos tras tu un una uno unos y ya " +
    "the of and to in is was were that this with for as on by from at are be it its an or which their they them these those than then there into over under about after before between during"
  ).split(" "),
);

function cleanDescription(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION_CHARS);
}

/**
 * Normaliza `beat.visuals` del guion (datos externos: se validan, nunca se confía en su forma).
 * `identity` (solo planes v4) lee beatClass e identity; sin él ambos se ignoran
 * y el resultado es exactamente el de v3.
 */
export function normalizeDeclaredVisuals(
  value: unknown,
  opts: {
    identity?: boolean;
    /** v4: acciones de cada persona en TODO el documento (personActionIndex) — lo que hace una persona es suyo en cualquier beat. */
    personActions?: Map<string, string[]>;
  } = {},
): BeatVisual[] {
  if (!Array.isArray(value)) return [];
  const out: BeatVisual[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const description = (item as { description?: unknown }).description;
    if (typeof description !== "string" || !description.trim()) continue;
    const field = (key: string): string | undefined => {
      const v = (item as Record<string, unknown>)[key];
      return typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, key === "quote" ? MAX_DESCRIPTION_CHARS : MAX_FIELD_CHARS) : undefined;
    };
    const rawAlternates = (item as { alternates?: unknown }).alternates;
    const alternates = Array.isArray(rawAlternates)
      ? rawAlternates.filter((a): a is string => typeof a === "string" && a.trim().length > 0).map(cleanDescription).slice(0, 3)
      : undefined;
    const visual: BeatVisual = { description: cleanDescription(description), motion: (item as { motion?: unknown }).motion === true };
    for (const key of ["quote", "subject", "action", "place", "era"] as const) {
      const v = field(key);
      if (v) visual[key] = v;
    }
    if (alternates && alternates.length > 0) visual.alternates = alternates;
    if (opts.identity) {
      const record = item as Record<string, unknown>;
      const beatClass = (VISUAL_BEAT_CLASSES as readonly unknown[]).includes(record.beatClass) ? (record.beatClass as VisualBeatClass) : undefined;
      if (beatClass) visual.beatClass = beatClass;
      // IDENTITY sin identity válida queda IDENTITY sin persona: requiresIdentity la deja sin representación posible.
      const identity = declaredIdentity(record);
      if (identity) visual.identity = identity;
      // Solo una escena EVIDENCE lleva proposición: en otra clase no autoriza ni restringe nada.
      const evidence = beatClass === "EVIDENCE" ? declaredEvidence(record) : undefined;
      if (evidence) visual.evidence = evidence;
    }
    out.push(visual);
    if (out.length >= MAX_VISUALS_PER_BEAT) break;
  }
  if (opts.identity && out.some((v) => v.beatClass !== undefined)) {
    // Integridad de clasificación (solo con evidencia estructurada; nunca por nombres):
    // en un beat que el planner sí clasificó, una escena sin clase es incierta, y una
    // identidad declarada en una escena que no es IDENTITY es contradictoria. Ambas fallan cerradas.
    // Y una TRANSITION con acción física, sin identidad, en un beat que declara a una persona: ¿de quién es
    // la acción? Incierto → falla cerrada (nunca un cuerpo anónimo haciendo lo que hizo la persona).
    const beatDeclaresPerson = out.some((v) => v.identity !== undefined);
    for (const visual of out) {
      const uncertainAction = beatDeclaresPerson && visual.beatClass === "TRANSITION" && visual.motion && !visual.identity;
      if (visual.beatClass === undefined || (visual.identity && visual.beatClass !== "IDENTITY") || uncertainAction) visual.classificationGap = true;
    }
    if (beatDeclaresPerson) {
      const persons = [...new Set(out.flatMap((v) => (v.identity ? [personKey(v.identity.name)] : [])))];
      const actions = [...new Set([...beatPersonActions(out), ...persons.flatMap((p) => opts.personActions?.get(p) ?? [])])];
      if (actions.length > 0) for (const visual of out) if (!requiresIdentity(visual)) visual.personActions = actions;
    }
  }
  return out;
}

export function splitSentences(text: string): string[] {
  return (text.match(/[^.!?…]+[.!?…]*/g) ?? [text]).map((s) => s.trim()).filter(Boolean);
}

function keywords(sentence: string, limit: number): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const raw of sentence.split(/[^\p{L}\p{N}-]+/u)) {
    const word = raw.trim();
    const lower = word.toLowerCase();
    if (word.length < 5 || STOPWORDS.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    words.push(word);
    if (words.length >= limit) break;
  }
  return words;
}

/** Descripciones derivadas (sin `visuals` declarados): tema + palabras clave de cada oración — nunca un placeholder. */
export function deriveVisualsFromNarration(topic: string, narration: string): BeatVisual[] {
  const cleanTopic = cleanDescription(topic);
  const derived: BeatVisual[] = [];
  for (const sentence of splitSentences(narration)) {
    const kw = keywords(sentence, 4);
    if (kw.length === 0) continue;
    derived.push({ description: cleanDescription(`${cleanTopic} ${kw.join(" ")}`), motion: false, derived: true });
    if (derived.length >= 4) break;
  }
  return derived.length > 0 ? derived : [{ description: cleanTopic, motion: false, derived: true }];
}

export function visualsForBeat(
  beat: { narration: string; visuals?: unknown },
  topic: string,
  opts: { identity?: boolean; personActions?: Map<string, string[]> } = {},
): BeatVisual[] {
  const declared = normalizeDeclaredVisuals(beat.visuals, opts);
  return declared.length > 0 ? declared : deriveVisualsFromNarration(topic, beat.narration);
}

/** Prompt de imagen fija documental (OpenAI Images) a partir de una intención real. */
export function documentaryImagePrompt(visualIntent: string): string {
  return (
    `Photorealistic documentary still, natural lighting, cinematic 16:9 composition: ${visualIntent}. ` +
    "No text, no captions, no logos, no watermarks."
  );
}

/** Índice (0-based) del shot dentro de su beat, a partir del id determinístico "<beatId>-shot-<n>". */
export function shotIndexInBeat(shotId: string): number {
  const match = /-shot-(\d+)$/.exec(shotId);
  return match ? Math.max(0, Number(match[1]) - 1) : 0;
}

/** Tarjeta de texto REAL (tema + una oración de la propia narración) — reemplaza a buildFixtureTextCardSpec en producción. */
export function textCardForShot(shot: { id: string; captionText: string }, topic: string): TextCardSpec {
  const sentences = splitSentences(shot.captionText);
  const sentence = sentences.length > 0 ? sentences[shotIndexInBeat(shot.id) % sentences.length] : shot.captionText;
  const body = sentence.length > 160 ? `${sentence.slice(0, 157).trimEnd()}…` : sentence;
  return { kind: "text", title: cleanDescription(topic), body, isFixture: false };
}
