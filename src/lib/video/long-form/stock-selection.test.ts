import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FootageCandidate, FootageProvider } from "@/lib/providers/types";
import { DocumentAssetRegistry } from "./asset-identity";
import { selectStockForShot, type StockGap, type StockSelection } from "./stock-selection";
import { executeShot, type ShotExecutionDeps } from "./shot-executor";
import { memoryShotAssetStore } from "./durable-shot-assets";
import { ProductionBudget, memoryBudgetStore } from "./production-budget";
import { emptyAiVideoLedgerState, getAiVideoCostConfig } from "./ai-video-cost-guard";
import { getGenerativeUnitCosts, type AllocatedShot } from "./production-plan";
import type { BeatVisual } from "./visual-intents";

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
 * Los tests marcados [REGRESIÓN] expresan el contrato que B2 debe cumplir
 * y HOY fallan a propósito. Los [CONTROL] deben pasar hoy y después.
 * Sin red, sin proveedores reales, sin modelos, sin revisor.
 */

// Cualquier intento de red hace fallar el arnés.
globalThis.fetch = (async () => {
  throw new Error("B1: red prohibida en el arnés");
}) as typeof fetch;

type Depicts = "generic_human" | "entity" | "other_entity" | "non_human_context";
type Truth = { depicts: Depicts; entity?: string };
type Fixture = { id: string; description: string; similarity: number; truth: Truth };

/** Lo que el beat exige narrativamente (dato del arnés: hoy no existe en BeatVisual). */
type NarrativeBeat = { narration: string; requiredEntity?: string; visual: BeatVisual };

const identify = async (b: Buffer) => ({ sha256: createHash("sha256").update(b).digest("hex") });

/** Proveedor falso: devuelve SIEMPRE los candidatos por similitud descendente, para cualquier consulta. */
function similarityProvider(fixtures: Fixture[]) {
  const ranked = [...fixtures].sort((a, b) => b.similarity - a.similarity);
  const truth = new Map(fixtures.map((f) => [f.id, f.truth]));
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
        (f): FootageCandidate => ({ url: `https://cdn.example/${f.id}.jpg`, sourceId: f.id, description: f.description, mediaType: "image", mimeType: "image/jpeg", extension: "jpg" }),
      );
    },
    async downloadFootage(url) {
      downloads.push(url);
      return Buffer.from(`bytes:${url}`);
    },
  };
  return { provider, truth, ranked, searches, downloads };
}

