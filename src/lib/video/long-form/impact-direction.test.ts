import { test } from "node:test";
import assert from "node:assert/strict";
import { containRect, detailLayout, revealLayout, validateDirection, wideFieldBox } from "../../../../remotion/long-form-direction";
import type { LongFormShotScene } from "../../../../remotion/LongFormDoc";
import { EXECUTABLE_PLAN_VERSIONS } from "./production-plan-types";
import { tierSeconds } from "./cinematic-director";
import { heroCoverage } from "./verified-assets";
import { MAX_TEXT_FALLBACK_RATIO } from "./produce";
import { PLAN_ESTIMATE_AVAILABILITY, registryAvailability, resolveSequences, validateImpactIntents, type SequenceIntent } from "./sequence-intent";
import { planSequenceShots } from "./sequence-direction";
import { directImpactScenes, futureAtmosphereRequests, hookStatus, plannedHookStatus } from "./impact-direction";
import { splitSentences } from "./visual-intents";
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
  gucciSequencesV6,
  gucciVerifiedAssets,
  planFor,
  poolProvider,
  produceOffline,
  rehydrateFixture,
  truthfulPool,
} from "./cinematic-simulation";
import { SHOWCASE_TOPIC, showcaseBeats, showcaseFootageProvider, showcaseRegistry, showcaseSequences, showcaseSequencesV6 } from "./showcase-fixtures";

/**
 * Cinematic Opening V6 (plan v6, OFFLINE): el impacto decide dónde cae el peso
 * DENTRO de la secuencia; la verdad decide antes. Rol ≠ impacto. Sin cuotas.
 */

let networkCalls = 0;
globalThis.fetch = (async () => {
  networkCalls++;
  throw new Error("v6: red prohibida");
}) as typeof fetch;

const BASE = "http://127.0.0.1:0";
const adversarial = () => poolProvider([...gucciAdversarial, ...truthfulPool(gucciBeats, GUCCI_TOPIC)]).provider;
const strip = (seqs: SequenceIntent[]) => seqs.map((s) => ({ ...s, slots: s.slots.map(({ impact, impactReason, futureAtmosphere, ...rest }) => (void impact, void impactReason, void futureAtmosphere, rest)) }));

async function showcase(sequences?: SequenceIntent[]) {
  let input: { scenes: LongFormShotScene[]; captions: { text: string }[] } | null = null;
  const run = await produceOffline(showcaseBeats, planFor(showcaseBeats, "economical", sequences, SHOWCASE_TOPIC), {
    topic: SHOWCASE_TOPIC,
    verifiedAssets: showcaseRegistry(BASE),
    footageProvider: showcaseFootageProvider(BASE, async (u) => Buffer.from(`bytes:${u}`)),
    onRender: (i) => (input = i as never),
  });
  assert.equal(run.error, null, String(run.error));
  return input!;
}

test("versión: v6 solo si la intención declara impacto; v5 sigue siendo v5; el worker ejecuta v6 (con cuenta habilitada)", () => {
  assert.equal(planFor(showcaseBeats, "economical", showcaseSequencesV6, SHOWCASE_TOPIC).version, 6);
  assert.equal(planFor(showcaseBeats, "economical", showcaseSequences, SHOWCASE_TOPIC).version, 5);
  assert.equal(planFor(gucciBeats).version, 4);
  assert.deepEqual([...EXECUTABLE_PLAN_VERSIONS], [1, 2, 3, 4, 6], "el worker ejecuta v6; la cuenta se comprueba en run-job (cinematic-v6-production.test.ts)");
  // Un plan v6 a medias (un slot sin impacto o sin razón) no existe.
  const partial = JSON.parse(JSON.stringify(showcaseSequencesV6)) as SequenceIntent[];
  delete partial[1].slots[2].impact;
  assert.ok(validateImpactIntents(partial).some((e) => /impacto v6 ausente/.test(e)));
  assert.throws(() => planFor(showcaseBeats, "economical", partial, SHOWCASE_TOPIC), /secuencias inválidas/);
  const noReason = JSON.parse(JSON.stringify(showcaseSequencesV6)) as SequenceIntent[];
  noReason[0].slots[0].impactReason = "";
  assert.ok(validateImpactIntents(noReason).some((e) => /razón narrativa/.test(e)));
});

