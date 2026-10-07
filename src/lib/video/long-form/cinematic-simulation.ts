/**
 * Soporte de PRUEBAS (solo lo importan *.test.ts): simulación offline de una
 * producción v4 por las MISMAS funciones del pipeline — normalización, anclaje,
 * preflight, asignación, ejecución, informe, dirección, QA y puerta de entrega.
 * Proveedores falsos; sin red; sin gasto. No es una segunda implementación.
 */
import { createHash } from "node:crypto";
import type { FootageCandidate, FootageProvider, GenerativeAsset, ImageGenerationRequest, ImageProvider } from "@/lib/providers/types";
import { DocumentAssetRegistry } from "./asset-identity";
import { executeShot, type ShotExecution, type ShotExecutionDeps } from "./shot-executor";
import { memoryShotAssetStore } from "./durable-shot-assets";
import { ProductionBudget, memoryBudgetStore } from "./production-budget";
import { emptyAiVideoLedgerState, getAiVideoCostConfig } from "./ai-video-cost-guard";
import { allocateShotTypes, getGenerativeUnitCosts, planShotsFromScript, strategyLimits, type ProductionPlanBeatInput } from "./production-plan";
import type { VisualStrategy } from "./shots";
import { assertVisualQuality, buildVisualReport, LongFormVisualQualityError } from "./visual-report";
import { directAnchoredScenes, MAX_TEXT_FALLBACK_RATIO } from "./produce";
import { heroCoverage, VerifiedAssetRegistry, type VerifiedAssetRecord } from "./verified-assets";
import { visualsForBeat } from "./visual-intents";
import { planReleaseBlockers } from "./cinematic-director";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MusicProvider, VoiceProvider } from "@/lib/providers/types";
import { fixtureVoiceProvider } from "@/lib/providers/voice/fixture";
import { fixtureMusicProvider } from "@/lib/providers/music/fixture";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { memoryResultStore } from "@/lib/paid-calls/result-store";
import { computeProductionPlan, REAL_LONG_FORM_PROVIDER_NAMES, type ProductionPlan } from "./production-plan";
import { generateLongFormVideoFromScript, type LongFormRuntime } from "./produce";
import { memoryOutputDeps } from "./output-finalize";

export const identify = async (b: Buffer) => ({ sha256: createHash("sha256").update(b).digest("hex") });

export type Pooled = {
  id: string;
  description: string;
  similarity: number;
  media: "video" | "image";
  /** Catálogo del SERVIDOR (archivo de confianza): persona que el recurso muestra. Nunca lo ve el selector. */
  verified?: string;
  /** Catálogo del SERVIDOR: fuentes que el recurso documenta (pruebas). Nunca lo ve el selector. */
  documents?: string[];
};

export function fakePng(tag: string): Buffer {
  const buf = Buffer.alloc(80, 0);
  buf[0] = 0x89;
  buf.write("PNG", 1, "ascii");
  buf.write(tag, 40, "ascii");
  return buf;
}

export function poolProvider(pool: Pooled[]) {
  const ranked = [...pool].sort((a, b) => b.similarity - a.similarity);
  const as = (p: Pooled): FootageCandidate => ({
    url: `https://cdn.example/${p.id}.${p.media === "video" ? "mp4" : "jpg"}`,
    sourceId: p.id,
    description: p.description,
    mediaType: p.media,
    mimeType: p.media === "video" ? "video/mp4" : "image/jpeg",
    extension: p.media === "video" ? "mp4" : "jpg",
    durationSeconds: p.media === "video" ? 20 : undefined,
  });
  const provider: FootageProvider = {
    name: "pexels-video-first",
    async fetchFootage() {
      throw new Error("no debe usarse con búsqueda de candidatos");
    },
    async searchVideoCandidates() {
      return ranked.filter((p) => p.media === "video").map(as);
    },
    async searchImageCandidates() {
      return ranked.filter((p) => p.media === "image").map(as);
    },
    async downloadFootage(url) {
      return Buffer.from(`bytes:${url}`);
    },
  };
  // Verificador del SERVIDOR (catálogo de archivo de confianza): responde por id, nunca por el texto.
  const catalog = new Map(pool.filter((p) => p.verified).map((p) => [p.id, p.verified!]));
  const verifyEntityLink = (c: FootageCandidate) => (catalog.has(c.sourceId) ? { name: catalog.get(c.sourceId)! } : null);
  const records = new Map(pool.filter((p) => p.documents).map((p) => [p.id, p.documents!]));
  const verifyEvidenceLink = (c: FootageCandidate) => (records.has(c.sourceId) ? { sourceIds: records.get(c.sourceId)! } : null);
  return { provider, verifyEntityLink, verifyEvidenceLink };
}

