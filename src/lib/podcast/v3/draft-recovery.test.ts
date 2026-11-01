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

test("un valor que no es la lista (borrador crudo de 16ab4473 o ilegible) queda en legacy, intacto, como en #269", () => {
  const raw = draft("viejo crudo");
  const s = mem({ [DRAFT_RECOVERY_KEY]: raw });
  assert.deepEqual(parseRecovery(raw), { items: [], legacy: raw }, "mismo resultado que parseRecovery de #269");
  assert.equal(hasParked(s), false);
  assert.equal(parkDraft(s, draft("C")), true);
  const out = JSON.parse(s.m.get(DRAFT_RECOVERY_KEY)!);
  assert.equal(out.legacy, raw, "no se pierde"); assert.equal(JSON.parse(out.items[0].raw).topic, "C");
  const junk = mem({ [DRAFT_RECOVERY_KEY]: "{roto" });
  assert.equal(parkDraft(junk, draft("D")), true);
  assert.equal(JSON.parse(junk.m.get(DRAFT_RECOVERY_KEY)!).legacy, "{roto");
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

// ---- Contrato cruzado con #269 (cursor/podcast-personalizado-nueva-aaa6 @ 7583bbc7, src/lib/podcast/v3/wizard.ts) ----
// Copia literal de su parser y de restorePreviousDraft, SOLO para la prueba: el mismo almacén lo leen y escriben los dos
// lados. Cuando #269 se integre, esta copia se sustituye por la importación de wizard.ts.
type P = { raw: string; at: string; step: number };
const stepOf269 = (raw: string) => { try { const n = Number(JSON.parse(raw)?.step); return Number.isFinite(n) ? n : 0; } catch { return 0; } };
const isP = (x: unknown): x is { raw: string; at?: unknown; step?: unknown } => !!x && typeof x === "object" && typeof (x as { raw?: unknown }).raw === "string" && (x as { raw: string }).raw.length > 0;
const normP = (x: { raw: string; at?: unknown; step?: unknown }): P => ({ raw: x.raw, at: typeof x.at === "string" ? x.at : "", step: Number.isFinite(Number(x.step)) ? Number(x.step) : stepOf269(x.raw) });
function parse269(raw: string | null): { items: P[]; legacy: string | null } {
  if (!raw) return { items: [], legacy: null };
  try {
    const v = JSON.parse(raw) as unknown;
    if (Array.isArray(v)) return { items: v.filter(isP).map(normP), legacy: null };
    if (v && typeof v === "object" && Array.isArray((v as { items?: unknown }).items)) { const o = v as { items: unknown[]; legacy?: unknown }; return { items: o.items.filter(isP).map(normP), legacy: typeof o.legacy === "string" ? o.legacy : null }; }
    return { items: [], legacy: raw };
  } catch { return { items: [], legacy: raw }; }
}
function write269(st: DraftStore, items: P[], legacy: string | null) {
  if (!items.length && !legacy) { st.removeItem(DRAFT_RECOVERY_KEY); return; }
  st.setItem(DRAFT_RECOVERY_KEY, JSON.stringify(legacy ? { v: 1, items, legacy } : { v: 1, items }));
}
/** Lo que hace applyFreshHomeEntry de #269 con el borrador activo previo. */
function park269(st: DraftStore, prior: string, now: string) {
  const p = parse269(st.getItem(DRAFT_RECOVERY_KEY));
  if (p.items[0]?.raw !== prior) { p.items.unshift({ raw: prior, at: now, step: stepOf269(prior) }); write269(st, p.items, p.legacy); }
}
function restore269(st: DraftStore, current: string | null, index = 0, now = "r"): string | null {
  const p = parse269(st.getItem(DRAFT_RECOVERY_KEY));
  if (index < 0 || index >= p.items.length) return null;
  const head = p.items[index]!, rest = p.items.filter((_, i) => i !== index);
  write269(st, current && current.trim() && current !== head.raw ? [{ raw: current, at: now, step: stepOf269(current) }, ...rest] : rest, p.legacy);
  return head.raw;
}

test("contrato #269 ↔ #272 en el MISMO almacén: portada, dos «Empezar de nuevo», recuperar por cada lado; nada se pierde", () => {
  const s = mem({ [DRAFT_RECOVERY_KEY]: "{legado" });
  park269(s, draft("portada 1"), "a");                  // entrada «Personalizado» (#269)
  parkDraft(s, draft("guion A", { scriptJob: { jobId: "j-a" } }), "b"); // «Empezar de nuevo» (#272)
  parkDraft(s, draft("guion B"), "c");                  // otro «Empezar de nuevo»
  park269(s, draft("portada 2"), "d");                  // otra entrada desde la portada
  // Los dos parsers ven exactamente lo mismo.
  assert.deepEqual(parseRecovery(s.m.get(DRAFT_RECOVERY_KEY)!), parse269(s.m.get(DRAFT_RECOVERY_KEY)!));
  const topics = () => parse269(s.m.get(DRAFT_RECOVERY_KEY)!).items.map((x) => JSON.parse(x.raw).topic);
  assert.deepEqual(topics(), ["portada 2", "guion B", "guion A", "portada 1"]);
  // #269 recupera por índice el guion A (con su scriptJob intacto: mismo ancla).
  const a = restore269(s, draft("activo"), 2);
  assert.equal(JSON.parse(a!).scriptJob.jobId, "j-a");
  assert.deepEqual(topics(), ["activo", "portada 2", "guion B", "portada 1"]);
  // #272 recupera el más reciente; el activo ocupa su lugar.
  assert.equal(JSON.parse(takeParked(s, draft("activo 2"))!).topic, "activo");
  assert.deepEqual(topics(), ["activo 2", "portada 2", "guion B", "portada 1"]);
  assert.equal(parse269(s.m.get(DRAFT_RECOVERY_KEY)!).legacy, "{legado", "el legado tampoco se pierde");
});