test("rol ≠ impacto, y el impacto NUNCA cambia si un rol se ocupa (la verdad decide antes)", () => {
  for (const availability of [PLAN_ESTIMATE_AVAILABILITY, registryAvailability(undefined), registryAvailability(gucciRegistry())]) {
    const v6 = resolveSequences(gucciSequencesV6(), availability);
    const v5 = resolveSequences(strip(gucciSequencesV6()), availability);
    assert.deepEqual(v6.map((s) => s.slots.map((x) => [x.role, x.status, x.visual])), v5.map((s) => s.slots.map((x) => [x.role, x.status, x.visual])));
  }
  // El mismo rol con impactos distintos: EVIDENCE 1 (inspección) y EVIDENCE 3 (revelación); ANCHOR 3 (gancho) y ANCHOR 1.
  const slots = gucciSequencesV6().flatMap((s) => s.slots);
  for (const role of ["EVIDENCE", "ANCHOR"] as const) assert.deepEqual([...new Set(slots.filter((x) => x.role === role).map((x) => x.impact))].sort(), [1, 3], role);
  // Sin rotación forzada: dos 3 seguidos en la apertura del SHOWCASE.
  assert.deepEqual(showcaseSequencesV6[0].slots.map((s) => s.impact), [3, 3]);
});

test("el impacto no cambia cámara, color ni número de planos: solo encuadre, jerarquía tipográfica y revelación", async () => {
  const v5 = await showcase(showcaseSequences);
  const v6 = await showcase(showcaseSequencesV6);
  assert.equal(v6.scenes.length, v5.scenes.length);
  assert.deepEqual(v6.scenes.map((s) => s.direction?.camera), v5.scenes.map((s) => s.direction?.camera));
  assert.deepEqual(v6.scenes.map((s) => s.direction?.look), v5.scenes.map((s) => s.direction?.look));
  assert.deepEqual(v6.scenes.map((s) => s.direction?.transition?.type), v5.scenes.map((s) => s.direction?.transition?.type));
  assert.deepEqual(v6.scenes.map((s) => [s.direction?.shot?.role, s.direction?.shot?.scale]), v5.scenes.map((s) => [s.direction?.shot?.role, s.direction?.shot?.scale]));
  const [place, anchor, page, headline] = v6.scenes;
  assert.equal(place.direction?.shot?.wide, "bleed", "declaración de apertura a sangre");
  assert.deepEqual(place.direction?.shot?.statement, { year: "1995", place: "Fixture district" });
  assert.equal(anchor.direction?.shot?.name, "Fixture Person", "nombre del vínculo VERIFICADO");
  assert.equal(page.direction?.shot?.wide, "field");
  assert.equal(headline.direction?.shot?.reveal, true);
  assert.equal(v5.scenes[0].direction?.shot?.wide, "field", "v5 intacto");
  assert.ok(v5.scenes.every((s) => !s.direction?.shot?.impact && !s.direction?.shot?.reveal && !s.direction?.shot?.name), "v5 no lleva nada de v6");
  assert.doesNotThrow(() => validateDirection(v6.scenes, undefined, 60));
  assert.deepEqual(hookStatus(v6.scenes).status, "HOOK_FILLED");
  // Misma narración: mismas palabras en el mismo orden.
  const words = (c: { text: string }[]) => c.map((x) => x.text).join(" ").split(/\s+/);
  assert.deepEqual(words(v6.captions), words(v5.captions));
  assert.ok(Math.abs(v6.scenes.at(-1)!.endSeconds - v5.scenes.at(-1)!.endSeconds) < 1e-6, "misma duración");
});

test("ritmo: el corte del protagonista cae en la palabra que lo nombra, no en una frontera de oración", async () => {
  const v6 = await showcase(showcaseSequencesV6);
  const anchor = v6.scenes[1];
  const firstCaption = v6.captions.find((c) => (c as unknown as { startSeconds: number }).startSeconds >= anchor.startSeconds - 1e-6)!;
  assert.match(firstCaption.text, /^the subject/, firstCaption.text);
  const sentenceStarts = splitSentences(showcaseBeats[0].narration).map((s) => s.split(/\s+/)[0]);
  assert.ok(!sentenceStarts.includes("the"), "ninguna oración empieza ahí");
});

