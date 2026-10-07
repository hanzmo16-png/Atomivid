import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { validateDirection, wideFieldBox, detailLayout, safeAreas, typeScale } from "../../../../remotion/long-form-direction";
import type { LongFormShotScene } from "../../../../remotion/LongFormDoc";
import { tierSeconds } from "./cinematic-director";
import { EXECUTABLE_PLAN_VERSIONS, PRODUCTION_PLAN_VERSION } from "./production-plan-types";
import { planShotsFromScript, computeProductionPlan, REAL_LONG_FORM_PROVIDER_NAMES } from "./production-plan";
import { heroCoverage } from "./verified-assets";
import { MAX_TEXT_FALLBACK_RATIO } from "./produce";
import { emptyCurationFile } from "./asset-curation";
import { containsFixtureOnlyMaterial } from "./fixture-only";
import { HUMAN_STAND_IN_TERMS, PLAN_ESTIMATE_AVAILABILITY, registryAvailability, resolveSequences, validateSequenceIntents, type SequenceIntent, type SlotAvailability } from "./sequence-intent";
import { planSequenceShots, sequenceDirectionFindings } from "./sequence-direction";
import {
  BELLBOY,
  BUSINESSMAN,
  FEET,
  GUCCI_TOPIC,
  MAURIZIO_KEY,
  WRONG_NEWSPAPER,
  curateFixture,
  gucciAdversarial,
  gucciBeats,
  gucciRegistry,
  gucciRequested,
  gucciSequences,
  planFor,
  poolProvider,
  produceOffline,
  rehydrateFixture,
  truthfulPool,
} from "./cinematic-simulation";
import { SHOWCASE_TOPIC, showcaseAssets, showcaseBeats, showcaseFootageProvider, showcaseRegistry, showcaseSequences } from "./showcase-fixtures";

/**
 * Directed Opening V1 (plan v5): la secuencia es la columna. La intención
 * existe ANTES de elegir recursos; el selector y el registro verificado solo
 * responden si un recurso legal y verdadero puede ocupar cada rol.
 */

let networkCalls = 0;
globalThis.fetch = (async () => {
  networkCalls++;
  throw new Error("directed opening: red prohibida");
}) as typeof fetch;

const BASE = "http://127.0.0.1:0";
const FORBIDDEN = [FEET, BELLBOY, BUSINESSMAN, WRONG_NEWSPAPER];
const adversarialPool = () => poolProvider([...gucciAdversarial, ...truthfulPool(gucciBeats, GUCCI_TOPIC)]).provider;

// --------------------------------------------------------------------------
// Contrato de secuencia
// --------------------------------------------------------------------------

test("contrato: roles cerrados, escala con razón, DETAIL solo sobre una región curada de un plano anterior; CONTEXT nunca es una persona", () => {
  assert.deepEqual(validateSequenceIntents(showcaseSequences, showcaseBeats).errors, []);
  assert.deepEqual(validateSequenceIntents(gucciSequences(), gucciBeats).errors, []);
  const base = showcaseSequences;
  const mutate = (f: (s: SequenceIntent[]) => void) => {
    const copy = JSON.parse(JSON.stringify(base)) as SequenceIntent[];
    f(copy);
    return validateSequenceIntents(copy, showcaseBeats).errors;
  };
  assert.ok(mutate((s) => ((s[0].slots[0].role as string) = "HERO_SHOT")).some((e) => /lista cerrada/.test(e)));
  assert.ok(mutate((s) => (s[0].slots[1].scaleReason = "")).some((e) => /razón narrativa/.test(e)));
  assert.ok(mutate((s) => (s[1].slots[1].detail = { of: 0, region: "random_corner" as never })).some((e) => /región curada/.test(e)));
  assert.ok(mutate((s) => (s[1].slots[1].detail = { of: 2, region: "headline" })).some((e) => /ANTERIOR/.test(e)));
  assert.ok(mutate((s) => (s[0].slots[0].visual = { ...s[0].slots[0].visual, identity: { name: "Fixture Person", kind: "person" } })).some((e) => /nunca representa a una persona/.test(e)));
  assert.ok(mutate((s) => (s[0].slots[0].scale = "DETAIL")).some((e) => /solo existe para el rol DETAIL/.test(e)));
  assert.ok(mutate((s) => s.reverse()).some((e) => /en orden/.test(e)));
  assert.ok(mutate((s) => (s[0].viewerTakeaway = "")).some((e) => /entender\/sentir/.test(e)));
  // TRANSITION nunca es un plano de acción.
  assert.ok(mutate((s) => s[0].slots.push({ role: "TRANSITION", scale: "WIDE", scaleReason: "x", beatId: "s1", visual: { description: "man walking", action: "walking", beatClass: "TRANSITION" } })).some((e) => /acción/.test(e)));
});

