/**
 * Reparación acotada de sections[].function (incidente Bigfoot 7b5c857f). Sin proveedor real:
 * el modelo es un adaptador simulado y el ledger es el gate real (guardPaidCall) con almacenes
 * en memoria, con la misma clave que supplyProtectedAnthropic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stableHash } from "@/lib/production-intelligence/canonical";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { memoryResultStore } from "@/lib/paid-calls/result-store";
import { guardPaidCall } from "@/lib/paid-calls/gate";
import { anthropicReservation } from "@/lib/supply/anthropic-cost";
import { getPricingConfig } from "@/lib/billing/pricing";
import { DocumentaryResponseError, parseDocumentaryResponse, readDocumentaryJson } from "./json-response";
import { LenientReferencedReviewSchema, narrationCatalog, resolveReviewReferences } from "./narration-catalog";
import { editorialBlockers, validateEditorialReview, EditorialReviewSchema } from "./editorial";
import {
  EditorialFunctionRepairError,
  FUNCTION_REPAIR_CONTRACT,
  FUNCTION_REPAIR_MAX_TOKENS,
  SECTION_FUNCTIONS,
  applyFunctionRepair,
  repairSectionFunctions,
  sectionFunctionRepairTargets,
} from "./editorial-function-repair";

const beats = [
  "In the autumn of 1967 two riders filmed a tall figure walking along a creek in northern California.",
  "The film was short and shaky, yet it showed a gait that experts argued about for decades afterwards.",
  "Years later a costume maker claimed he had sold a suit that matched the creature on that footage.",
  "No suit was ever produced, and the film itself held details that a costume of that era could not explain.",
  "So the footage proves less than believers hope, and more than sceptics admit, about what walked that day.",
].map((narration) => ({ narration }));
const catalog = narrationCatalog(beats);
const firstOf = (beat: number) => catalog.find((e) => e.beatIndex === beat)!.id;

/** La forma del incidente: catalog-v1, 5 secciones, sections[2].function fuera del contrato. */
function incidentReview(fn3 = "complication", extra: Record<string, unknown> = {}) {
  return {
    sections: ["setup", "new_information", fn3, "reversal", "resolution"].map((f, i) => ({ excerptId: firstOf(i), contribution: `section ${i} advances`, function: f })),
    firstAnswer: { delivered: true, evidence: { excerptId: firstOf(0) }, explanation: "the opening states the event" },
    ending: { resolvesPromise: true, evidence: { excerptId: firstOf(4) }, explanation: "the close answers the question" },
    findings: [],
    ...extra,
  };
}
const message = (value: unknown, stop = "end_turn") => ({ stop_reason: stop, content: [{ type: "text", text: JSON.stringify(value) }] });
const repairMessage = (replacements: unknown) => message({ replacements });

type Params = { model: string; max_tokens: number } & Record<string, unknown>;
function fakeModel(reply: (params: Params) => ReturnType<typeof message>) {
  const calls: Params[] = [];
  return { calls, send: async (params: Params) => (calls.push(params), reply(params)) };
}
async function runRepair(review: unknown, send: (p: Params) => Promise<ReturnType<typeof message>>) {
  const response = message(review);
  const value = readDocumentaryJson(response);
  const targets = sectionFunctionRepairTargets(value, LenientReferencedReviewSchema);
  if (!targets) return { targets, result: parseDocumentaryResponse(LenientReferencedReviewSchema, response) };
  return { targets, result: await repairSectionFunctions({ response, value, targets, schema: LenientReferencedReviewSchema, beats, model: "claude-sonnet-5", send }) };
}

test("el incidente entra en la reparación exactamente una vez y solo cambia la ruta autorizada", async () => {
  const original = incidentReview();
  const snapshot = structuredClone(original);
  const model = fakeModel(() => repairMessage([{ path: "sections/2/function", function: "reversal" }]));
  const { targets, result } = await runRepair(original, model.send);
  assert.deepEqual(targets, [2]);
  assert.equal(model.calls.length, 1, "una sola solicitud de reparación");
  const expected = structuredClone(snapshot);
  expected.sections[2].function = "reversal";
  assert.deepEqual(result, expected, "nada más cambia: narración, evidencia, explicaciones y juicios intactos");
  assert.deepEqual(original, snapshot, "la revisión original no se modifica (se repara una copia)");
  // La solicitud lleva el contexto de la sección, las seis definiciones y la revisión guardada.
  const prompt = JSON.parse(String((model.calls[0].messages as { content: string }[])[0].content));
  assert.equal(prompt.task, FUNCTION_REPAIR_CONTRACT);
  assert.deepEqual(prompt.categories.map((c: { name: string }) => c.name), [...SECTION_FUNCTIONS]);
  assert.deepEqual(prompt.targets.map((t: { path: string; rejectedLabel: string }) => [t.path, t.rejectedLabel]), [["sections/2/function", "complication"]]);
  assert.equal(prompt.targets[0].beatNarration, beats[2].narration);
  assert.ok(beats[2].narration.includes(prompt.targets[0].passage));
  assert.deepEqual(prompt.review, snapshot);
  assert.equal(model.calls[0].max_tokens, FUNCTION_REPAIR_MAX_TOKENS);
});