export function fakeImageProvider() {
  const prompts: string[] = [];
  const provider: ImageProvider = {
    // "fixture": generación falsa offline (no pasa por la puerta de pagos ni por ningún proveedor real).
    name: "fixture",
    capabilities: { id: "fixture", models: ["fake"], formats: ["image/png"], aspectRatios: ["16:9"], timeoutMs: 1, maxRetries: 0 },
    isAvailable: () => true,
    async generateImage(request: ImageGenerationRequest): Promise<GenerativeAsset> {
      prompts.push(request.prompt);
      return { buffer: fakePng(`gen-${prompts.length}`), mimeType: "image/png", extension: "png", width: 1536, height: 1024, model: "fake", costUsd: 0 };
    },
  };
  return { provider, prompts };
}

/** Candidatos verdaderos para cada escena de contexto (variantes del material que el planner pidió). */
export function truthfulPool(beats: ProductionPlanBeatInput[], topic: string): Pooled[] {
  const out: Pooled[] = [];
  beats.forEach((beat, b) => {
    visualsForBeat(beat, topic, { identity: true }).forEach((v, i) => {
      // Variantes de stock del material pedido (también para EVIDENCE: periódicos/documentos genéricos SIN prueba).
      if (v.identity || v.classificationGap || v.beatClass === "IDENTITY") return;
      for (let k = 1; k <= 6; k++) out.push({ id: `t-${b}-${i}-${k}`, description: `${v.description}, archive view ${k}`, similarity: 0.6 - 0.001 * out.length, media: k % 2 ? "video" : "image" });
    });
  });
  return out;
}

export async function simulate(
  beats: ProductionPlanBeatInput[],
  topic: string,
  adversarial: Pooled[],
  strategy: VisualStrategy = "cinematic",
  opts: { registry?: VerifiedAssetRegistry } = {},
) {
  // 1) Plan: escenas ancladas con las reglas v4 y asignación con las restricciones del Director.
  const { shots, narrationSeconds } = planShotsFromScript(beats, topic, strategy);
  // Mismo preflight que produce.ts antes de cualquier llamada pagada (plan + cobertura HERO verificada).
  const preflightBlockers = planReleaseBlockers(shots);
  const coverage = heroCoverage(shots, opts.registry, MAX_TEXT_FALLBACK_RATIO);
  const limits = { ...strategyLimits(strategy, 1, { aiVideoEnabled: true, units: getGenerativeUnitCosts("runway") }), cinematic: true };
  const allocated = allocateShotTypes(shots, narrationSeconds, limits);
  // 2) Ejecución con proveedores falsos.
  const pool = poolProvider([...adversarial, ...truthfulPool(beats, topic)]);
  const image = fakeImageProvider();
  const mem = memoryShotAssetStore();
  const deps: ShotExecutionDeps = {
    topic,
    footageProvider: pool.provider,
    imageProvider: image.provider,
    store: mem.store,
    budget: await ProductionBudget.open(memoryBudgetStore(), { maxAiImageGenerations: allocated.aiImageGenerations, maxAiVideoClips: allocated.aiVideoClipCount, maxGenerativeUsd: 50 }),
    units: getGenerativeUnitCosts("runway"),
    aiVideoCostConfig: getAiVideoCostConfig("balanced"),
    totalDurationSec: narrationSeconds,
    requireReal: false,
    visualPipeline: "anchored_v1",
    registry: new DocumentAssetRegistry(),
    identify,
    verifyEntityLink: pool.verifyEntityLink,
    verifyEvidenceLink: pool.verifyEvidenceLink,
    ...(opts.registry ? { verifiedAssets: opts.registry } : {}),
  };
  let ledger = emptyAiVideoLedgerState();
  const executions: ShotExecution[] = [];
  for (const shot of allocated.shots) {
    const ex = await executeShot(shot, deps, ledger);
    ledger = ex.aiVideoLedger;
    executions.push(ex);
  }
  // Guarda existente de produce.ts: proporción de escenas degradadas a tarjeta.
  const degradedToText = executions.filter((ex) => ex.deviation?.executed === "text").length;
  const textFallbackRatio = allocated.shots.length > 0 ? degradedToText / allocated.shots.length : 0;
  // 3) Informe (Director + QA) y dirección del render con las MISMAS decisiones.
  const report = buildVisualReport({ requestId: "sim", planVersion: 4, topic, shots: allocated.shots, executions, now: () => 0 });
  const rendered = directAnchoredScenes(
    allocated.shots.map((s, i) => ({ id: s.id, startSeconds: s.startSec, endSeconds: s.endSec, asset: executions[i].asset, motion: s.motion })),
    executions,
    [],
    report.cinematic?.scenes,
  );
  const rows = report.scenes.map((s, i) => {
    const d = report.cinematic!.scenes[i];
    return {
      START: s.startSec.toFixed(1),
      END: s.endSec.toFixed(1),
      TIER: d.tier,
      BEAT_CLASS: d.beatClass ?? "-",
      ERA: d.era,
      PROVENANCE: d.provenance,
      MOTION_CLASS: d.motionClass,
      IDENTITY_REQUIRED: d.identityRequired,
      COST_CLASS: d.costClass,
      CARD: d.cardReason ?? "",
      WHY: d.why,
      ASSET: s.candidateDescription ?? (s.display === "card" ? `[tarjeta] ${s.gap ?? s.deviation ?? ""}`.slice(0, 70) : s.executedType),
    };
  });
  // Puerta de entrega real (la de produce.ts antes de la música/subida/render).
  let gateError: unknown = null;
  try {
    if (preflightBlockers.length > 0 || coverage.blockers.length > 0) throw new LongFormVisualQualityError([...preflightBlockers.map((f) => f.code), ...coverage.blockers]);
    assertVisualQuality(report);
  } catch (err) {
    gateError = err;
  }
  return { shots, allocated, executions, report, rendered, rows, prompts: image.prompts, narrationSeconds, preflightBlockers, coverage, gateError, textFallbackRatio };
}

