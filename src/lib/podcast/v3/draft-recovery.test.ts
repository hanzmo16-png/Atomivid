/**
 * QA P1-2 (#272): «Empezar de nuevo» y la entrada «Personalizado» (#269) comparten la clave de recuperación con el
 * MISMO formato { v: 1, items: [{ raw, at, step }], legacy? }. Ninguno pisa la lista del otro; nada se borra.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DRAFT_RECOVERY_KEY, draftOwner, hasParked, hasWork, parkDraft, parseRecovery, takeParked, type DraftStore } from "./draft-recovery";

const mem = (init: Record<string, string> = {}): DraftStore & { m: Map<string, string> } => {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};
const draft = (topic: string, extra: Record<string, unknown> = {}) => JSON.stringify({ step: 4, topic, script: "", participants: [{}, {}], ...extra });

test("formato de #269: aparcar añade al principio de items y conserva lo que #269 ya había aparcado", () => {
  const fromHome = { v: 1, items: [{ raw: draft("de la portada"), at: "2026-11-01T10:00:00Z", step: 0 }] };
  const s = mem({ [DRAFT_RECOVERY_KEY]: JSON.stringify(fromHome) });
  assert.equal(parkDraft(s, draft("Base Dulce", { scriptJob: { segments: [] } }), "2026-11-01T18:00:00Z"), true);
  const out = JSON.parse(s.m.get(DRAFT_RECOVERY_KEY)!);
  assert.equal(out.v, 1); assert.equal(out.items.length, 2);
  assert.equal(JSON.parse(out.items[0].raw).topic, "Base Dulce"); assert.equal(out.items[0].step, 4);
  assert.equal(JSON.parse(out.items[1].raw).topic, "de la portada", "lo de #269 no se pisa");
});

test("recuperar devuelve el más reciente y aparca el actual en su lugar (como restorePreviousDraft de #269)", () => {
  const s = mem();
  parkDraft(s, draft("A"), "t1"); parkDraft(s, draft("B"), "t2");
  const raw = takeParked(s, draft("actual"), "t3");
  assert.equal(JSON.parse(raw!).topic, "B");
  const items = parseRecovery(s.m.get(DRAFT_RECOVERY_KEY)!).items.map((x) => JSON.parse(x.raw).topic);
  assert.deepEqual(items, ["actual", "A"]);
});

test("CORRECCION-2: un borrador CRUDO (16ab4473) se recupera con su scriptJob; lo ilegible queda en legacy", () => {
  const raw = draft("viejo crudo", { scriptJob: { jobId: "0f0e0d0c-0b0a-4908-8706-050403020100" } });
  const s = mem({ [DRAFT_RECOVERY_KEY]: raw });
  assert.deepEqual(parseRecovery(raw).items.map((x) => x.raw), [raw]);
  assert.equal(hasParked(s), true);
  assert.equal(parkDraft(s, draft("C")), true);
  const out = JSON.parse(s.m.get(DRAFT_RECOVERY_KEY)!);
  assert.equal(out.v, 1); assert.equal(out.legacy, undefined);
  assert.deepEqual(out.items.map((x: { raw: string }) => JSON.parse(x.raw).topic), ["C", "viejo crudo"], "ya es un sobre que #269 lista");
  assert.equal(JSON.parse(takeParked(s, null)!).topic, "C");
  const back = JSON.parse(takeParked(s, null)!);
  assert.equal(back.topic, "viejo crudo"); assert.equal(back.scriptJob.jobId, "0f0e0d0c-0b0a-4908-8706-050403020100", "mismo ancla");
  const junk = mem({ [DRAFT_RECOVERY_KEY]: "{roto" });
  assert.equal(hasParked(junk), false);
  assert.equal(parkDraft(junk, draft("D")), true);
  assert.equal(JSON.parse(junk.m.get(DRAFT_RECOVERY_KEY)!).legacy, "{roto", "lo que no es un borrador se conserva intacto");
  const other = mem({ [DRAFT_RECOVERY_KEY]: JSON.stringify({ foo: 1 }) });
  assert.equal(hasParked(other), false);
});

test("sin tope (como #269): 12 reinicios seguidos conservan los 12 borradores; recuperar uno no pierde los demás", () => {
  const s = mem();
  for (let i = 1; i <= 12; i++) assert.equal(parkDraft(s, draft(`T${i}`), `t${i}`), true);
  assert.equal(parseRecovery(s.m.get(DRAFT_RECOVERY_KEY)!).items.length, 12);
  assert.equal(JSON.parse(takeParked(s, null)!).topic, "T12");
  const left = parseRecovery(s.m.get(DRAFT_RECOVERY_KEY)!).items.map((x) => JSON.parse(x.raw).topic);
  assert.equal(left.length, 11); assert.equal(left[0], "T11"); assert.equal(left.at(-1), "T1");
});

test("un borrador vacío no se aparca; el mismo borrador no se duplica en cabeza", () => {
  const s = mem();
  assert.equal(parkDraft(s, JSON.stringify({ step: 0, topic: "", script: "" })), false);
  assert.equal(s.m.has(DRAFT_RECOVERY_KEY), false);
  parkDraft(s, draft("X")); parkDraft(s, draft("X"));
  assert.equal(parseRecovery(s.m.get(DRAFT_RECOVERY_KEY)!).items.length, 1);
  assert.equal(hasWork(draft("", { scriptJob: { segments: [] } })), true);
});

test("aislamiento por cuenta: en el mismo navegador, cada cuenta solo ve y recupera sus borradores; nada se borra", () => {
  const s = mem();
  const a = draft("de A", { ownerId: "owner-a", scriptJob: { jobId: "job-a" } }), b = draft("de B", { ownerId: "owner-b" }), old = draft("sin dueño");
  parkDraft(s, old, "1"); parkDraft(s, a, "2"); parkDraft(s, b, "3");
  assert.equal(hasParked(s, "owner-c"), true, "el anterior al aislamiento (sin dueño) sigue siendo recuperable");
  assert.equal(JSON.parse(takeParked(s, null, "4", "owner-a")!).topic, "de A");
  assert.equal(takeParked(s, null, "5", "owner-a") && "ok", "ok", "después, el sin dueño");
  assert.equal(takeParked(s, null, "6", "owner-a"), null, "nunca el de B");
  assert.equal(hasParked(s, "owner-b"), true);
  assert.equal(JSON.parse(takeParked(s, null, "7", "owner-b")!).topic, "de B");
  assert.equal(draftOwner(a), "owner-a"); assert.equal(draftOwner(old), null); assert.equal(draftOwner("{roto"), null);
});

test("orden de integración indiferente: un crudo que #269 (sin el parser único) dejó en legacy también se recupera", () => {
  const raw = draft("crudo en legacy", { scriptJob: { jobId: "j-l" } });
  const s = mem({ [DRAFT_RECOVERY_KEY]: JSON.stringify({ v: 1, items: [{ raw: draft("de la portada"), at: "a", step: 0 }], legacy: raw }) });
  assert.deepEqual(parseRecovery(s.m.get(DRAFT_RECOVERY_KEY)!).items.map((x) => JSON.parse(x.raw).topic), ["de la portada", "crudo en legacy"]);
  parkDraft(s, draft("nuevo"), "b");
  const out = JSON.parse(s.m.get(DRAFT_RECOVERY_KEY)!);
  assert.equal(out.legacy, undefined); assert.equal(out.items.length, 3);
  const keep = mem({ [DRAFT_RECOVERY_KEY]: JSON.stringify({ v: 1, items: [], legacy: "{roto" }) });
  assert.equal(parseRecovery(keep.m.get(DRAFT_RECOVERY_KEY)!).legacy, "{roto", "lo que no es borrador sigue en legacy");
});

test("sin duplicados: aparcar el mismo borrador lo mueve al principio; recuperar y volver no multiplica la lista", () => {
  const s = mem();
  parkDraft(s, draft("X"), "1"); parkDraft(s, draft("Y"), "2"); parkDraft(s, draft("X"), "3");
  assert.deepEqual(parseRecovery(s.m.get(DRAFT_RECOVERY_KEY)!).items.map((x) => JSON.parse(x.raw).topic), ["X", "Y"]);
  const got = takeParked(s, draft("Y"), "4");
  assert.equal(JSON.parse(got!).topic, "X");
  assert.deepEqual(parseRecovery(s.m.get(DRAFT_RECOVERY_KEY)!).items.map((x) => JSON.parse(x.raw).topic), ["Y"], "el actual Y no queda dos veces");
});

// ---- Contrato con el módulo REAL de #269 (src/lib/podcast/v3/wizard.ts: applyFreshHomeEntry, restorePreviousDraft) ----
// Se ejecuta contra el código real, sin copias. Mientras #269 no esté integrado en esta rama, wizard.ts no exporta esas
// funciones y la prueba se marca como omitida (con el motivo); al integrarse, corre sola. Evidencia de su ejecución con
// #269 @ 7583bbc7 fusionado: ver la descripción del PR #272.
test("contrato real #269 ↔ #272 en el MISMO almacén (portada, reinicios, crudo, >10, legado)", async (t) => {
  const w = (await import("./wizard")) as Record<string, unknown>;
  const fresh = w.applyFreshHomeEntry as undefined | ((st: DraftStore, p: Record<string, unknown>, o?: { now?: string }) => { started: boolean });
  const restore = w.restorePreviousDraft as undefined | ((st: DraftStore, o?: { now?: string; index?: number }) => { restored: boolean });
  const list = w.recoveryList as undefined | ((raw: string | null) => { raw: string }[]);
  const activeKey = String(w.WIZARD_STORAGE_KEY ?? "atomivid.podcast.asistente.v2");
  if (!fresh || !restore || !list) { t.skip("pendiente de integrar #269 (wizard.ts sin applyFreshHomeEntry/restorePreviousDraft)"); return; }
  const raw = draft("crudo 16ab4473", { scriptJob: { jobId: "j-crudo" } });
  const s = mem({ [DRAFT_RECOVERY_KEY]: raw, [activeKey]: draft("activo A", { scriptJob: { jobId: "j-a" } }) });
  // El crudo, leído por el parser ÚNICO, es un ítem para ambos.
  assert.deepEqual(list(s.m.get(DRAFT_RECOVERY_KEY)!).map((x) => JSON.parse(x.raw).topic), ["crudo 16ab4473"]);
  // Entrada «Personalizado» desde la portada (#269): aparca el activo A.
  const r = fresh(s, { modo: "personalizado", entrada: "nueva-1", idea: "idea nueva" }, { now: "a" });
  assert.equal(r.started, true);
  // «Empezar de nuevo» (#272) dos veces y doce aparcados más: sin tope.
  parkDraft(s, draft("reinicio 1"), "b"); parkDraft(s, draft("reinicio 2"), "c");
  for (let i = 0; i < 12; i++) parkDraft(s, draft(`extra ${i}`), `x${i}`);
  const all = list(s.m.get(DRAFT_RECOVERY_KEY)!).map((x) => JSON.parse(x.raw).topic);
  assert.ok(all.length >= 16, String(all.length)); assert.ok(all.includes("activo A") && all.includes("crudo 16ab4473"));
  assert.deepEqual(parseRecovery(s.m.get(DRAFT_RECOVERY_KEY)!).items, list(s.m.get(DRAFT_RECOVERY_KEY)!).map((x) => ({ ...x })) as never);
  // #269 recupera por índice el activo A con su scriptJob; #272 recupera el siguiente; ninguno pierde nada.
  const idx = all.indexOf("activo A");
  assert.equal(restore(s, { now: "r", index: idx }).restored, true);
  assert.equal(JSON.parse(s.m.get(activeKey)!).scriptJob.jobId, "j-a");
  assert.ok(takeParked(s, s.m.get(activeKey)!, "t"));
  const after = list(s.m.get(DRAFT_RECOVERY_KEY)!).map((x) => JSON.parse(x.raw).topic);
  assert.ok(after.includes("activo A") && after.includes("crudo 16ab4473") && after.length === all.length, JSON.stringify(after));
  // Legado ilegible: intacto para los dos.
  const junk = mem({ [DRAFT_RECOVERY_KEY]: "{roto", [activeKey]: draft("act") });
  fresh(junk, { modo: "personalizado", entrada: "nueva-2", idea: "x" }, { now: "a" }); parkDraft(junk, draft("y"));
  assert.equal(JSON.parse(junk.m.get(DRAFT_RECOVERY_KEY)!).legacy, "{roto");
});