// --------------------------------------------------------------------------
// Resolver: intención → roles → disponibilidad → ejecutable / recomposición / abstención
// --------------------------------------------------------------------------

const none: SlotAvailability = { covers: () => false, curatedSvg: () => false, regions: () => [] };

test("resolver: el selector no es el cerebro — la intención y los roles existen ANTES de cualquier recurso", () => {
  const optimistic = resolveSequences(showcaseSequences, PLAN_ESTIMATE_AVAILABILITY);
  assert.deepEqual(optimistic.map((s) => s.slots.map((x) => `${x.role}/${x.scale}/${x.status}`)), [
    ["CONTEXT/WIDE/PENDING_SELECTOR", "ANCHOR/MEDIUM/FILL"],
    ["EVIDENCE/WIDE/FILL", "DETAIL/DETAIL/FILL", "GEOGRAPHY/WIDE/FILL"],
  ]);
  assert.equal(optimistic[0].viewerTakeaway, showcaseSequences[0].viewerTakeaway, "el propósito viaja con la secuencia ejecutable");
  // Sin material: nada se rellena con un sustituto genérico.
  const empty = resolveSequences(showcaseSequences, none);
  assert.deepEqual(empty[0].slots.map((s) => s.status), ["PENDING_SELECTOR", "ABSTAIN"]);
  assert.deepEqual(empty[1].slots.map((s) => s.status), ["ABSTAIN", "DROPPED", "ABSTAIN"]);
  assert.equal(empty[0].slots[1].role, "TRANSITION", "ancla sin material: ausencia dirigida (año/texto), nunca un doble");
});

test("resolver: recomposición verdadera — sin la persona, el documento VERIFICADO de la secuencia; nunca otra proposición por una prueba", () => {
  const onlyDocument: SlotAvailability = { covers: (v) => !!v.evidence?.sourceIds.includes("fixture-src-1"), curatedSvg: () => false, regions: () => [] };
  const seq: SequenceIntent[] = [
    { ...showcaseSequences[1], id: "R", beatIds: ["s1", "s2"], slots: [{ role: "ANCHOR", scale: "MEDIUM", scaleReason: "the person", beatId: "s1", visual: showcaseSequences[0].slots[1].visual }, ...showcaseSequences[1].slots] },
  ];
  const [r] = resolveSequences(seq, onlyDocument);
  assert.equal(r.slots[0].status, "RECOMPOSED");
  assert.equal(r.slots[0].role, "EVIDENCE");
  assert.deepEqual(r.slots[0].visual.evidence?.sourceIds, ["fixture-src-1"]);
  assert.equal(r.slots[0].visual.identity, undefined, "la escena deja de afirmar que muestra a la persona");
  assert.equal(r.slots[2].status, "DROPPED", "sin región curada no se fabrica un detalle");
  assert.equal(r.slots[3].status, "ABSTAIN", "una prueba que falta nunca se rellena con otra");
});

test("resolver: GEOGRAPHY solo con un SVG curado y la capacidad real del renderer; nunca se infiere geografía", () => {
  const svg: SlotAvailability = { covers: () => true, curatedSvg: () => true, regions: () => ["headline"] };
  assert.equal(resolveSequences(showcaseSequences, svg)[1].slots[2].status, "FILL");
  assert.equal(resolveSequences(showcaseSequences, { ...svg, curatedSvg: () => false })[1].slots[2].status, "ABSTAIN");
  assert.equal(resolveSequences(showcaseSequences, svg, { svg_reveal: "PLANNED_NOT_SUPPORTED" })[1].slots[2].status, "ABSTAIN");
});

test("resolver: en una secuencia sobre una persona, CONTEXT hereda el filtro de dobles (el mecanismo v4 personActions), sin tocar el selector", () => {
  const [g1] = resolveSequences(gucciSequences(), registryAvailability(gucciRegistry()));
  const context = g1.slots.find((s) => s.role === "CONTEXT")!;
  for (const t of ["bellboy", "attendant", "businessman", "feet"]) assert.ok(context.visual.personActions?.includes(t), t);
  assert.ok(HUMAN_STAND_IN_TERMS.length > 10);
  // Una secuencia sin persona (expansión de la marca) no lo necesita.
  const g4 = resolveSequences(gucciSequences(), registryAvailability(gucciRegistry()))[3];
  assert.ok(g4.slots.filter((s) => s.role === "CONTEXT").every((s) => !s.visual.personActions?.includes("bellboy")));
});