export function printTable(title: string, rows: Record<string, unknown>[]) {
  console.log(`\n=== ${title} (${rows.length} escenas; salida del informe v4) ===`);
  console.table(rows);
}


// --------------------------------------------------------------------------
// Gucci (fixture offline; nunca el Gucci persistido). Planner v4 que CUMPLE su contrato:
// la persona en escenas IDENTITY, cada prueba con su proposición, la ilustración como PLACE/PROCESS/METAPHOR.
// --------------------------------------------------------------------------

export const GUCCI_TOPIC = "The murder of Maurizio Gucci";
export const MAURIZIO = { name: "Maurizio Gucci", kind: "person" as const, sourceIds: ["web-1"] };

export const gucciBeats: ProductionPlanBeatInput[] = [
  {
    id: "b1",
    type: "hook",
    narration:
      "Maurizio Gucci entered his office building in Milan that morning. The building stood on Via Palestro, quiet and grey under a low spring sky. He climbed the stairs toward his office on the first floor, as he had done for months. Moments later four shots rang out in the stairwell and the doorman ran for help.",
    visuals: [
      { description: "Maurizio Gucci entering his office building in Milan", motion: true, quote: "Maurizio Gucci entered his office building in Milan", subject: "Maurizio Gucci", action: "entering", place: "Milan", era: "1995", beatClass: "IDENTITY", identity: MAURIZIO },
      { description: "facade of an office building in Milan", motion: false, quote: "his office building in Milan that morning", subject: "office building", place: "Milan", era: "1990s", beatClass: "PLACE" },
      { description: "quiet street in central Milan with grey buildings", motion: false, quote: "The building stood on Via Palestro, quiet and grey", subject: "street", place: "Milan", era: "1990s", beatClass: "PLACE" },
      { description: "Maurizio Gucci climbing the stairs toward his office", motion: true, quote: "He climbed the stairs toward his office on the first floor", subject: "Maurizio Gucci", action: "climbing", place: "Milan", era: "1995", beatClass: "IDENTITY", identity: MAURIZIO },
      { description: "Italian newspaper front page reporting a shooting", motion: false, quote: "Moments later four shots rang out in the stairwell", subject: "newspaper", place: "Milan", era: "1995", beatClass: "EVIDENCE", evidence: { sourceIds: ["web-2"] } },
    ],
  },
  {
    id: "b2",
    type: "setup",
    narration:
      "Textile workshop in Florence in the 1950s. Rows of looms worked from dawn to dusk while cloth moved between skilled hands. The family business had grown from a small leather shop near the river. Its handbags and luggage became symbols of Italian craft, sold to film stars and travellers across Europe.",
    visuals: [
      { description: "textile workshop in Florence in the 1950s with weavers at looms", motion: true, quote: "Textile workshop in Florence in the 1950s", subject: "textile workshop", action: "weaving", place: "Florence", era: "1950s", beatClass: "PROCESS" },
      { description: "looms weaving cloth in a textile workshop", motion: true, quote: "Rows of looms worked from dawn to dusk", subject: "looms", action: "weaving", place: "Florence", era: "1950s", beatClass: "PROCESS" },
      { description: "old leather shop near the Arno river in Florence", motion: false, quote: "a small leather shop near the river", subject: "leather shop", place: "Florence", era: "1950s", beatClass: "PLACE" },
      { description: "vintage leather handbag in a museum display", motion: false, quote: "Its handbags and luggage became symbols of Italian craft", subject: "handbag", era: "1950s", beatClass: "METAPHOR" },
    ],
  },
  {
    id: "b3",
    type: "twist",
    narration:
      "Maurizio Gucci walked through the textile workshop in Florence. He had inherited half of the company from his father Rodolfo in the early eighties. Board meetings in Milan grew tense as the family argued over control of the name, the shops and the future of the brand.",
    visuals: [
      { description: "Maurizio Gucci walking through a textile workshop in Florence", motion: true, quote: "Maurizio Gucci walked through the textile workshop in Florence", subject: "Maurizio Gucci", action: "walking", place: "Florence", era: "1980s", beatClass: "IDENTITY", identity: MAURIZIO },
      { description: "company share register recording the inheritance", motion: false, quote: "He had inherited half of the company from his father", subject: "share register", era: "1980s", beatClass: "EVIDENCE", evidence: { sourceIds: ["web-3"] } },
      { description: "empty boardroom with a long table in Milan", motion: false, quote: "Board meetings in Milan grew tense", subject: "boardroom", place: "Milan", era: "1980s", beatClass: "PLACE" },
    ],
  },
  {
    id: "b4",
    type: "setup",
    narration:
      "In the nineteen eighties the brand expanded across Europe and America. New boutiques opened on famous shopping streets from Rome to New York. Licences put the name on hundreds of products, from key rings to whisky glasses. Critics warned that the label was losing the prestige that had made it famous, and sales of the most visible goods began to slow.",
    visuals: [
      { description: "luxury boutique storefront on a shopping street", motion: false, quote: "New boutiques opened on famous shopping streets", subject: "boutique", era: "1980s", beatClass: "PLACE" },
      { description: "vintage magazine advertisement for licensed products", motion: false, quote: "Licences put the name on hundreds of products", subject: "magazine advertisement", era: "1980s", beatClass: "EVIDENCE", evidence: { sourceIds: ["web-4"] } },
      { description: "shoppers walking along a luxury shopping street", motion: true, quote: "Critics warned that the label was losing the prestige", subject: "shoppers", action: "walking", era: "1980s", beatClass: "PROCESS" },
    ],
  },
  {
    id: "b5",
    type: "escalation",
    narration:
      "By the early nineties the company was deep in debt and its owners were fighting in court. Investors from Bahrain bought shares through the investment firm Investcorp. In 1993 Maurizio sold his remaining stake and left the business his grandfather had founded. A new creative team began to rebuild the brand in the years that followed.",
    visuals: [
      { description: "financial newspaper headlines about corporate debt", motion: false, quote: "the company was deep in debt and its owners were fighting", subject: "newspaper", era: "1990s", beatClass: "EVIDENCE", evidence: { sourceIds: ["web-5"] } },
      { description: "modern office tower of an investment firm", motion: false, quote: "Investors from Bahrain bought shares through the investment firm", subject: "office tower", era: "1990s", beatClass: "PLACE" },
      { description: "Maurizio Gucci signing documents", motion: false, quote: "In 1993 Maurizio sold his remaining stake", subject: "Maurizio Gucci", action: "signing", era: "1993", beatClass: "IDENTITY", identity: MAURIZIO },
      { description: "fashion runway show in Milan in the 1990s", motion: true, quote: "A new creative team began to rebuild the brand", subject: "runway show", place: "Milan", era: "1990s", beatClass: "PROCESS" },
    ],
  },
  {
    id: "b6",
    type: "payoff",
    narration:
      "Two years later he was dead. The investigation lasted more than two years and followed money, debts and a circle of hired men. In 1998 a court in Milan convicted his former wife of ordering the murder. The trial filled newspapers for months, and the case became one of the most famous in modern Italian history.",
    visuals: [
      { description: "Palace of Justice courthouse exterior in Milan", motion: false, quote: "The investigation lasted more than two years", subject: "courthouse", place: "Milan", era: "1990s", beatClass: "PLACE" },
      { description: "court ruling documents of the 1998 murder trial", motion: false, quote: "In 1998 a court in Milan convicted his former wife", subject: "court documents", era: "1998", beatClass: "EVIDENCE", evidence: { sourceIds: ["web-6"] } },
      { description: "stack of Italian newspapers about a famous trial", motion: false, quote: "The trial filled newspapers for months", subject: "newspapers", era: "1998", beatClass: "EVIDENCE", evidence: { sourceIds: ["web-6"] } },
    ],
  },
  {
    id: "b7",
    type: "setup",
    narration:
      "After the trial the company changed owners again and moved its design studio back to Florence. A French luxury group bought control at the end of the decade. New flagship stores opened in Tokyo, Paris and New York, with marble floors and glass facades. The archive of old handbags and sketches was catalogued and opened to researchers for the first time.",
    visuals: [
      { description: "design studio with sketches pinned to a wall in Florence", motion: false, quote: "moved its design studio back to Florence", subject: "design studio", place: "Florence", era: "2000s", beatClass: "PLACE" },
      { description: "corporate headquarters of a French luxury group in Paris", motion: false, quote: "A French luxury group bought control", subject: "headquarters", place: "Paris", era: "2000s", beatClass: "PLACE" },
      { description: "flagship luxury store with marble floors and glass facade", motion: true, quote: "New flagship stores opened in Tokyo, Paris and New York", subject: "flagship store", era: "2000s", beatClass: "PLACE" },
      { description: "archive room with shelves of vintage handbags and sketches", motion: false, quote: "The archive of old handbags and sketches was catalogued", subject: "archive room", place: "Florence", era: "2000s", beatClass: "PLACE" },
    ],
  },
  {
    id: "b8",
    type: "payoff",
    narration:
      "Today the building on Via Palestro looks like any other office block in central Milan. Tourists walk past without knowing what happened on its stairs. The story of the family has been told in books, documentaries and films, each one returning to the same question about ambition, money and a name that outlived the people who carried it. In Florence the first workshop is now part of a museum that tells the history of the house to visitors from around the world.",
    visuals: [
      { description: "office block on a tree lined street in central Milan today", motion: false, quote: "Today the building on Via Palestro looks like any other office block", subject: "office block", place: "Milan", era: "2020s", beatClass: "PLACE" },
      { description: "tourists walking past buildings on a Milan street", motion: true, quote: "Tourists walk past without knowing what happened", subject: "tourists", action: "walking", place: "Milan", era: "2020s", beatClass: "PROCESS" },
      { description: "stack of books and film reels on a table", motion: false, quote: "The story of the family has been told in books, documentaries and films", subject: "books", era: "2020s", beatClass: "METAPHOR" },
      { description: "museum gallery with vintage luggage in glass cases in Florence", motion: false, quote: "In Florence the first workshop is now part of a museum", subject: "museum gallery", place: "Florence", era: "2020s", beatClass: "PLACE" },
    ],
  },
];