test("una categoría inválida, una ruta extra, ausente o repetida, o campos extra invalidan la reparación", async () => {
  const bad: unknown[] = [
    [{ path: "sections/2/function", function: "complication" }],
    [{ path: "sections/2/function", function: "consequence" }, { path: "sections/3/function", function: "setup" }],
    [{ path: "sections/1/function", function: "consequence" }],
    [{ path: "sections/2/function", function: "consequence" }, { path: "sections/2/function", function: "consequence" }],
    [{ path: "sections/2/function", function: "consequence", explanation: "rewritten" }],
    [{ path: "sections/2/severity", function: "consequence" }],
    [],
  ];
  for (const replacements of bad) {
    const model = fakeModel(() => repairMessage(replacements));
    await assert.rejects(runRepair(incidentReview(), model.send), EditorialFunctionRepairError, JSON.stringify(replacements));
    assert.equal(model.calls.length, 1, "nunca una segunda solicitud");
  }
  const truncated = fakeModel(() => message({ replacements: [] }, "max_tokens"));
  await assert.rejects(runRepair(incidentReview(), truncated.send), EditorialFunctionRepairError);
  // El error es claro, técnico (no editorial) y no expone valores.
  const e = new EditorialFunctionRepairError(["unexpected_path@sections/3/function"]);
  assert.ok(e instanceof DocumentaryResponseError);
  assert.match(e.message, /categoría fuera del contrato/);
});

test("los defectos ajenos a function NO activan la reparación: se conserva el rechazo original", async () => {
  const cases: unknown[] = [
    incidentReview("consequence", { findings: [{ kind: "invented_kind", severity: "blocking", evidence: [{ excerptId: firstOf(1) }], explanation: "x", repair: "x" }] }),
    incidentReview("complication", { findings: [{ kind: "invented_kind", severity: "blocking", evidence: [{ excerptId: firstOf(1) }], explanation: "x", repair: "x" }] }),
    { ...incidentReview(), firstAnswer: { delivered: true, evidence: { excerptId: firstOf(0) } } },
    { ...incidentReview(), sections: incidentReview().sections.slice(0, 4) },
    incidentReview(7 as unknown as string),
    { ...incidentReview(), sections: incidentReview().sections.map((s, i) => (i === 2 ? { ...s, contribution: "" } : s)) },
  ];
  for (const value of cases) {
    assert.equal(sectionFunctionRepairTargets(value, LenientReferencedReviewSchema), null);
    const model = fakeModel(() => assert.fail("no debe llamar al modelo"));
    await assert.rejects(runRepair(value, model.send), (err: unknown) => err instanceof DocumentaryResponseError && !(err instanceof EditorialFunctionRepairError));
    assert.equal(model.calls.length, 0);
  }
  // Una revisión válida no se toca.
  assert.equal(sectionFunctionRepairTargets(incidentReview("consequence"), LenientReferencedReviewSchema), null);
  // Un fallo de lectura (truncado o no-JSON) tampoco entra.
  assert.throws(() => readDocumentaryJson(message(incidentReview(), "max_tokens")), DocumentaryResponseError);
  // El contrato legacy usa la misma regla.
  assert.deepEqual(sectionFunctionRepairTargets({ ...incidentReview(), sections: incidentReview().sections.map((s, i) => ({ beatIndex: i, quote: "q", contribution: s.contribution, function: s.function })), firstAnswer: { delivered: true, evidence: { beatIndex: 0, quote: "q" }, explanation: "x" }, ending: { resolvesPromise: true, evidence: { beatIndex: 4, quote: "q" }, explanation: "x" } }, EditorialReviewSchema), [2]);
});

test("reparar el formato no aprueba: referencias, evidencia y bloqueos editoriales siguen aplicándose", async () => {
  const withBlocking = incidentReview("complication", { findings: [{ kind: "padding", severity: "blocking", evidence: [{ excerptId: firstOf(3) }], explanation: "the block pads", repair: "cut it" }] });
  const script = { storyPlan: {} as never, beats: beats.map((b) => ({ type: "x", purpose: "x", narration: b.narration, claims: [] })) };
  const run = async (fn: string) => {
    const { result } = await runRepair(withBlocking, fakeModel(() => repairMessage([{ path: "sections/2/function", function: fn }])).send);
    const resolved = resolveReviewReferences(result, beats);
    assert.ok(resolved.review);
    return editorialBlockers(validateEditorialReview(resolved.review, script));
  };
  assert.equal((await run("consequence")).length, 1, "el hallazgo bloqueante sobrevive a la reparación");
  assert.equal((await run("restatement")).length, 2, "si el modelo reclasifica como repetición, eso BLOQUEA (nunca aprueba)");
  // Una referencia inválida sigue fallando después de reparar.
  const badRef = incidentReview("complication", { ending: { resolvesPromise: true, evidence: { excerptId: "nope" }, explanation: "x" } });
  const { result } = await runRepair(badRef, fakeModel(() => repairMessage([{ path: "sections/2/function", function: "consequence" }])).send);
  assert.ok(resolveReviewReferences(result, beats).unresolved.includes("ending"));
});

