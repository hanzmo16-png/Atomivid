import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FootageCandidate, FootageProvider } from "@/lib/providers/types";
import { DocumentAssetRegistry } from "./asset-identity";
import { selectStockForShot, selectionQueries, type StockGap, type StockSelection } from "./stock-selection";
import { executeShot, type ShotExecutionDeps } from "./shot-executor";
import { memoryShotAssetStore } from "./durable-shot-assets";
import { ProductionBudget, memoryBudgetStore } from "./production-budget";
import { emptyAiVideoLedgerState, getAiVideoCostConfig } from "./ai-video-cost-guard";
import { getGenerativeUnitCosts, type AllocatedShot } from "./production-plan";
import { normalizeDeclaredVisuals, type BeatVisual } from "./visual-intents";

/**
 * Visual Excellence V1 — B1: arnés de regresión de "falsos amigos" visuales.
 *
 * El proveedor falso ordena por una SIMILITUD fija y determinista que
 * favorece deliberadamente al candidato narrativamente incorrecto. Las
 * similitudes nunca se alteran ni se reordenan. El selector solo ve los
 * campos de FootageCandidate; la etiqueta de verdad (qué muestra realmente
 * cada candidato) vive aparte y la usa únicamente el oráculo de las
 * aserciones — nunca se le pasa al selector.
 *
 * [CARACTERIZACIÓN]: hechos de la ruta productiva actual (sin contrato de
 * identidad), que explican por qué el selector léxico se equivocaba.
 * [CONTRATO]: el comportamiento correcto con identidad declarada (B1 los
 * dejó en rojo como evidencia; B2A los hace verdes sin tocar los hechos).
 * [CONTROL]: deben pasar siempre.
 *
 * `archive` simula el catálogo de un archivo de confianza del SERVIDOR (el
 * verificador inyectado en el selector); no es metadata del candidato.
 * Sin red, sin proveedores reales, sin modelos, sin revisor.
 */

// Cualquier intento de red hace fallar el arnés.
globalThis.fetch = (async () => {
  throw new Error("B1: red prohibida en el arnés");
}) as typeof fetch;

type Depicts = "generic_human" | "entity" | "other_entity" | "non_human_context";
type Truth = { depicts: Depicts; entity?: string };
type Fixture = { id: string; description: string; similarity: number; truth: Truth; archive?: string; claims?: string };

/** Lo que el beat exige narrativamente (dato del arnés: hoy no existe en BeatVisual). */
type NarrativeBeat = { narration: string; requiredEntity?: string; visual: BeatVisual };

const identify = async (b: Buffer) => ({ sha256: createHash("sha256").update(b).digest("hex") });

/** Proveedor falso: devuelve SIEMPRE los candidatos por similitud descendente, para cualquier consulta. */
function similarityProvider(fixtures: Fixture[]) {
  const ranked = [...fixtures].sort((a, b) => b.similarity - a.similarity);
  const truth = new Map(fixtures.map((f) => [f.id, f.truth]));
  const catalog = new Map(fixtures.filter((f) => f.archive).map((f) => [f.id, f.archive!]));
  const searches: string[] = [];
  const downloads: string[] = [];
  const provider: FootageProvider = {
    name: "pexels-video-first",
    async fetchFootage() {
      throw new Error("no debe usarse con búsqueda de candidatos");
    },
    async searchImageCandidates(q) {
      searches.push(q);
      return ranked.map(
        (f): FootageCandidate => ({
          url: `https://cdn.example/${f.id}.jpg`,
          sourceId: f.id,
          description: f.description,
          mediaType: "image",
          mimeType: "image/jpeg",
          extension: "jpg",
          ...(f.claims ? { entityReference: { name: f.claims } } : {}),
        }),
      );
    },
    async downloadFootage(url) {
      downloads.push(url);
      return Buffer.from(`bytes:${url}`);
    },
  };
  /** Verificador del servidor: responde solo desde su catálogo, nunca desde el candidato. */
  const verifyEntityLink = (c: FootageCandidate) => (catalog.has(c.sourceId) ? { name: catalog.get(c.sourceId)! } : null);
  return { provider, truth, ranked, searches, downloads, verifyEntityLink };
}

/**
 * declareIdentity: el contrato de identidad del beat llega a BeatVisual (B2A lo construye el test;
 * el planner aún no lo emite). trusted: hay verificador de archivo de confianza (producción hoy: no).
 */
