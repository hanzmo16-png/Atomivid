import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  committedUsd,
  paidPlan,
  PaidBudgetError,
  releasePaid,
  reservePaid,
  settlePaid,
  validateSampleManifest,
  type PaidLedger,
  type SampleManifest,
  type SampleScene,
  type VeoClipSource,
} from "./sample-manifest";

const words = [
  { text: "Imagina", startSeconds: 0, endSeconds: 0.4 },
  { text: "cavar,", startSeconds: 0.45, endSeconds: 0.9 },
  { text: "rodeado", startSeconds: 1.3, endSeconds: 1.8 },
  { text: "de", startSeconds: 1.85, endSeconds: 1.95 },
  { text: "mosquitos.", startSeconds: 2.0, endSeconds: 2.6 },
];

const veo = (extra: Partial<VeoClipSource> = {}): VeoClipSource => ({
  kind: "veo-clip",
  key: "k1",
  reference: { kind: "commons", title: "File:A.jpg" },
  prompt: "animate",
  placeholder: { source: { kind: "commons", title: "File:A.jpg" }, provenance: "archival_documentary" },
  ...extra,
});
const scene = (id: string, start: number, end: number, narration: string, extra: Partial<SampleScene> = {}): SampleScene => ({
  id, startSeconds: start, endSeconds: end, narration,
  source: { kind: "pexels-photo", id: Number(id.replace(/\D/g, "")) || 1 },
  provenance: "stock_illustrative", direction: { transition: { type: "cut" } },
  review: { status: "approved", relevance: "directa", note: "" }, ...extra,
});
const base = (scenes: SampleScene[]): SampleManifest => ({ requestId: "r", beats: ["beat-1"], tailSeconds: 0.4, outputPrefix: "r/samples/x", scenes, soundCues: [], missingSound: [] });
const codes = (m: SampleManifest) => validateSampleManifest(m, words, 2.6).map((i) => i.code);

test("clip IA: siempre rotulado «Recreación IA», con prompt, sustituto no-IA y dentro de los 8 s del clip", () => {
  const ok = base([scene("s1", 0, 1.18, "Imagina cavar,", { source: veo(), provenance: "ai_recreation" }), scene("s2", 1.18, 3.0, "rodeado de mosquitos.")]);
  assert.deepEqual(codes(ok), []);

  const unlabeled = base([scene("s1", 0, 1.18, "Imagina cavar,", { source: veo(), provenance: "archival_documentary" }), scene("s2", 1.18, 3.0, "rodeado de mosquitos.")]);
  assert.ok(codes(unlabeled).includes("ai_unlabeled"));

  const aiPlaceholder = veo({ placeholder: { source: { kind: "existing", path: "x.png" }, provenance: "ai_recreation" } });
  assert.ok(codes(base([scene("s1", 0, 1.18, "Imagina cavar,", { source: aiPlaceholder, provenance: "ai_recreation" }), scene("s2", 1.18, 3.0, "rodeado de mosquitos.")])).includes("placeholder_ai"));

  const noPrompt = veo({ reference: { kind: "ai-still", prompt: " " } });
  assert.ok(codes(base([scene("s1", 0, 1.18, "Imagina cavar,", { source: noPrompt, provenance: "ai_recreation" }), scene("s2", 1.18, 3.0, "rodeado de mosquitos.")])).includes("ai_prompt"));

  const tooLong = base([
    scene("s1", 0, 1.18, "Imagina cavar,", { source: veo(), provenance: "ai_recreation", direction: { transition: { type: "cut" }, mediaStartSeconds: 7.5 } }),
    scene("s2", 1.18, 3.0, "rodeado de mosquitos."),
  ]);
  assert.ok(codes(tooLong).includes("clip_too_short"));
});

test("repetición deliberada: solo de la escena inmediatamente anterior y declarada; si no, duplicado", () => {
  const still = { kind: "commons" as const, title: "File:A.jpg" };
  const clipThenPhoto = [
    scene("s1", 0, 1.18, "Imagina cavar,", { source: veo(), provenance: "ai_recreation" }),
    scene("s2", 1.18, 3.0, "rodeado de mosquitos.", { source: still, provenance: "archival_documentary", repeatOf: "s1" }),
  ];
  assert.deepEqual(codes(base(clipThenPhoto)), []);

  const undeclared = clipThenPhoto.map((s) => ({ ...s, repeatOf: undefined }));
  assert.ok(codes(base(undeclared)).includes("duplicate"), "la foto que anima el clip cuenta como el mismo recurso");

  const notAdjacent = base([
    scene("s1", 0, 1.18, "Imagina cavar,", { source: veo(), provenance: "ai_recreation" }),
    scene("s2", 1.18, 3.0, "rodeado de mosquitos.", { source: still, provenance: "archival_documentary", repeatOf: "s0" }),
  ]);
  assert.ok(codes(notAdjacent).includes("repeat_not_adjacent"));
});