// --------------------------------------------------------------------------
// v4 inmutable; v5 opt-in; FIXTURE_ONLY fuera de producción
// --------------------------------------------------------------------------

test("v4 inmutable: sin secuencias el plan sigue siendo v4 idéntico; v5 no es ejecutable por el worker", () => {
  assert.equal(PRODUCTION_PLAN_VERSION, 4);
  assert.deepEqual([...EXECUTABLE_PLAN_VERSIONS], [1, 2, 3, 4], "el worker no ejecuta v5 todavía (activación explícita futura)");
  const v4 = computeProductionPlan({ beats: gucciBeats, topic: GUCCI_TOPIC, strategy: "economical", providers: REAL_LONG_FORM_PROVIDER_NAMES, aiVideoEnabled: false });
  assert.equal(v4.version, 4);
  assert.equal("sequences" in v4, false);
  assert.equal(v4.shotCount, planShotsFromScript(gucciBeats, GUCCI_TOPIC, "economical").shots.length);
  const v5 = planFor(gucciBeats, "economical", gucciSequences());
  assert.equal(v5.version, 5);
  assert.equal(v5.scriptHash, v4.scriptHash, "mismo guion");
  assert.throws(() => computeProductionPlan({ beats: showcaseBeats, strategy: "economical", providers: REAL_LONG_FORM_PROVIDER_NAMES, aiVideoEnabled: false, sequences: [{ ...showcaseSequences[0], slots: [] }, showcaseSequences[1]] }), /secuencias inválidas/);
});