async function select(beat: NarrativeBeat, fixtures: Fixture[], opts: { declareIdentity?: boolean; trusted?: boolean } = {}) {
  const { declareIdentity = true, trusted = true } = opts;
  const fake = similarityProvider(fixtures);
  const visual: BeatVisual = declareIdentity && beat.requiredEntity ? { ...beat.visual, identity: { name: beat.requiredEntity, kind: "person" } } : beat.visual;
  // Similitud intacta: el candidato incorrecto llega primero, tal como se declaró.
  assert.deepEqual(
    fake.ranked.map((f) => f.similarity),
    [...fixtures.map((f) => f.similarity)].sort((a, b) => b - a),
  );
  const outcome = await selectStockForShot(
    { shotId: "shot-1", visual, preferVideo: false, minDurationSec: 4 },
    { footageProvider: fake.provider, registry: new DocumentAssetRegistry(), identify, ...(trusted ? { verifyEntityLink: fake.verifyEntityLink } : {}) },
  );
  return { outcome, fake };
}

/**
 * Oráculo del contrato futuro (B2). Devuelve la violación o null.
 * - Beat con identidad: un humano genérico o una entidad ajena NUNCA la
 *   representa; una entidad vinculada correcta solo es ELEGIBLE; el
 *   contexto no humano o la carencia (ABSENT) son válidos.
 * - Beat sin identidad (PROCESS): el contexto humano genérico es válido.
 */
function contractViolation(beat: NarrativeBeat, outcome: StockSelection | StockGap, truth: Map<string, Truth>): string | null {
  if (outcome.status === "gap") return null;
  const t = truth.get(outcome.candidate.sourceId);
  if (!t) return `candidato sin etiqueta de verdad: ${outcome.candidate.sourceId}`;
  const won = `"${outcome.candidate.description}" (${outcome.candidate.sourceId}; relevancia ${outcome.assessment.relevance}, score ${outcome.assessment.score}, términos [${outcome.assessment.matchedTerms.join(", ")}], consulta "${outcome.query}")`;
  if (!beat.requiredEntity) return null;
  if (t.depicts === "generic_human") return `FALSE_FRIEND aceptado: humano genérico representa a ${beat.requiredEntity}: ${won}`;
  if (t.depicts === "other_entity") return `ENTIDAD AJENA aceptada (${t.entity}) en lugar de ${beat.requiredEntity}: ${won}`;
  if (t.depicts === "entity" && t.entity !== beat.requiredEntity) return `entidad incorrecta (${t.entity}): ${won}`;
  return null;
}

// --------------------------------------------------------------------------
// Fixtures (conceptuales; ningún nombre aparece en código del selector)
// --------------------------------------------------------------------------

const GUCCI_NARRATION = "Maurizio Gucci entered the building and climbed the stairs toward his office.";
const gucciFixtures: Fixture[] = [
  { id: "c-a", description: "anonymous feet climbing stairs", similarity: 0.95, truth: { depicts: "generic_human" } },
  { id: "c-b", description: "bellboy building attendant on the stairs of a Milan hotel", similarity: 0.93, truth: { depicts: "generic_human" } },
  { id: "c-c", description: "Maurizio Gucci archival portrait photograph, Milan", similarity: 0.4, truth: { depicts: "entity", entity: "Maurizio Gucci" }, archive: "Maurizio Gucci" },
  { id: "c-d", description: "facade and entrance stairs of an office building in Milan", similarity: 0.35, truth: { depicts: "non_human_context" } },
];
/** Lo que el contrato ACTUAL del planner obliga a declarar ("nunca personas reales identificables"). */
const gucciPlannerVisual: BeatVisual = {
  description: "man climbing stairs toward an office in a Milan building",
  subject: "stairs",
  action: "climbing",
  place: "Milan",
  era: "1995",
  motion: true,
};

const LEONIDAS_NARRATION = "Leonidas led the Spartans at Thermopylae.";
const leonidasFixtures: Fixture[] = [
  { id: "l-a", description: "anonymous Spartan hoplite warrior with shield at Thermopylae", similarity: 0.95, truth: { depicts: "generic_human" } },
  { id: "l-b", description: "statue of Leonidas king of Sparta at Thermopylae", similarity: 0.4, truth: { depicts: "entity", entity: "Leonidas" }, archive: "Leonidas" },
];
const leonidasPlannerVisual: BeatVisual = {
  description: "Spartan hoplite warriors holding the pass at Thermopylae",
  subject: "hoplite",
  action: "fighting",
  place: "Thermopylae",
  era: "480 BC ancient Greece",
  motion: true,
};

