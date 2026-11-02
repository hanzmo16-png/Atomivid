/**
 * Contrato REAL de recuperación entre #269 (entrada «Personalizado», src/lib/podcast/v3/wizard.ts) y #272 («Empezar de
 * nuevo», draft-recovery.ts) sobre el MISMO almacén. Ejecuta los dos módulos reales, sin copias.
 *
 * No forma parte de test:podcast3 (allí no se admiten pruebas omitidas y wizard.ts de esta rama aún no tiene el código de
 * #269). Se ejecuta en la rama integrada, o en un merge efímero de #269 + #272:
 *   node --import tsx --test scripts/qa/contrato-recuperacion-269-272.test.ts
 * Falla si wizard.ts no exporta applyFreshHomeEntry/restorePreviousDraft/recoveryList (rama sin #269).
 * Resultado con #269 @ 7583bbc7 + #272: sin el parser único de docs/podcast-guion-integridad.md FALLA (el crudo no se
 * lista); con él PASA junto con wizard-pantallas.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DRAFT_RECOVERY_KEY, parkDraft, parseRecovery, takeParked, type DraftStore } from "../../src/lib/podcast/v3/draft-recovery";

const mem = (init: Record<string, string> = {}): DraftStore & { m: Map<string, string> } => {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};
const draft = (topic: string, extra: Record<string, unknown> = {}) => JSON.stringify({ step: 4, topic, script: "", participants: [{}, {}], ...extra });

test("contrato real #269 ↔ #272 en el MISMO almacén (portada, reinicios, crudo, >10, legado)", async () => {
  const w = (await import("../../src/lib/podcast/v3/wizard")) as Record<string, unknown>;
  const fresh = w.applyFreshHomeEntry as undefined | ((st: DraftStore, p: Record<string, unknown>, o?: { now?: string }) => { started: boolean });
  const restore = w.restorePreviousDraft as undefined | ((st: DraftStore, o?: { now?: string; index?: number }) => { restored: boolean });
  const list = w.recoveryList as undefined | ((raw: string | null) => { raw: string }[]);
  const activeKey = String(w.WIZARD_STORAGE_KEY ?? "atomivid.podcast.asistente.v2");
  assert.ok(fresh && restore && list, "wizard.ts sin el código de #269: ejecuta este contrato en la rama integrada o en un merge de #269 + #272");
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