test("nombre SOLO del vínculo verificado: sin entityLink del servidor no hay nombre, aunque el planner lo escriba", () => {
  const scene = { id: "a", startSeconds: 0, endSeconds: 5, motion: "static" as const, provenance: "archival_documentary" as const, asset: { kind: "media" as const, mediaType: "image" as const, url: "u" }, direction: { camera: "push" as const, shot: { role: "ANCHOR" as const, scale: "MEDIUM" as const } } };
  const slot = { sequenceSlot: { sequenceId: "S", sequenceIndex: 0, index: 0, role: "ANCHOR" as const, scale: "MEDIUM" as const, scaleReason: "x", status: "FILL" as const, opensSequence: true, impact: 3 as const } };
  const [noLink] = directImpactScenes([scene], [slot], [{ assetMeta: { provenance: { kind: "archival_documentary", provider: "x" } } as never }]);
  assert.equal(noLink.direction?.shot?.name, undefined);
  const [stock] = directImpactScenes([{ ...scene, provenance: "stock_illustrative" as never }], [slot], [{ assetMeta: { provenance: { kind: "stock_illustrative", provider: "x" }, selection: { entityLink: { name: "Fake" } } } as never }]);
  assert.equal(stock.direction?.shot?.name, undefined);
  assert.throws(() => validateDirection([{ ...scene, provenance: "stock_illustrative", direction: { ...scene.direction, shot: { ...scene.direction.shot, name: "X" } } }], undefined, 5), /verified archival anchor/);
});

test("revelación del documento: empieza EXACTAMENTE en la página del plano general (corte invisible) y termina con el titular dominante, sin ampliar y con la página a la vista", () => {
  const region = { x: 0.06, y: 0.15, w: 0.88, h: 0.14 };
  for (const [W, H] of [[1920, 1080], [1080, 1920]]) {
    const start = revealLayout(region, 1800, 2400, W, H, 0);
    const field = containRect(wideFieldBox(W, H), 1800, 2400);
    for (const k of ["x", "y", "w", "h"] as const) assert.ok(Math.abs(start.page[k] - field[k]) < 1e-6, `${k} ${W}x${H}`);
    assert.equal(start.dim, 0);
    const end = revealLayout(region, 1800, 2400, W, H, 1);
    const detail = detailLayout(region, 1800, 2400, W, H, 1);
    assert.ok(Math.abs(end.page.w - detail.page.w) < 1e-6);
    assert.ok(end.focus.w >= 0.75 * W, "el titular domina");
    assert.ok(end.page.w / 1800 <= 1 + 1e-9, "nunca más de 1 px de fuente por px");
    assert.ok(end.page.x > 0 && end.page.x + end.page.w < W, "bordes de la página visibles");
    // Movimiento monótono (sin rebotes) y sostenido al final.
    let last = 0;
    for (let i = 0; i <= 20; i++) {
      const w = revealLayout(region, 1800, 2400, W, H, i / 20).page.w;
      assert.ok(w >= last - 1e-9);
      last = w;
    }
    assert.deepEqual(revealLayout(region, 1800, 2400, W, H, 0.7).page, end.page);
  }
});

test("HONEST-GUCCI v6: el gancho sin ancla queda HOOK_UNFILLED (nunca metraje genérico) y A/C siguen bloqueando antes de gastar", async () => {
  const a = resolveSequences(gucciSequencesV6(), registryAvailability(undefined));
  const plannedA = planSequenceShots(gucciBeats, a).shots;
  assert.equal(plannedHookStatus(a, plannedA).status, "HOOK_UNFILLED");
  const b = resolveSequences(gucciSequencesV6(), registryAvailability(gucciRegistry()));
  assert.equal(plannedHookStatus(b, planSequenceShots(gucciBeats, b).shots).status, "HOOK_FILLED");
  const runA = await produceOffline(gucciBeats, planFor(gucciBeats, "economical", gucciSequencesV6()), { footageProvider: adversarial() });
  assert.match(String(runA.error), /HERO_EVIDENCE_COVERAGE_MISSING/);
  assert.deepEqual(runA.events, []);
  const c = rehydrateFixture(curateFixture([{ asset: gucciVerifiedAssets[0].asset, key: MAURIZIO_KEY }], gucciRequested()));
  const runC = await produceOffline(gucciBeats, planFor(gucciBeats, "economical", gucciSequencesV6()), { verifiedAssets: c, footageProvider: adversarial() });
  assert.match(String(runC.error), /HERO_EVIDENCE_COVERAGE_MISSING/);
  assert.deepEqual(runC.events, []);
});