test("plan de gasto: solo las escenas que piden clip IA (selectivo); imagen IA solo si la referencia es IA", () => {
  const m = base([
    scene("s1", 0, 1.18, "Imagina cavar,", { source: veo({ key: "a", reference: { kind: "ai-still", prompt: "p" } }), provenance: "ai_recreation" }),
    scene("s2", 1.18, 3.0, "rodeado de mosquitos.", { source: veo({ key: "b" }), provenance: "ai_recreation" }),
    scene("s3", 3.0, 4.0, "x"),
  ]);
  const plan = paidPlan(m, { imageUsd: 0.06, veoClipUsd: 0.96 });
  assert.deepEqual(plan.map((i) => [i.key, i.provider, i.estimateUsd]), [["a:still", "openai-image", 0.06], ["a:veo", "veo", 0.96], ["b:veo", "veo", 0.96]]);
  assert.deepEqual(paidPlan(base([scene("s1", 0, 1, "x")]), { imageUsd: 0.06, veoClipUsd: 0.96 }), [], "sin clips IA declarados no hay gasto");
});

test("libro de gasto: reserva antes de llamar, nunca repite una clave, nunca excede el presupuesto aprobado", () => {
  const item = (key: string, usd: number) => ({ key, sceneId: "s1", provider: "veo" as const, estimateUsd: usd, prompt: "p" });
  let ledger: PaidLedger = { entries: [] };
  ledger = reservePaid(ledger, item("a:veo", 0.96), 2, "t0");
  assert.equal(committedUsd(ledger), 0.96, "lo reservado cuenta como comprometido");
  assert.throws(() => reservePaid(ledger, item("a:veo", 0.96), 10, "t1"), PaidBudgetError, "misma clave: nunca se reenvía");
  ledger = settlePaid(ledger, "a:veo", { status: "spent", actualUsd: 0.96, providerJobId: "op/1" }, "t2");
  ledger = reservePaid(ledger, item("b:veo", 0.96), 2, "t3");
  assert.throws(() => reservePaid(ledger, item("c:veo", 0.96), 2, "t4"), /excede el presupuesto aprobado/);
  ledger = settlePaid(ledger, "b:veo", { status: "failed", note: "timeout" }, "t5");
  assert.equal(committedUsd(ledger), 1.92, "un fallo tras enviar se cuenta por su estimación (pudo cobrarse)");
  assert.throws(() => settlePaid(ledger, "b:veo", { status: "spent" }, "t6"), PaidBudgetError, "no se liquida dos veces");
});

test("muestra M3 (Panamá): apertura en movimiento con clips IA solo donde se declaran; la muestra M2 sigue sin gasto", () => {
  const m3 = JSON.parse(fs.readFileSync("docs/quality/m3-panama-hook/sample-manifest.json", "utf8")) as SampleManifest;
  const m2 = JSON.parse(fs.readFileSync("docs/quality/m2-panama-opening/sample-manifest.json", "utf8")) as SampleManifest;
  const rates = { imageUsd: 0.06, veoClipUsd: 0.96 };
  assert.deepEqual(paidPlan(m2, rates), []);
  const plan = paidPlan(m3, rates);
  assert.deepEqual(plan.map((i) => i.sceneId), ["s01", "s01", "s04a"]);
  assert.equal(+plan.reduce((a, i) => a + i.estimateUsd, 0).toFixed(2), 1.98);
  // Los primeros ~11 s son movimiento real (clip IA / video de stock); luego entra la fotografía de archivo.
  const hook = m3.scenes.filter((s) => s.endSeconds <= 10.9 + 1e-6);
  assert.ok(hook.every((s) => s.source.kind === "veo-clip" || s.source.kind === "pexels-video"));
  assert.ok(hook.filter((s) => s.source.kind === "veo-clip").every((s) => s.provenance === "ai_recreation"));
  // Música y resto del montaje idénticos a M2 (lo que ya se aprobó).
  assert.deepEqual(m3.soundCues, m2.soundCues);
  assert.deepEqual(m3.scenes.slice(5), m2.scenes.slice(4));
  assert.notEqual(m3.outputPrefix, m2.outputPrefix);
});

test("libro de gasto: una reserva que nunca llegó al proveedor se libera; con id de operación, jamás", () => {
  const item = { key: "a:veo", sceneId: "s1", provider: "veo" as const, estimateUsd: 0.96, prompt: "p" };
  let ledger: PaidLedger = reservePaid({ entries: [] }, item, 4, "t0");
  ledger = settlePaid(ledger, "a:veo", { status: "failed", note: "VEO_API_KEY no está configurada" }, "t1");
  assert.equal(committedUsd(ledger), 0.96);
  ledger = releasePaid(ledger, "a:veo", "nunca se envió", "t2");
  assert.equal(committedUsd(ledger), 0, "lo liberado no cuenta");
  ledger = reservePaid(ledger, item, 4, "t3");
  assert.equal(committedUsd(ledger), 0.96, "la misma clave puede reservarse de nuevo tras liberarse");

  let submitted: PaidLedger = reservePaid({ entries: [] }, item, 4, "t0");
  submitted = settlePaid(submitted, "a:veo", { status: "failed", providerJobId: "op/1", note: "timeout" }, "t1");
  assert.throws(() => releasePaid(submitted, "a:veo", "x", "t2"), PaidBudgetError, "con id de operación pudo cobrarse");
  const spent = settlePaid(reservePaid({ entries: [] }, item, 4, "t0"), "a:veo", { status: "spent", actualUsd: 0.96 }, "t1");
  assert.throws(() => releasePaid(spent, "a:veo", "x", "t2"), PaidBudgetError);
});