/** El MISMO recurso de taller en los tests 3 y 4. */
const workshop: Fixture = {
  id: "w-1",
  description: "weavers working at looms in a vintage textile workshop in Florence",
  similarity: 0.9,
  truth: { depicts: "generic_human" },
};

const reasonsOf = (outcome: StockSelection | StockGap) => new Map(outcome.rejected.map((r) => [r.sourceId, r.reason]));

// --------------------------------------------------------------------------
// CARACTERIZACIÓN — ruta productiva actual (sin contrato de identidad)
// --------------------------------------------------------------------------

test("[CARACTERIZACIÓN] sin contrato de identidad, el selector léxico acepta los pies anónimos (0.95): así nació el fallo", async () => {
  const beat: NarrativeBeat = { narration: GUCCI_NARRATION, requiredEntity: "Maurizio Gucci", visual: gucciPlannerVisual };
  const { outcome } = await select(beat, gucciFixtures, { declareIdentity: false });
  assert.equal(outcome.status, "selected");
  if (outcome.status === "selected") assert.equal(outcome.candidate.sourceId, "c-a");
});

test("[CARACTERIZACIÓN] sin contrato, con el nombre en el sujeto gana C solo porque su alt text dice el nombre (auto-declaración)", async () => {
  const beat: NarrativeBeat = {
    narration: GUCCI_NARRATION,
    requiredEntity: "Maurizio Gucci",
    visual: { ...gucciPlannerVisual, description: "Maurizio Gucci climbing the stairs to his office in Milan", subject: "Maurizio Gucci" },
  };
  const { outcome } = await select(beat, gucciFixtures, { declareIdentity: false, trusted: false });
  assert.equal(outcome.status, "selected");
  if (outcome.status !== "selected") return;
  assert.equal(outcome.candidate.sourceId, "c-c");
  assert.deepEqual(outcome.assessment.matchedTerms.slice(0, 2), ["maurizio", "gucci"]);
});

test("[CARACTERIZACIÓN] sin contrato de identidad, el hoplita anónimo (0.95) gana a Leonidas", async () => {
  const beat: NarrativeBeat = { narration: LEONIDAS_NARRATION, requiredEntity: "Leonidas", visual: leonidasPlannerVisual };
  const { outcome } = await select(beat, leonidasFixtures, { declareIdentity: false });
  assert.equal(outcome.status, "selected");
  if (outcome.status === "selected") assert.equal(outcome.candidate.sourceId, "l-a");
});

// --------------------------------------------------------------------------
// TEST 1 — Gucci false friend
// --------------------------------------------------------------------------

test("[CONTRATO] 1a Gucci: pies (0.95) y botones (0.93) son FALSE_FRIEND; el vínculo de confianza (0.40) es lo único elegible", async () => {
  const beat: NarrativeBeat = { narration: GUCCI_NARRATION, requiredEntity: "Maurizio Gucci", visual: gucciPlannerVisual };
  const { outcome, fake } = await select(beat, gucciFixtures);
  assert.equal(contractViolation(beat, outcome, fake.truth), null);
  assert.equal(outcome.status, "selected");
  if (outcome.status !== "selected") return;
  assert.equal(outcome.candidate.sourceId, "c-c");
  assert.deepEqual(outcome.entityLink, { name: "Maurizio Gucci" });
  const reasons = reasonsOf(outcome);
  assert.match(reasons.get("c-a") ?? "", /^FALSE_FRIEND: sin vínculo de confianza/);
  assert.match(reasons.get("c-b") ?? "", /^(FALSE_FRIEND|IDENTITY_UNVERIFIED): sin vínculo de confianza/);
});

/**
 * Cambio documentado respecto de B1: el antiguo 1b afirmaba "el nombre en el
 * alt text basta" (gana c-c). Ese hecho sigue registrado arriba como
 * CARACTERIZACIÓN; el contrato correcto es el opuesto. Los fixtures no cambian.
 */
