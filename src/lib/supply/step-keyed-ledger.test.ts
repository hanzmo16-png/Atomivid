/**
 * Guion largo de Podcast Studio (#272, CORRECCION-2 de Grok, defecto 3): el estado del trabajo viaja por el navegador.
 * Con la clave del libro derivada del PROMPT, un estado modificado (un turno editado, el contador de ampliaciones
 * rebobinado) abría una operación pagada NUEVA para un paso ya pagado. Con la clave por NOMBRE de paso, el libro es la
 * autoridad: cada paso de un trabajo se paga como mucho una vez. Libro y resultados en memoria; USD 0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { memoryResultStore } from "@/lib/paid-calls/result-store";
import { currentSupplyScope, guardScriptLedgerCall, withSupplyStepContext } from "./anthropic";

const PROJECT = "studio-script:11111111-2222-4333-8444-555555555555:0f0e0d0c-0b0a-4908-8706-050403020100";
const params = (content: string) => ({ model: "synthetic-model", max_tokens: 2000, messages: [{ role: "user", content }] });

function harness() {
  const store = memoryLedgerStore(), results = memoryResultStore();
  let calls = 0;
  const step = (name: string, content: string, invoke?: () => Promise<{ text: string }>, project = PROJECT) =>
    withSupplyStepContext(project, name, () => guardScriptLedgerCall<{ text: string }>({ store, results }, currentSupplyScope()!, params(content), 0.05, () => 0.01,
      () => { calls++; return invoke ? invoke() : Promise.resolve({ text: `respuesta ${calls} a «${content}»` }); }));
  const paid = () => [...store.ops.values()].filter((o) => o.status === "COMMITTED").length;
  return { store, step, calls: () => calls, paid };
}

test("defecto 3 reproducido y cerrado: el mismo paso con OTRO prompt (turno editado o ampliación rebobinada) no se paga dos veces", async () => {
  const h = harness();
  const first = await h.step("s2-a1-x1", "amplía estos turnos: A: hola. B: adiós.");
  const forged = await h.step("s2-a1-x1", "amplía estos turnos: A: hola EDITADO. B: adiós.");
  assert.equal(h.calls(), 1, "una sola llamada al proveedor");
  assert.equal(h.paid(), 1, "una sola operación en el libro");
  assert.deepEqual(forged.result, first.result, "se devuelve lo ya pagado para ese paso"); assert.equal(forged.costUsd, 0, "sin coste nuevo");
  assert.equal([...h.store.ops.values()][0]!.shotId, "script:s2-a1-x1:paso");
});

test("reenvío idéntico, recarga o reintento tras perder la respuesta: reutiliza el resultado pagado", async () => {
  const h = harness();
  const a = await h.step("plan-a1", "escaleta");
  const b = await h.step("plan-a1", "escaleta");
  assert.equal(h.calls(), 1); assert.deepEqual(a.result, b.result); assert.equal(b.costUsd, 0);
});

test("concurrencia: dos peticiones simultáneas del mismo paso con contenidos distintos → UNA llamada pagada", async () => {
  const h = harness();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slow = async () => { await gate; return { text: "lenta" }; };
  const p1 = h.step("s1-a1", "contenido A", slow);
  await new Promise((r) => setTimeout(r, 5));
  const p2 = h.step("s1-a1", "contenido B (manipulado)", slow).then((v) => ({ ok: v }), (e: unknown) => ({ err: e }));
  await new Promise((r) => setTimeout(r, 5));
  release();
  await p1; const r2 = await p2;
  assert.equal(h.calls(), 1, "el segundo no llega al proveedor");
  assert.ok("err" in r2 || ("ok" in r2 && r2.ok.result.text === "lenta"), "o queda bloqueado (en curso) o reutiliza el resultado");
  assert.equal(h.paid(), 1);
});

test("pasos distintos y trabajos (o dueños) distintos sí son operaciones distintas", async () => {
  const h = harness();
  await h.step("s0-a1", "x"); await h.step("s0-a2", "x"); await h.step("s0-a1-x1", "x");
  await h.step("s0-a1", "x", undefined, PROJECT.replace("11111111", "99999999"));
  assert.equal(h.calls(), 4); assert.equal(h.paid(), 4);
});

test("control: sin la clave por paso (clave derivada del prompt, como antes) el mismo paso modificado SÍ se pagaba dos veces", async () => {
  const store = memoryLedgerStore(), results = memoryResultStore();
  let calls = 0;
  const legacy = (content: string) => guardScriptLedgerCall<{ text: string }>({ store, results }, { projectId: PROJECT, intentId: "s2-a1-x1" }, params(content), 0.05, () => 0.01,
    async () => { calls++; return { text: "x" }; });
  await legacy("A"); await legacy("A editado");
  assert.equal(calls, 2, "este es el comportamiento que corrige la clave por paso");
});