test("HONEST-GUCCI v6 B: pies, botones, ejecutivo, periódico equivocado y persona generada AUSENTES; el impacto no rescata a ninguno", async () => {
  let report: { scenes: { candidateDescription?: string }[] } | null = null;
  let input: { scenes: LongFormShotScene[] } | null = null;
  const run = await produceOffline(gucciBeats, planFor(gucciBeats, "economical", gucciSequencesV6()), { verifiedAssets: gucciRegistry(), footageProvider: adversarial(), onReport: (r) => (report = r as never), onRender: (i) => (input = i as never) });
  assert.equal(run.error, null, String(run.error));
  for (const adv of [FEET, BELLBOY, BUSINESSMAN, WRONG_NEWSPAPER]) assert.ok(!report!.scenes.some((s) => s.candidateDescription === adv.description), adv.id);
  assert.ok(!run.events.includes("image"), "ninguna persona generada");
  assert.equal(hookStatus(input!.scenes).status, "HOOK_FILLED");
  // Impacto 3 en una prueba que falta sigue siendo una ausencia (tarjeta), no un sustituto.
  assert.ok(input!.scenes.filter((s) => s.asset.kind === "graphic").every((s) => !!s.direction?.shot?.card));
  assert.equal(gucciSequences().length, gucciSequencesV6().length);
  assert.equal(networkCalls, 0);
});

test("política generativa FUTURA (solo diseño): ambiente sí, personas/crimen/tribunal/documentos/archivo no; cero llamadas", () => {
  const shots = [
    { id: "c1", sequenceSlot: { sequenceId: "S", index: 0, role: "CONTEXT" } as never, anchoredVisual: { description: "street", motion: false } },
    { id: "c2", sequenceSlot: { sequenceId: "S", index: 1, role: "CONTEXT" } as never, anchoredVisual: { description: "x", motion: false } },
    { id: "a1", sequenceSlot: { sequenceId: "S", index: 2, role: "ANCHOR" } as never, anchoredVisual: { description: "x", motion: false, identity: { name: "Maurizio Gucci", kind: "person" as const } } },
  ];
  const requests = futureAtmosphereRequests(shots, new Map([["S#0", "empty rain-soaked street at dawn, no people"], ["S#1", "victim lying in the stairwell after the shooting"], ["S#2", "Maurizio walking into the office"]]));
  assert.equal(requests[0].verdict, "FORBIDDEN", "'people' aparece aunque sea para negarlo: falla cerrada");
  const ok = futureAtmosphereRequests([shots[0]], new Map([["S#0", "empty rain-soaked street at dawn"]]));
  assert.equal(ok[0].verdict, "ADVISORY_ALLOWED");
  assert.equal(ok[0].provenanceRequired, "ai_recreation");
  assert.ok(requests[1].reasons.includes("CRIME_REENACTMENT"));
  assert.ok(requests[2].reasons.includes("PROTECTED_CONTRACT") && requests[2].reasons.includes("ROLE_NOT_ATMOSPHERIC"));
  for (const t of ["court ruling documents", "newspaper headline", "archival newsreel of the trial"]) assert.equal(futureAtmosphereRequests([shots[0]], new Map([["S#0", t]]))[0].verdict, "FORBIDDEN", t);
  assert.equal(networkCalls, 0);
});

test("30 s en vertical con impacto: mismo contrato, roles, impacto y resolver; todo el corto es HERO", () => {
  const beats = showcaseBeats.map((b, i) => ({
    ...b,
    narration: i === 0 ? "In the spring of 1995 the old district was quiet. This is the subject of our test story." : "Weeks later the gazette printed the story on its front page. Its headline put the event in plain words for every reader. The report traced a single route from one point to another.",
  }));
  const resolved = resolveSequences(showcaseSequencesV6, registryAvailability(showcaseRegistry(BASE)));
  const { shots, narrationSeconds } = planSequenceShots(beats, resolved);
  assert.ok(narrationSeconds <= 30);
  assert.deepEqual(shots.map((s) => s.sequenceSlot?.impact), [3, 3, 1, 3, 2]);
  for (const s of shots) assert.equal(tierSeconds(s.startSec, s.endSec).HERO, s.endSec - s.startSec);
  assert.deepEqual(heroCoverage(shots, showcaseRegistry(BASE), MAX_TEXT_FALLBACK_RATIO).blockers, []);
  assert.equal(plannedHookStatus(resolved, shots).status, "HOOK_FILLED");
});