test("[CONTRATO] 1b el nombre en el alt text SIN vínculo de confianza NO basta → carencia", async () => {
  const beat: NarrativeBeat = {
    narration: GUCCI_NARRATION,
    requiredEntity: "Maurizio Gucci",
    visual: { ...gucciPlannerVisual, description: "Maurizio Gucci climbing the stairs to his office in Milan", subject: "Maurizio Gucci" },
  };
  const { outcome, fake } = await select(beat, gucciFixtures, { trusted: false });
  assert.equal(contractViolation(beat, outcome, fake.truth), null);
  assert.equal(outcome.status, "gap");
  assert.match(reasonsOf(outcome).get("c-c") ?? "", /^FALSE_FRIEND: sin vínculo de confianza/);
});

test("[CONTRATO] 1c Gucci: el token compartido con una marca no es un vínculo de entidad", async () => {
  const beat: NarrativeBeat = {
    narration: GUCCI_NARRATION,
    requiredEntity: "Maurizio Gucci",
    visual: { ...gucciPlannerVisual, description: "Maurizio Gucci climbing the stairs to his office in Milan", subject: "Maurizio Gucci" },
  };
  const brandModel: Fixture = { id: "c-m", description: "Gucci fashion model posing on the stairs in Milan", similarity: 0.97, truth: { depicts: "generic_human" } };
  const { outcome, fake } = await select(beat, [brandModel, ...gucciFixtures]);
  assert.equal(contractViolation(beat, outcome, fake.truth), null);
  assert.match(reasonsOf(outcome).get("c-m") ?? "", /^FALSE_FRIEND/);
  if (outcome.status === "selected") assert.equal(outcome.candidate.sourceId, "c-c");
});

test("[CONTRATO] 1d un proveedor genérico no se autodeclara: entityReference del candidato sin respaldo del servidor no verifica", async () => {
  const beat: NarrativeBeat = { narration: GUCCI_NARRATION, requiredEntity: "Maurizio Gucci", visual: gucciPlannerVisual };
  const selfClaimed: Fixture = { id: "c-s", description: "man climbing stairs in a Milan office", similarity: 0.99, truth: { depicts: "generic_human" }, claims: "Maurizio Gucci" };
  const withArchive = await select(beat, [selfClaimed, ...gucciFixtures]);
  assert.match(reasonsOf(withArchive.outcome).get("c-s") ?? "", /^FALSE_FRIEND: sin vínculo de confianza/);
  assert.equal(contractViolation(beat, withArchive.outcome, withArchive.fake.truth), null);
  const noVerifier = await select(beat, [selfClaimed, ...gucciFixtures], { trusted: false });
  assert.equal(noVerifier.outcome.status, "gap", "sin verificador del servidor (producción hoy) nada representa a la persona");
});

// --------------------------------------------------------------------------
// TEST 2 — Leonidas (misma regla general, sin lógica de Gucci)
// --------------------------------------------------------------------------

test("[CONTRATO] 2a Leonidas: el hoplita anónimo (0.95) es FALSE_FRIEND; la representación vinculada (0.40) es elegible", async () => {
  const beat: NarrativeBeat = { narration: LEONIDAS_NARRATION, requiredEntity: "Leonidas", visual: leonidasPlannerVisual };
  const { outcome, fake } = await select(beat, leonidasFixtures);
  assert.equal(contractViolation(beat, outcome, fake.truth), null);
  assert.match(reasonsOf(outcome).get("l-a") ?? "", /^FALSE_FRIEND: sin vínculo de confianza/);
  assert.equal(outcome.status, "selected");
  if (outcome.status === "selected") assert.equal(outcome.candidate.sourceId, "l-b");
});

test("[CONTRATO] 2c Leonidas: una entidad homónima, aun vinculada por el archivo, es OTRA entidad", async () => {
  const beat: NarrativeBeat = {
    narration: LEONIDAS_NARRATION,
    requiredEntity: "Leonidas",
    visual: { ...leonidasPlannerVisual, description: "Leonidas leading the Spartans at Thermopylae", subject: "Leonidas" },
  };
  const homonym: Fixture = {
    id: "l-h",
    description: "Leonidas chocolate shop window display",
    similarity: 0.9,
    truth: { depicts: "other_entity", entity: "Leonidas (brand)" },
    archive: "Leonidas (brand)",
  };
  const { outcome, fake } = await select(beat, [homonym, ...leonidasFixtures]);
  assert.equal(contractViolation(beat, outcome, fake.truth), null);
  assert.match(reasonsOf(outcome).get("l-h") ?? "", /^FALSE_FRIEND: vinculado a otra entidad/);
  if (outcome.status === "selected") assert.equal(outcome.candidate.sourceId, "l-b");
});

