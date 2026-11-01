/**
 * QA P1-2 (#272): «Empezar de nuevo» y la entrada «Personalizado» (#269) comparten la clave de recuperación con el
 * MISMO formato { v: 1, items: [{ raw, at, step }], legacy? }. Ninguno pisa la lista del otro; nada se borra.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DRAFT_RECOVERY_KEY, hasParked, hasWork, parkDraft, parseRecovery, takeParked, type DraftStore } from "./draft-recovery";

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

test("formato anterior (borrador crudo en la clave) se lee como un elemento recuperable; una lista vacía no se ofrece", () => {
  const s = mem({ [DRAFT_RECOVERY_KEY]: draft("viejo crudo") });
  assert.equal(hasParked(s), true);
  assert.equal(JSON.parse(takeParked(s, null)!).topic, "viejo crudo");
  assert.equal(hasParked(s), false); assert.equal(s.m.has(DRAFT_RECOVERY_KEY), false);
  const legacyJunk = mem({ [DRAFT_RECOVERY_KEY]: "{roto" });
  assert.equal(hasParked(legacyJunk), false);
  assert.equal(parkDraft(legacyJunk, draft("C")), true);
  assert.equal(JSON.parse(legacyJunk.m.get(DRAFT_RECOVERY_KEY)!).legacy, "{roto", "lo ilegible se conserva como legacy, como #269");
});

test("un borrador vacío no se aparca; el mismo borrador no se duplica en cabeza", () => {
  const s = mem();
  assert.equal(parkDraft(s, JSON.stringify({ step: 0, topic: "", script: "" })), false);
  assert.equal(s.m.has(DRAFT_RECOVERY_KEY), false);
  parkDraft(s, draft("X")); parkDraft(s, draft("X"));
  assert.equal(parseRecovery(s.m.get(DRAFT_RECOVERY_KEY)!).items.length, 1);
  assert.equal(hasWork(draft("", { scriptJob: { segments: [] } })), true);
});