/** El MISMO guion con el planner que NO cumple: la subida por la escalera de Maurizio declarada como TRANSITION sin identidad. */
export const gucciBeatsMisclassified: ProductionPlanBeatInput[] = gucciBeats.map((b) =>
  b.id !== "b1"
    ? b
    : {
        ...b,
        visuals: (b.visuals as Record<string, unknown>[]).map((v) =>
          v.quote === "He climbed the stairs toward his office on the first floor" ? { description: "man climbing stairs toward an office", motion: true, quote: v.quote, subject: "stairs", action: "climbing", place: "Milan", era: "1995", beatClass: "TRANSITION" } : v,
        ),
      },
);

export const FEET: Pooled = { id: "adv-feet", description: "anonymous feet climbing stairs", similarity: 0.95, media: "video" };
export const BELLBOY: Pooled = { id: "adv-bellboy", description: "bellboy building attendant on the stairs of a Milan hotel", similarity: 0.93, media: "image" };
export const BUSINESSMAN: Pooled = { id: "adv-businessman", description: "businessman in a suit climbing stairs in a Milan office building", similarity: 0.92, media: "video" };
/** Periódico sobre OTRO hecho (un tiroteo) con más similitud que la prueba correcta de la deuda. */
export const WRONG_NEWSPAPER: Pooled = { id: "adv-wrong-newspaper", description: "Italian newspaper front page reporting a shooting", similarity: 0.94, media: "image" };