// --------------------------------------------------------------------------
// TEST 3 — PROCESS: control positivo
// --------------------------------------------------------------------------

test("[CONTROL] 3 PROCESS: un taller textil florentino de época se ACEPTA (sin identidad exigida)", async () => {
  const beat: NarrativeBeat = {
    narration: "Textile workshop in Florence in the 1950s.",
    visual: { description: "textile workshop in Florence in the 1950s with weavers at looms", subject: "textile workshop", action: "weaving", place: "Florence", era: "1950s", motion: true },
  };
  const { outcome, fake } = await select(beat, [workshop]);
  assert.equal(outcome.status, "selected");
  if (outcome.status === "selected") assert.equal(outcome.candidate.sourceId, "w-1");
  assert.equal(contractViolation(beat, outcome, fake.truth), null);
});

// --------------------------------------------------------------------------
// TEST 4 — la identidad domina al lugar
// --------------------------------------------------------------------------

test("[CONTRATO] 4 identidad + mismo lugar: el MISMO taller del test 3 no representa a la persona → carencia", async () => {
  const beat: NarrativeBeat = {
    narration: "Maurizio Gucci walked through the textile workshop in Florence.",
    requiredEntity: "Maurizio Gucci",
    visual: { description: "man walking through a textile workshop in Florence", subject: "textile workshop", action: "walking", place: "Florence", motion: true },
  };
  const { outcome, fake } = await select(beat, [workshop]);
  assert.equal(contractViolation(beat, outcome, fake.truth), null);
  assert.equal(outcome.status, "gap");
  assert.match(reasonsOf(outcome).get("w-1") ?? "", /^FALSE_FRIEND/);
});

// --------------------------------------------------------------------------
// TEST 5 — ABSENT es válido
// --------------------------------------------------------------------------

const allFalseFriends: Fixture[] = [
  { id: "f-1", description: "anonymous feet climbing stairs", similarity: 0.95, truth: { depicts: "generic_human" } },
  { id: "f-2", description: "bellboy carrying luggage up the stairs of a Milan hotel", similarity: 0.93, truth: { depicts: "generic_human" } },
  { id: "f-3", description: "businessman in a suit climbing stairs in a Milan office building", similarity: 0.91, truth: { depicts: "generic_human" } },
];

test("[CONTRATO] 5a ABSENT (selector): beat de identidad con solo falsos amigos → carencia, nunca el 'mejor malo'", async () => {
  const beat: NarrativeBeat = { narration: GUCCI_NARRATION, requiredEntity: "Maurizio Gucci", visual: gucciPlannerVisual };
  const { outcome } = await select(beat, allFalseFriends);
  assert.equal(
    outcome.status,
    "gap",
    outcome.status === "selected" ? `se eligió "${outcome.candidate.description}" (${outcome.candidate.sourceId})` : undefined,
  );
  assert.equal(outcome.rejected.length, 3);
});

// --------------------------------------------------------------------------
// Consultas: la transición no busca
// --------------------------------------------------------------------------

test("[CONTRATO] consultas con identidad: la acción ('climbing') no forma ninguna búsqueda; persona + lugar + época sí", () => {
  const visual: BeatVisual = { ...gucciPlannerVisual, alternates: ["person walking up office stairs"], identity: { name: "Maurizio Gucci", kind: "person" } };
  const queries = selectionQueries(visual);
  assert.deepEqual(queries, ["Maurizio Gucci Milan 1995", "Maurizio Gucci Milan", "Maurizio Gucci"]);
  for (const q of queries) assert.doesNotMatch(q, /climb|stairs|walking/i, q);
});

test("[CONTROL] sin identidad las consultas no cambian (ruta productiva actual)", () => {
  assert.deepEqual(selectionQueries(gucciPlannerVisual), ["man climbing stairs toward an office in a Milan building", "stairs Milan"]);
});

test("[CONTROL] B2A no se activa en producción: el guion todavía no puede introducir `identity` en BeatVisual", () => {
  const [visual] = normalizeDeclaredVisuals([{ description: "office stairs", motion: false, identity: { name: "Someone", kind: "person" } }]);
  assert.equal(visual.identity, undefined);
});