test("FIXTURE_ONLY: un recurso de benchmark no puede entrar en una solicitud real (aunque lo apruebe un curador autorizado)", async () => {
  const a = showcaseAssets(BASE);
  for (const asset of Object.values(a)) assert.ok(containsFixtureOnlyMaterial({ assets: [asset] }), asset.id);
  assert.equal(containsFixtureOnlyMaterial({ assets: [gucciRegistryAsset()] }), false, "el material licenciado del fixture v4 no lleva la marca");
  const prev = process.env.ASSET_CURATOR_EMAILS;
  process.env.ASSET_CURATOR_EMAILS = "curator@atomivid.test";
  try {
    // Archivo de curaduría coherente y aprobado por un curador autorizado, con material FIXTURE_ONLY.
    const file = curateFixture([{ asset: a.portrait, key: MAURIZIO_KEY }], gucciRequested());
    const run = await produceOffline(gucciBeats, planFor(gucciBeats), { curationFile: JSON.parse(JSON.stringify(file)) });
    assert.match(String(run.error), /FIXTURE_ONLY_MATERIAL/);
    assert.deepEqual(run.events, [], "se detiene antes de cualquier llamada");
    assert.equal(rehydrateFixture(file).size, 1, "solo el cargador de PRODUCCIÓN lo rechaza; las pruebas pueden curarlo");
  } finally {
    if (prev === undefined) delete process.env.ASSET_CURATOR_EMAILS;
    else process.env.ASSET_CURATOR_EMAILS = prev;
  }
  // Ningún módulo de producción importa los fixtures (solo pruebas y scripts de prueba).
  const root = path.join(process.cwd(), "src");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !/(showcase-fixtures|premium-fixtures|cinematic-simulation)\.ts$/.test(e.name)) {
        if (/from "\.\/(showcase-fixtures|premium-fixtures|cinematic-simulation)"|long-form\/(showcase-fixtures|premium-fixtures|cinematic-simulation)"/.test(fs.readFileSync(p, "utf8"))) offenders.push(path.relative(root, p));
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
  assert.equal(emptyCurationFile("x").assets.length, 0);
});

// --------------------------------------------------------------------------
// HONEST-GUCCI: cuando la verdad falta, v5 recompone sin mentir
// --------------------------------------------------------------------------

test("HONEST-GUCCI A (sin registro): mismo resolver, todas las anclas y pruebas en ausencia dirigida, y sigue BLOQUEANDO antes de gastar", async () => {
  const resolved = resolveSequences(gucciSequences(), registryAvailability(undefined));
  const slots = resolved.flatMap((s) => s.slots);
  assert.ok(slots.filter((s) => s.visual.identity).every((s) => s.status === "ABSTAIN"));
  assert.ok(slots.filter((s) => s.role === "EVIDENCE").every((s) => s.status === "ABSTAIN"));
  const run = await produceOffline(gucciBeats, planFor(gucciBeats, "economical", gucciSequences()), { footageProvider: adversarialPool() });
  assert.match(String(run.error), /HERO_EVIDENCE_COVERAGE_MISSING/);
  assert.deepEqual(run.events, [], "0 voz, 0 stock, 0 imagen, 0 música, 0 render");
});

test("HONEST-GUCCI C (un retrato, cero pruebas): sigue BLOQUEANDO antes de gastar", async () => {
  const c = rehydrateFixture(curateFixture([{ asset: { ...gucciRegistryAsset(), id: "ver-portrait" }, key: MAURIZIO_KEY }], gucciRequested()));
  const run = await produceOffline(gucciBeats, planFor(gucciBeats, "economical", gucciSequences()), { verifiedAssets: c, footageProvider: adversarialPool() });
  assert.match(String(run.error), /HERO_EVIDENCE_COVERAGE_MISSING/);
  assert.deepEqual(run.events, []);
});

function gucciRegistryAsset() {
  return {
    id: "ver-portrait",
    source: "licensed_archive" as const,
    sourceUrl: "https://archive.example/record/ver-portrait",
    mediaUrl: "https://archive.example/media/ver-portrait.jpg",
    mediaType: "image" as const,
    mime: "image/jpeg",
    width: 2400,
    height: 1600,
    rights: { kind: "LICENSED" as const, rightsReference: "fixture-licence-ver-portrait" },
    creator: "Archivio (fixture)",
    creditText: "Archivio fotografico (fixture)",
    description: "Maurizio Gucci archival portrait photograph, Milan",
  };
}

test("HONEST-GUCCI B (registro del fixture v4): pies, botones, ejecutivo, periódico equivocado y persona generada AUSENTES; la prueba que falta es una ausencia dirigida", async () => {
  let report: { scenes: { candidateDescription?: string; display?: string }[] } | null = null;
  let input: { scenes: LongFormShotScene[] } | null = null;
  const run = await produceOffline(gucciBeats, planFor(gucciBeats, "economical", gucciSequences()), {
    verifiedAssets: gucciRegistry(),
    footageProvider: adversarialPool(),
    onReport: (r) => (report = r as never),
    onRender: (i) => (input = i as never),
  });
  assert.equal(run.error, null, String(run.error));
  const shown = report!.scenes.map((s) => s.candidateDescription);
  for (const adv of FORBIDDEN) assert.ok(!shown.includes(adv.description), `${adv.id} ausente`);
  assert.ok(!run.events.includes("image"), "ninguna persona generada");
  const scenes = input!.scenes;
  assert.ok(scenes.every((s) => s.direction?.shot), "toda escena v5 lleva rol y escala");
  const cards = scenes.filter((s) => s.asset.kind === "graphic");
  assert.ok(cards.length > 0 && cards.every((s) => s.direction?.shot?.card), "ausencias dirigidas (no plantilla)");
  // El DETAIL del titular de la deuda no tiene región curada: no existe en la película.
  assert.ok(!scenes.some((s) => s.direction?.shot?.scale === "DETAIL"));
  assert.doesNotThrow(() => validateDirection(scenes, undefined, 1000));
  assert.equal(networkCalls, 0);
});

// --------------------------------------------------------------------------
// SHOWCASE: los MISMOS cuatro recursos dirigidos de otra manera
// --------------------------------------------------------------------------

async function showcase(sequences?: SequenceIntent[]) {
  let input: { scenes: LongFormShotScene[]; captions: unknown[] } | null = null;
  const downloaded = new Set<string>();
  const run = await produceOffline(showcaseBeats, planFor(showcaseBeats, "economical", sequences, SHOWCASE_TOPIC), {
    topic: SHOWCASE_TOPIC,
    verifiedAssets: showcaseRegistry(BASE),
    footageProvider: showcaseFootageProvider(BASE, async (u) => (downloaded.add(u), Buffer.from(`bytes:${u}`))),
    onRender: (i) => (input = i as never),
  });
  assert.equal(run.error, null, String(run.error));
  return { ...input!, downloaded: [...downloaded].sort() };
}

test("SHOWCASE: BEFORE (v4) y AFTER (v5) usan EXACTAMENTE los mismos cuatro recursos y la misma duración", async () => {
  const before = await showcase();
  const after = await showcase(showcaseSequences);
  assert.deepEqual(after.downloaded, before.downloaded, "mismos archivos de origen");
  assert.deepEqual(after.downloaded.map((u) => u.split("/").pop()), ["district.png", "document.png", "portrait.png", "schematic.svg"]);
  const end = (s: { scenes: LongFormShotScene[] }) => s.scenes[s.scenes.length - 1].endSeconds;
  assert.ok(Math.abs(end(before) - end(after)) < 0.5, `${end(before)} vs ${end(after)}`);
  // Los subtítulos se cortan en cada corte de escena (producción), así que su partición cambia; el texto no.
  const words = (c: unknown[]) => (c as { text: string }[]).map((x) => x.text).join(" ").split(/\s+/);
  assert.deepEqual(words(after.captions), words(before.captions), "mismas palabras y orden: solo cambia la dirección");
});

test("SHOWCASE AFTER: contraste de escala con corte seco y justificado; el titular CURADO es el plano; fundido solo en la frontera", async () => {
  const after = await showcase(showcaseSequences);
  const s = after.scenes;
  assert.deepEqual(s.map((x) => `${x.direction?.shot?.role}/${x.direction?.shot?.scale}/${x.direction?.transition?.type}`), [
    "CONTEXT/WIDE/cut",
    "ANCHOR/MEDIUM/cut",
    "EVIDENCE/WIDE/dissolve",
    "DETAIL/DETAIL/cut",
    "GEOGRAPHY/WIDE/cut",
  ]);
  assert.deepEqual(s[3].direction?.shot?.region, { label: "headline", x: 0.06, y: 0.15, w: 0.88, h: 0.14 }, "la región viene del registro curado");
  assert.deepEqual(sequenceDirectionFindings(s, s.map((_, i) => ({ sequenceSlot: { sequenceId: i < 2 ? "S1" : "S2" } as never }))), []);
  // El titular domina el cuadro y la página sigue visible, sin ampliar más allá de la fuente.
  const d = s[3].direction!.shot!;
  for (const [w, h] of [[1920, 1080], [1080, 1920]]) {
    const L = detailLayout(d.region!, d.sourceWidth!, d.sourceHeight!, w, h, 1);
    assert.ok(L.focus.w >= 0.75 * w, `titular ${L.focus.w.toFixed(0)} px de ${w}`);
    assert.ok(L.final <= 1 + 1e-9, "nunca más de 1 px de fuente por px");
    assert.ok(L.page.x > 0 && L.page.x + L.page.w < w, "los bordes de la página siguen a la vista");
  }
  assert.doesNotThrow(() => validateDirection(s, undefined, 60));
});

test("SHOWCASE BEFORE (v4 actual) repite el mismo tratamiento: se ve en el diagnóstico, no solo en el informe", async () => {
  const before = await showcase();
  const findings = sequenceDirectionFindings(before.scenes, before.scenes.map(() => ({})));
  assert.ok(findings.some((f) => f.code === "IDENTICAL_PUSH_RUN"), JSON.stringify(findings));
});

test("30 s en vertical: la MISMA lógica de secuencia, todo el corto es HERO y los rótulos caben en las zonas seguras 9:16", () => {
  const beats = showcaseBeats.map((b, i) => ({ ...b, narration: i === 0 ? "In the spring of 1995 the old district was quiet. This is the subject of our test story." : "Weeks later the gazette printed the story on its front page. Its headline put the event in plain words for every reader. The report traced a single route from one point to another." }));
  const resolved = resolveSequences(showcaseSequences, PLAN_ESTIMATE_AVAILABILITY);
  const { shots, narrationSeconds } = planSequenceShots(beats, resolved);
  assert.ok(narrationSeconds <= 30 && narrationSeconds >= 12, `${narrationSeconds}`);
  assert.equal(shots.length, 5);
  for (const s of shots) assert.equal(tierSeconds(s.startSec, s.endSec).HERO, s.endSec - s.startSec, "todo es HERO");
  const coverage = heroCoverage(shots, showcaseRegistry(BASE), MAX_TEXT_FALLBACK_RATIO);
  assert.deepEqual(coverage.blockers, []);
  const W = 1080;
  const H = 1920;
  const safe = safeAreas(W, H);
  const box = wideFieldBox(W, H);
  const t = typeScale(W, H);
  assert.ok(box.y >= safe.top + t.label * 2 && box.y + box.h <= H - safe.bottom, "la imagen del plano general queda entre rótulos y subtítulos");
  assert.ok(box.x >= safe.side && box.x + box.w <= W - safe.side);
});