/** Falsos amigos de ALTA similitud: siguen en el pool en todos los escenarios. */
export const gucciAdversarial: Pooled[] = [FEET, BELLBOY, BUSINESSMAN, WRONG_NEWSPAPER];

const curation = { curatedBy: "fixture-curator", curatedAt: "2026-10-07T00:00:00Z", basis: "fixture offline: material legítimo del escenario de prueba" };
const licensed = (ref: string) => ({ kind: "LICENSED" as const, rightsReference: ref });
const rec = (id: string, description: string, link: Pick<VerifiedAssetRecord, "entityLink" | "evidenceLink">, width = 2400, height = 1600): VerifiedAssetRecord => ({
  id,
  source: "licensed_archive",
  sourceUrl: `https://archive.example/record/${id}`,
  mediaUrl: `https://archive.example/media/${id}.jpg`,
  mediaType: "image",
  mime: "image/jpeg",
  width,
  height,
  rights: licensed(`fixture-licence-${id}`),
  creator: "Archivio (fixture)",
  creditText: "Archivio fotografico (fixture)",
  description,
  ...link,
  curation,
});

/**
 * Material LEGÍTIMO del fixture como registros curados del servidor (con menor
 * similitud que los falsos amigos: no compiten por ranking, los habilita la verificación).
 */