async function select(beat: NarrativeBeat, fixtures: Fixture[]) {
  const fake = similarityProvider(fixtures);
  // Similitud intacta: el candidato incorrecto llega primero, tal como se declaró.
  assert.deepEqual(
    fake.ranked.map((f) => f.similarity),
    [...fixtures.map((f) => f.similarity)].sort((a, b) => b - a),
  );
  const outcome = await selectStockForShot(
    { shotId: "shot-1", visual: beat.visual, preferVideo: false, minDurationSec: 4 },
    { footageProvider: fake.provider, registry: new DocumentAssetRegistry(), identify },
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
  { id: "c-c", description: "Maurizio Gucci archival portrait photograph, Milan", similarity: 0.4, truth: { depicts: "entity", entity: "Maurizio Gucci" } },
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
  { id: "l-b", description: "statue of Leonidas king of Sparta at Thermopylae", similarity: 0.4, truth: { depicts: "entity", entity: "Leonidas" } },
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

// --------------------------------------------------------------------------
// TEST 1 — Gucci false friend
// --------------------------------------------------------------------------

test("[REGRESIÓN] 1a Gucci: con el contrato actual del planner, los pies anónimos (0.95) no deben representar a la persona", async () => {
  const beat: NarrativeBeat = { narration: GUCCI_NARRATION, requiredEntity: "Maurizio Gucci", visual: gucciPlannerVisual };
  const { outcome, fake } = await select(beat, gucciFixtures);
  assert.equal(contractViolation(beat, outcome, fake.truth), null);
});

test("[REGRESIÓN] 1c Gucci: nombrar a la persona en el sujeto no basta — el token compartido con una marca no es un vínculo de entidad", async () => {
  const beat: NarrativeBeat = {
    narration: GUCCI_NARRATION,
    requiredEntity: "Maurizio Gucci",
    visual: { ...gucciPlannerVisual, description: "Maurizio Gucci climbing the stairs to his office in Milan", subject: "Maurizio Gucci" },
  };
  const brandModel: Fixture = { id: "c-m", description: "Gucci fashion model posing on the stairs in Milan", similarity: 0.97, truth: { depicts: "generic_human" } };
  const { outcome, fake } = await select(beat, [brandModel, ...gucciFixtures]);
  assert.equal(contractViolation(beat, outcome, fake.truth), null);
});

test("[CARACTERIZACIÓN] 1b Gucci: con el nombre en el sujeto, A/B caen por léxico y gana C SOLO porque su texto dice el nombre (auto-declaración)", async () => {
  const beat: NarrativeBeat = {
    narration: GUCCI_NARRATION,
    requiredEntity: "Maurizio Gucci",
    visual: { ...gucciPlannerVisual, description: "Maurizio Gucci climbing the stairs to his office in Milan", subject: "Maurizio Gucci" },
  };
  const { outcome, fake } = await select(beat, gucciFixtures);
  assert.equal(outcome.status, "selected");
  if (outcome.status !== "selected") return;
  assert.equal(outcome.candidate.sourceId, "c-c");
  assert.deepEqual(
    outcome.rejected.map((r) => r.sourceId),
    ["c-a", "c-b"],
  );
  // La "verificación" es una coincidencia de texto del proveedor, no un vínculo de entidad de confianza.
  assert.deepEqual(outcome.assessment.matchedTerms.slice(0, 2), ["maurizio", "gucci"]);
  assert.equal(contractViolation(beat, outcome, fake.truth), null);
});

// --------------------------------------------------------------------------
// TEST 2 — Leonidas (misma clase de fallo, sin lógica de Gucci)
// --------------------------------------------------------------------------

test("[REGRESIÓN] 2a Leonidas: el hoplita anónimo (0.95) no debe representar al rey", async () => {
  const beat: NarrativeBeat = { narration: LEONIDAS_NARRATION, requiredEntity: "Leonidas", visual: leonidasPlannerVisual };
  const { outcome, fake } = await select(beat, leonidasFixtures);
  assert.equal(contractViolation(beat, outcome, fake.truth), null);
});

test("[REGRESIÓN] 2c Leonidas: una entidad homónima (marca) con el mismo token no es la persona", async () => {
  const beat: NarrativeBeat = {
    narration: LEONIDAS_NARRATION,
    requiredEntity: "Leonidas",
    visual: { ...leonidasPlannerVisual, description: "Leonidas leading the Spartans at Thermopylae", subject: "Leonidas" },
  };
  const homonym: Fixture = { id: "l-h", description: "Leonidas chocolate shop window display", similarity: 0.9, truth: { depicts: "other_entity", entity: "Leonidas (brand)" } };
  const { outcome, fake } = await select(beat, [homonym, ...leonidasFixtures]);
  assert.equal(contractViolation(beat, outcome, fake.truth), null);
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

test("[REGRESIÓN] 4 identidad + mismo lugar: el MISMO taller del test 3 no representa a la persona", async () => {
  const beat: NarrativeBeat = {
    narration: "Maurizio Gucci walked through the textile workshop in Florence.",
    requiredEntity: "Maurizio Gucci",
    visual: { description: "man walking through a textile workshop in Florence", subject: "textile workshop", action: "walking", place: "Florence", motion: true },
  };
  const { outcome, fake } = await select(beat, [workshop]);
  assert.equal(contractViolation(beat, outcome, fake.truth), null);
});

// --------------------------------------------------------------------------
// TEST 5 — ABSENT es válido
// --------------------------------------------------------------------------

const allFalseFriends: Fixture[] = [
  { id: "f-1", description: "anonymous feet climbing stairs", similarity: 0.95, truth: { depicts: "generic_human" } },
  { id: "f-2", description: "bellboy carrying luggage up the stairs of a Milan hotel", similarity: 0.93, truth: { depicts: "generic_human" } },
  { id: "f-3", description: "businessman in a suit climbing stairs in a Milan office building", similarity: 0.91, truth: { depicts: "generic_human" } },
];

test("[REGRESIÓN] 5a ABSENT (selector): beat de identidad con solo falsos amigos → carencia, nunca el 'mejor malo'", async () => {
  const beat: NarrativeBeat = { narration: GUCCI_NARRATION, requiredEntity: "Maurizio Gucci", visual: gucciPlannerVisual };
  const { outcome } = await select(beat, allFalseFriends);
  assert.equal(
    outcome.status,
    "gap",
    outcome.status === "selected" ? `se eligió "${outcome.candidate.description}" (${outcome.candidate.sourceId})` : undefined,
  );
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

test("[REGRESIÓN] 5b ABSENT (ejecución): la toma termina en la tarjeta del pasaje existente, sin humano genérico ni imagen IA", async () => {
  const imageCalls: string[] = [];
  const deps = execDeps(similarityProvider(allFalseFriends).provider, imageCalls);
  deps.budget = await ProductionBudget.open(memoryBudgetStore(), { maxAiImageGenerations: 0, maxAiVideoClips: 0, maxGenerativeUsd: 0 });
  const ex = await executeShot(anchoredStockShot(gucciPlannerVisual, GUCCI_NARRATION), deps, emptyAiVideoLedgerState());
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
