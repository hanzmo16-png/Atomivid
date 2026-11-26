import test from "node:test";
import assert from "node:assert/strict";
import { canReserve, ledgerStore, totals, REAL_CUMULATIVE_CAP_USD, MODULE_CAP_USD, type LedgerState } from "./ledger";
import { costMatrix, costTotals } from "./costs";
import { APPROVED_REAL_BUDGET_USD } from "../start";
import { defaultCatalog, missionById } from "../catalog";
import { AUDIO_VARIANTS, qaScript, usdOf } from "../../../../scripts/mystery-shopper/real-missions";
import { estimate, newProject, readinessIssues, voicePreset } from "../../audio-studio/model";
import type { StorageApi } from "../jobs";

const R = (key: string, module: "audio-podcast" | "youtube" | "reels" | "video-podcast", usd: number) => ({ key, module, jobId: "ms-x", reservedUsd: usd, at: "2026-11-24T21:00:00Z" });

test("t899u: tope acumulado USD 8.50 = presupuesto aprobado = suma de topes por módulo = tope de la matriz", () => {
  assert.equal(REAL_CUMULATIVE_CAP_USD, 8.5);
  assert.equal(APPROVED_REAL_BUDGET_USD, 8.5);
  assert.equal(Object.values(MODULE_CAP_USD).reduce((a, b) => a + b, 0), 8.5);
  assert.equal(costTotals(costMatrix()).capUsd, 8.5);
});

test("libro: una reserva abierta cuenta por su tope; liquidada, por el gasto real; nunca se pasa de 8.50 ni del módulo", () => {
  const s: LedgerState = { reservations: [R("a", "audio-podcast", 1), R("b", "audio-podcast", 1)], settlements: [{ key: "a", spentUsd: 0.56, source: "ui", at: "" }] };
  assert.deepEqual(totals(s), { spentUsd: 0.56, openReservedUsd: 1, committedUsd: 1.56, byModule: { "audio-podcast": 1.56 } });
  assert.equal(canReserve(s, "audio-podcast", 0.5).ok, false); // 1.56 + 0.5 > 2.00 del módulo
  assert.equal(canReserve(s, "audio-podcast", 0.44).ok, true);
  const full: LedgerState = { reservations: [R("y", "youtube", 2), R("r", "reels", 1.5), R("v", "video-podcast", 3), R("a", "audio-podcast", 1.9)], settlements: [] };
  assert.equal(canReserve(full, "audio-podcast", 0.1).ok, true);
  assert.equal(canReserve({ ...full, reservations: [...full.reservations, R("z", "audio-podcast", 0.1)] }, "reels", 0.01).ok, false);
  assert.equal(canReserve(s, "audio-podcast", 0).ok, false);
});

test("libro en Storage: reserva atómica e idempotente (un reintento no vuelve a gastar)", async () => {
  const files = new Map<string, string>();
  const bucket: StorageApi = {
    async list(prefix) { return { data: [...files.keys()].filter((k) => k.startsWith(prefix + "/")).map((k) => ({ name: k.slice(prefix.length + 1) })), error: null }; },
    async download(p) { const v = files.get(p); return v === undefined ? { data: null, error: { message: "not found", statusCode: 404 } } : { data: new Blob([v]), error: null }; },
    async upload(p, body, o) { if (!o.upsert && files.has(p)) return { error: { message: "The resource already exists", statusCode: 409 } }; files.set(p, String(body)); return { error: null }; },
  };
  const l = ledgerStore(bucket);
  assert.equal((await l.reserve(R("k1", "audio-podcast", 1))).ok, true);
  assert.equal((await l.reserve(R("k1", "audio-podcast", 1))).ok, false);
  await l.settle({ key: "k1", spentUsd: 0.55, source: "ui", at: "" });
  await l.settle({ key: "k1", spentUsd: 0.99, source: "ui", at: "" }); // segunda liquidación ignorada (inmutable)
  assert.equal(totals(await l.state()).committedUsd, 0.55);
  assert.equal((await l.reserve(R("k2", "youtube", 2.01))).ok, false);
});

test("guion QA de Audio Studio: el modelo real del estudio lo deja listo (5 min objetivo, tope USD 1) y cuesta ≤ USD 1", () => {
  for (const v of Object.values(AUDIO_VARIANTS)) {
    const p = { ...newProject({ id: "6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f", ownerId: "7a1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f", now: "2026-11-24T00:00:00Z", title: v.title, voiceCount: v.voices, language: v.lang }), voices: v.voiceIds, targetMinutes: 5, budgetUsd: 1, script: qaScript(v.lang, v.voices) };
    const e = estimate(p);
    assert.deepEqual(readinessIssues(p, e), [], `${v.id}: ${readinessIssues(p, e).join(" | ")}`);
    assert.ok(e.estimatedUsd <= 1, `${v.id} cuesta ${e.estimatedUsd}`);
    for (const id of v.voiceIds) assert.equal(voicePreset(id)?.language, v.lang);
  }
  assert.equal(voicePreset("es-latam-m-profesional")?.gender, "masculina");
  assert.equal(voicePreset("es-latam-f-profesional")?.gender, "femenina");
});

test("misiones reales en el catálogo y lectura de montos", () => {
  for (const id of ["audio-real-es", "audio-real-en", "youtube-real"]) { const m = missionById(defaultCatalog(), id); assert.ok(m && !m.auto, id); }
  assert.equal(usdOf("USD 0.56"), 0.56); assert.equal(usdOf("US$ 1,20"), 1.2); assert.equal(usdOf("—"), null);
});

test("beta privada: un 404 «No encontramos esa página» es BLOQUEO, nunca «Formulario visible» (producción 24-nov)", async () => {
  const { runYoutubeReal } = await import("../../../../scripts/mystery-shopper/real-missions");
  const steps: { name: string; state: string; detail: string }[] = []; const gates: string[] = []; const marks: [number, boolean, string][] = [];
  const page = { url: () => "https://atomicvid.app/dashboard/long-form/new", locator: () => ({ first: () => ({ innerText: async () => "No encontramos esa página" }) }) };
  const c = {
    page, jobId: "ms-x", baseUrl: "https://atomicvid.app", out: "/tmp", real: true, media: [], incidents: [], ledger: null,
    step: async (name: string, fn: () => Promise<{ state: string; detail: string }>) => { const r = await fn(); steps.push({ name, ...r }); return r; },
    goto: async () => ({ httpStatus: 404 }), metrics: async () => ({}), mark: (i: number, m: boolean, e: string) => { marks.push([i, m, e]); }, cIdx: () => 0, act: () => {},
    probe: async () => ({}), setCritical: () => {}, setHumanGate: (s: string) => { gates.push(s); }, addSpend: () => {},
  };
  await runYoutubeReal(c as never);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].state, "BLOCKED");
  assert.match(steps[0].detail, /404/);
  assert.equal(marks[0][1], false);
  assert.match(gates[0], /BETA_QA_USER_IDS/);
});