export const gucciVerifiedRecords: VerifiedAssetRecord[] = [
  rec("ver-portrait", "Maurizio Gucci archival portrait photograph, Milan", { entityLink: { name: "Maurizio Gucci" } }),
  rec("ver-press", "Maurizio Gucci at a press conference in Milan", { entityLink: { name: "Maurizio Gucci" } }, 2000, 1333),
  rec("ev-murder-1", "Corriere della Sera front page of 28 March 1995 on the murder", { evidenceLink: { sourceIds: ["web-2"] } }),
  rec("ev-murder-2", "police photograph of the stairwell on Via Palestro, March 1995", { evidenceLink: { sourceIds: ["web-2"] } }),
  rec("ev-licences", "1980s advertisement for licensed Gucci products", { evidenceLink: { sourceIds: ["web-4"] } }),
  rec("ev-debt-1", "1993 financial press report on the company debt", { evidenceLink: { sourceIds: ["web-5"] } }),
  rec("ev-debt-2", "Investcorp share purchase announcement, 1993", { evidenceLink: { sourceIds: ["web-5"] } }),
  rec("ev-trial-1", "Milan court ruling of 1998 in the murder case", { evidenceLink: { sourceIds: ["web-6"] } }),
  rec("ev-trial-2", "Italian newspapers of November 1998 on the verdict", { evidenceLink: { sourceIds: ["web-6"] } }),
];

/** Registros que NO deben entrar: baja resolución y CC BY-SA (fuera de V1). */
export const gucciRegistryDecoys: VerifiedAssetRecord[] = [
  { ...rec("lowres-portrait", "Maurizio Gucci photograph (small)", { entityLink: { name: "Maurizio Gucci" } }, 442, 590) },
  { ...rec("bysa-portrait", "Maurizio Gucci at an event", { entityLink: { name: "Maurizio Gucci" } }), source: "commons", rights: { kind: "CC_BY_SA" as never }, creditText: "x" },
];

export const gucciRegistry = () => VerifiedAssetRegistry.load([...gucciVerifiedRecords, ...gucciRegistryDecoys]);

// --------------------------------------------------------------------------
// produce() real, offline (proveedores falsos que registran cada llamada)
// --------------------------------------------------------------------------