/** El mismo gate que supplyProtectedAnthropic: clave = script:<intent>:stableHash(params), reserva, ledger, 0 reintentos. */
function ledgerSend(provider: (p: Params) => Promise<ReturnType<typeof message>>) {
  const store = memoryLedgerStore(), results = memoryResultStore();
  let invocations = 0;
  const send = async (params: Params) => {
    const spec = { projectId: "documentary:owner:bigfoot", shotId: `script:documentary:${stableHash(params, 16)}`, provider: "anthropic", model: params.model,
      method: "generate_script", inputFingerprint: params, reservedUsd: anthropicReservation(params, getPricingConfig()) };
    const paid = await guardPaidCall(store, spec, {
      async call({ key }) { invocations++; const result = await provider(params); const resultRef = `documentary:owner:bigfoot/paid/${key}/script.json`; await results.putJson(resultRef, result); return { result, costUsd: 0.001, resultRef }; },
      load: (ref) => results.getJson(ref), maxRejectedRetries: 0,
    });
    return paid.result;
  };
  return { send, store, invocations: () => invocations };
}

test("ledger: la reparación tiene clave determinista; repetir o reanudar la reutiliza sin un segundo cobro", async () => {
  const reply = () => repairMessage([{ path: "sections/2/function", function: "consequence" }]);
  const ledger = ledgerSend(async () => reply());
  const a = await runRepair(incidentReview(), ledger.send);
  const b = await runRepair(incidentReview(), ledger.send); // reanudar: misma respuesta original ⇒ misma solicitud
  assert.deepEqual(a.result, b.result);
  assert.equal(ledger.invocations(), 1);
  assert.equal(ledger.store.ops.size, 1);
  assert.equal([...ledger.store.ops.values()][0].status, "COMMITTED");
  // Otra respuesta original (otro texto) ⇒ otra clave: la reparación está ligada a ESA respuesta.
  const other = fakeModel(reply);
  await runRepair(incidentReview("complication", { ending: { resolvesPromise: true, evidence: { excerptId: firstOf(4) }, explanation: "another close" } }), other.send);
  const first = fakeModel(reply);
  await runRepair(incidentReview(), first.send);
  assert.notEqual(stableHash(other.calls[0], 16), stableHash(first.calls[0], 16));
  assert.match(String(first.calls[0].system), new RegExp(FUNCTION_REPAIR_CONTRACT));
});

test("ledger: dos ejecuciones concurrentes no generan dos operaciones pagadas", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const ledger = ledgerSend(async () => { await gate; return repairMessage([{ path: "sections/2/function", function: "consequence" }]); });
  const runs = Promise.allSettled([runRepair(incidentReview(), ledger.send), runRepair(incidentReview(), ledger.send)]);
  setTimeout(release, 5);
  const settled = await runs;
  assert.equal(ledger.invocations(), 1, "un solo envío al proveedor");
  assert.equal(ledger.store.ops.size, 1, "una sola operación en el ledger");
  // El gate existente falla cerrado ante la carrera: la operación queda para conciliar, nunca se cobra dos veces.
  // (En producción, además, el claim del job con run_token impide dos workers sobre el mismo trabajo.)
  assert.ok(settled.every((s) => s.status === "fulfilled" || /never resubmit/.test(String(s.reason))));
  const status = [...ledger.store.ops.values()][0].status;
  assert.ok(["COMMITTED", "RECONCILIATION_REQUIRED"].includes(status), status);
  const before = ledger.invocations();
  await runRepair(incidentReview(), ledger.send).catch(() => undefined); // reanudar tras la carrera
  assert.equal(ledger.invocations(), before, "reanudar nunca reenvía una operación incierta");
});

test("ledger: una reparación incierta (SUBMITTED sin resultado) bloquea; no se reenvía", async () => {
  const ledger = ledgerSend(async () => repairMessage([{ path: "sections/2/function", function: "consequence" }]));
  await runRepair(incidentReview(), ledger.send);
  const [key, op] = [...ledger.store.ops.entries()][0];
  ledger.store.ops.set(key, { ...op, status: "SUBMITTED", resultRef: null, committedUsd: null, providerJobId: null });
  await assert.rejects(runRepair(incidentReview(), ledger.send));
  assert.equal(ledger.invocations(), 1, "la operación incierta nunca se reenvía");
});

test("applyFunctionRepair trabaja sobre una copia profunda", () => {
  const original = incidentReview();
  const fixed = applyFunctionRepair(original, [2], { replacements: [{ path: "sections/2/function", function: "new_information" }] }) as typeof original;
  assert.equal(original.sections[2].function, "complication");
  assert.equal(fixed.sections[2].function, "new_information");
  assert.notEqual(fixed.sections, original.sections);
});