function execDeps(footageProvider: FootageProvider, imageCalls: string[]): ShotExecutionDeps {
  const mem = memoryShotAssetStore();
  return {
    topic: "Documental de prueba",
    footageProvider,
    imageProvider: {
      name: "openai",
      capabilities: { id: "o", models: ["m"], formats: ["image/png"], aspectRatios: ["16:9"], timeoutMs: 1, maxRetries: 0 },
      isAvailable: () => true,
      async generateImage(req: { prompt: string }) {
        imageCalls.push(req.prompt);
        throw new Error("B1: generación de imagen prohibida en el arnés");
      },
    } as unknown as ShotExecutionDeps["imageProvider"],
    store: mem.store,
    budget: undefined as unknown as ProductionBudget,
    units: getGenerativeUnitCosts(),
    aiVideoCostConfig: getAiVideoCostConfig("balanced"),
    totalDurationSec: 60,
    requireReal: false,
    visualPipeline: "anchored_v1",
    registry: new DocumentAssetRegistry(),
    identify,
  };
}

function anchoredStockShot(visual: BeatVisual, fragment: string): AllocatedShot {
  return {
    id: "beat-1-shot-1",
    beatId: "beat-1",
    startSec: 0,
    endSec: 5,
    durationSec: 5,
    type: "ken_burns_image",
    source: "stock",
    assetId: "beat-1-shot-1",
    visualIntent: visual.description,
    motion: "ken_burns",
    captionText: fragment,
    narrationFragment: fragment,
    anchoredVisual: visual,
    license: "resolved-at-execution",
    attribution: "",
    dedupKey: "beat-1-shot-1",
    status: "planned",
    validationStatus: "pending",
  } as AllocatedShot;
}

test("[CONTRATO] 5b ABSENT (ejecución): la toma termina en la tarjeta del pasaje existente, sin humano genérico ni imagen IA", async () => {
  const imageCalls: string[] = [];
  const deps = execDeps(similarityProvider(allFalseFriends).provider, imageCalls);
  deps.budget = await ProductionBudget.open(memoryBudgetStore(), { maxAiImageGenerations: 0, maxAiVideoClips: 0, maxGenerativeUsd: 0 });
  // Cableado productivo del ejecutor: sin verificador de entidades.
  const ex = await executeShot(anchoredStockShot({ ...gucciPlannerVisual, identity: { name: "Maurizio Gucci", kind: "person" } }, GUCCI_NARRATION), deps, emptyAiVideoLedgerState());
  assert.deepEqual(imageCalls, [], "ABSENT nunca escala a generación");
  assert.equal(ex.executedType, "text", `se ejecutó ${ex.executedType} con ${JSON.stringify((ex.assetMeta as { selection?: { candidateDescription?: string } } | undefined)?.selection?.candidateDescription ?? null)}`);
  assert.ok(ex.assetMeta?.gap);
});

test("[CONTROL] 5c la representación ABSENT existe hoy: carencia del selector → tarjeta del pasaje, sin imagen IA", async () => {
  const imageCalls: string[] = [];
  const unrelated: Fixture[] = [{ id: "u-1", description: "tropical beach at sunset", similarity: 0.99, truth: { depicts: "non_human_context" } }];
  const deps = execDeps(similarityProvider(unrelated).provider, imageCalls);
  deps.budget = await ProductionBudget.open(memoryBudgetStore(), { maxAiImageGenerations: 0, maxAiVideoClips: 0, maxGenerativeUsd: 0 });
  const ex = await executeShot(anchoredStockShot(gucciPlannerVisual, GUCCI_NARRATION), deps, emptyAiVideoLedgerState());
  assert.equal(ex.executedType, "text");
  assert.match(ex.deviation?.reason ?? "", /carencia de material pertinente/);
  assert.ok(ex.assetMeta?.gap);
  assert.equal(ex.asset.kind, "graphic");
  if (ex.asset.kind === "graphic" && ex.asset.graphic.kind === "text") assert.match(ex.asset.graphic.title, /Maurizio Gucci entered/);
  assert.deepEqual(imageCalls, []);
});

// --------------------------------------------------------------------------
// TEST 6 — sin dependencia de revisor
// --------------------------------------------------------------------------

test("[CONTROL] 6 sin revisor: ni el selector ni este arnés importan un modelo o revisor", () => {
  for (const file of ["stock-selection.ts", "stock-selection.test.ts"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    const imports = source.split("\n").filter((l) => /^import\b/.test(l));
    for (const line of imports) assert.doesNotMatch(line, /review|openai|anthropic|gemini|vision|embedding/i, `${file}: ${line}`);
  }
});