export function makeStorage() {
  const files = new Map<string, Buffer>();
  return {
    from() {
      return {
        async download(p: string) {
          const buf = files.get(p);
          return buf ? { data: { text: async () => buf.toString("utf8"), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }, error: null } : { data: null, error: { message: "nf" } };
        },
        async upload(p: string, body: Buffer) {
          files.set(p, Buffer.from(body));
          return { error: null };
        },
      };
    },
  };
}

export function countingProviders(events: string[], failDownloads?: RegExp) {
  const voiceProvider: VoiceProvider = { name: "fake-voice", synthesize: async (t, l, s) => (events.push("voice"), fixtureVoiceProvider.synthesize(t, l, s)) };
  const footageProvider: FootageProvider = {
    name: "fake-stock",
    async fetchFootage(query) {
      events.push("stock");
      return { url: `https://stock/v/${encodeURIComponent(query)}.mp4`, mediaType: "video", mimeType: "video/mp4", extension: "mp4" };
    },
    async searchImageCandidates(query) {
      events.push("stock");
      return Array.from({ length: 8 }, (_, i) => ({ url: `https://stock/i/${encodeURIComponent(query)}/${i}.jpg`, sourceId: `img-${query}-${i}`, description: query, mediaType: "image" as const, mimeType: "image/jpeg", extension: "jpg" }));
    },
    async downloadFootage(url) {
      if (failDownloads?.test(url)) throw new Error("archivo no disponible");
      return Buffer.from(`bytes:${url}`);
    },
  };
  const imageProvider: ImageProvider = {
    name: "fake-openai",
    capabilities: { id: "o", models: ["m"], formats: ["image/png"], aspectRatios: ["16:9"], timeoutMs: 1, maxRetries: 0 },
    isAvailable: () => true,
    async generateImage() {
      events.push("image");
      throw new Error("no se espera imagen IA");
    },
  };
  const musicProvider: MusicProvider = { name: "fake-music", getTrack: async (ctx) => (events.push("music"), fixtureMusicProvider.getTrack(ctx)) };
  return { voiceProvider, footageProvider, imageProvider, musicProvider };
}

export async function produceOffline(beats: ProductionPlanBeatInput[], plan: ProductionPlan, opts: { verifiedAssets?: VerifiedAssetRegistry; failDownloads?: RegExp } = {}) {
  const events: string[] = [];
  const out = memoryOutputDeps({ durationSeconds: 60 });
  const runtime: LongFormRuntime = {
    paidCalls: { ledger: memoryLedgerStore(), results: memoryResultStore() },
    store: memoryShotAssetStore().store,
    budgetStore: memoryBudgetStore(),
    observedUnitMax: {},
    ...(opts.verifiedAssets ? { verifiedAssets: opts.verifiedAssets } : {}),
    videoProvider: null,
    aiVideoEnabled: false,
    recordCosts: false,
    resumeBackoffMs: 0,
    output: out.deps,
    uploadArtifact: async (p) => (events.push(`upload:${p.split("/").pop()}`), { path: p, url: `memory://${p}` }),
    identify: async (b) => ({ sha256: createHash("sha256").update(b).digest("hex"), dhashUnavailable: "test" }),
    saveVisualReport: async () => {
      events.push("visual-report");
    },
    render: async () => {
      events.push("render");
      const file = path.join(os.tmpdir(), `rg-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
      fs.writeFileSync(file, "fake-mp4");
      return file;
    },
    renderThumbnail: async () => {
      events.push("thumbnail");
      const file = path.join(os.tmpdir(), `rg-thumb-${Date.now()}.jpg`);
      fs.writeFileSync(file, "fake-jpg");
      return file;
    },
  };
  let error: unknown = null;
  try {
    await generateLongFormVideoFromScript({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: { storage: makeStorage() } as any,
      requestId: "req-release-gate",
      artifactPrefix: "req-release-gate/attempt-1",
      topic: GUCCI_TOPIC,
      beats: beats as never,
      language: "en",
      plan,
      providers: countingProviders(events, opts.failDownloads),
      runtime,
    });
  } catch (err) {
    error = err;
  }
  return { events, error };
}

export const planFor = (beats: ProductionPlanBeatInput[], strategy: "economical" | "balanced" = "economical") =>
  ({ ...computeProductionPlan({ beats, topic: GUCCI_TOPIC, strategy, providers: REAL_LONG_FORM_PROVIDER_NAMES, aiVideoEnabled: false }), confirmedAt: "2026-10-07T00:00:00Z" }) as ProductionPlan;

