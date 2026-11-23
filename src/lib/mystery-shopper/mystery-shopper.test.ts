import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultCatalog, editMission, parseCatalog } from "./catalog";
import { classifyProduct } from "./classify";
import { acceptCiEvent } from "./ci-trigger";
import { evaluateJourney, reportFromJourney } from "./evaluate";
import { handleMystery, redact } from "./handle";
import { decideRealMode, emptyLedger, executeRealProvider, PROVIDER_CALLS_ENABLED } from "./real-mode";
import { WEIGHTS, scoreProduct, weighted } from "./score";
import { assertRunId, fileStore, memoryStore, startIdempotent } from "./store";
import { FLOW_STEPS, type Journey, type MediaReport, type StepStatus } from "./types";

const now = () => "2026-11-23T16:00:00.000Z";
const media = (verdict: MediaReport["technicalVerdict"]): MediaReport => ({
  path: "flannan-fixture.mp3", labeledFixture: true, exists: true, container: "mp3", videoCodec: null, audioCodec: "mp3",
  durationSeconds: 2, width: null, height: null, aspect: null, fps: null, audioTracks: 1, silenceRanges: [], blackRanges: [],
  meanVolumeDb: -20, maxVolumeDb: -6, decodeErrors: [], frameSample: { extracted: false, bytes: 0, reason: "no aplica" },
  lipSync: { approved: false, method: null, reason: "sin método" }, technicalVerdict: verdict, technicalNotes: [], subjective: "no evaluado",
});

function journey(patch: Partial<Journey> = {}): Journey {
  return {
    scope: "fixture-harness", missionId: "audio-flannan", sha: "abc1234def", environment: "test", baseUrl: "http://127.0.0.1:9",
    steps: FLOW_STEPS.map((name, i) => ({ step: i + 1, name, status: "ok" as StepStatus, screen: "Audio Podcast Studio", visibleText: "FIXTURE USD 0.00", detail: "ok", clicks: 1, fields: 1, decisions: 1 })),
    screens: [{
      screen: "Audio Podcast Studio", product: "audio-podcast", profile: "principiante",
      visibleText: "El MP3 de prueba está listo. FIXTURE. Presupuesto máximo: USD 0.00",
      clicks: 6, fields: 4, decisions: 3, costVisible: true, costLabel: "USD 0.00", technicalTerms: ["MP3"],
      progressVisible: true, couldGenerate: true, couldSave: true, couldDownload: true, couldPlay: true,
      doubleClickSafe: true, mobileUsable: true, fixtureBadge: true, errorVisible: null, publishControl: null, scheduleControl: null,
    }],
    products: [{ product: "audio-podcast", seenInMenu: true, opened: true, menuLabel: "Audio Podcast", limitations: ["El archivo es fixture."], blockedReason: null, completedFreeFlow: true }],
    media: media("PASS_WITH_WARNINGS"), mediaByProduct: { "audio-podcast": media("PASS_WITH_WARNINGS") }, spendUsd: 0,
    evidence: [{ label: "pantalla", note: "FIXTURE" }], errors: [], liveProbe: null, ...patch,
  };
}

const deps = (recorded?: Journey) => ({ env: {} as Record<string, string | undefined>, now, store: memoryStore(), ledger: emptyLedger(), sha: "abc1234def", environment: "test", recordedJourneys: recorded ? [recorded] : [] });

test("el catálogo se edita sin permitir publicar en YouTube", () => {
  const edited = editMission(defaultCatalog(), "audio-flannan", { instructions: "Islas Flannan, versión de prueba más corta, en español." });
  assert.match(edited.missions[0].instructions, /versión de prueba/);
  assert.throws(() => editMission(defaultCatalog(), "youtube-borrador", { instructions: "Programar publicación mañana." }));
  const parsed = parseCatalog(edited);
  assert.equal(parsed.missions.find((m) => m.id === "youtube-borrador")?.publishForbidden, true);
});

test("sin observación el producto queda NO_VERIFICADO", () => {
  assert.equal(classifyProduct(null).availability, "NO_VERIFICADO");
  assert.equal(classifyProduct({ product: "reels", seenInMenu: false, opened: null, menuLabel: null, limitations: [], blockedReason: null, completedFreeFlow: null }).availability, "NO_DISPONIBLE");
});

test("la nota no esconde un bloqueo crítico y no inventa un cero", () => {
  assert.equal(PROVIDER_CALLS_ENABLED, false);
  const parts = { ease: 90, functionality: 90, quality: 70, costTransparency: 100, mobile: 100 };
  assert.equal(weighted(parts), Math.round((90 * WEIGHTS.ease + 90 * WEIGHTS.functionality + 70 * WEIGHTS.quality + 100 * WEIGHTS.costTransparency + 100 * WEIGHTS.mobile) * 10) / 10);
  assert.equal(weighted({ ...parts, mobile: null }), null);
  const blocked = journey({ screens: [{ ...journey().screens[0], couldDownload: false }] });
  const score = scoreProduct(blocked, "audio-podcast", "audio-podcast");
  assert.ok(score.criticalBlock?.includes("descargar"));
  assert.notEqual(score.weighted, null);
});

test("cada hallazgo separa hecho, interpretación y recomendación", () => {
  const { findings } = evaluateJourney(journey(), "audio-podcast");
  const jargon = findings.find((f) => f.fact.includes("MP3"));
  assert.ok(jargon);
  assert.equal(jargon?.profile, "principiante");
  assert.ok(jargon?.interpretation && jargon.recommendation);
  assert.equal(findings.some((f) => f.problem.includes("inventado")), false);
});

test("el modo real queda bloqueado y no llama a la red", async () => {
  const base = { mode: "real" as const, approver: "hans", missionId: "audio-flannan", expectedMissionId: "audio-flannan", maxBudgetUsd: 2, estimateUsd: 1, estimateVerified: true, knownCost: true, reservationId: "reserva-01", idempotencyKey: "run-audio-01", maxRetries: 1, attempt: 0, hansAuth: "x".repeat(16) };
  const unknown = decideRealMode({ ...base, knownCost: false, estimateVerified: false, estimateUsd: null }, emptyLedger());
  assert.equal(unknown.code, "unknown_cost");
  assert.equal(unknown.ledger.reservations.length, 0);
  const first = decideRealMode(base, emptyLedger());
  assert.equal(first.execute, false);
  assert.equal(first.code, "provider_lock");
  assert.equal(first.spentUsd, 0);
  assert.equal(first.ledger.reservations.length, 1);
  assert.equal(first.ledger.reservations[0].state, "reconciled");
  const second = decideRealMode({ ...base, estimateUsd: 1.5 }, first.ledger);
  assert.equal(second.code, "double_charge");
  assert.equal(decideRealMode({ ...base, cancelRequested: true }, emptyLedger()).code, "cancelled");
  assert.equal(decideRealMode({ ...base, maxRetries: 3 }, emptyLedger()).code, "retries");
  assert.equal(decideRealMode({ ...base, hansAuth: undefined }, emptyLedger()).code, "hans_secret");
  let calls = 0;
  await assert.rejects(() => executeRealProvider("https://api.elevenlabs.io/v1/text-to-speech", async () => { calls += 1; return new Response(""); }));
  assert.equal(calls, 0);
});

test("el panel inicia el fixture grabado, es idempotente y rechaza el modo real", async () => {
  const recorded = journey();
  const store = memoryStore();
  const started = await handleMystery({ action: "start", mode: "fixture", product: "audio-podcast", profile: "principiante", missionId: "audio-flannan", idempotencyKey: "panel-audio-1", instructions: "Islas Flannan, instrucciones editadas en el panel." }, { ...deps(recorded), store });
  const report = started.payload as { status: string; spendUsd: number; instructions: string; realMode: { executed: boolean } };
  assert.equal(report.status, "TERMINADA");
  assert.equal(report.spendUsd, 0);
  assert.match(report.instructions, /editadas/);
  assert.equal(report.realMode.executed, false);
  const again = await handleMystery({ action: "start", mode: "fixture", product: "audio-podcast", profile: "principiante", missionId: "audio-flannan", idempotencyKey: "panel-audio-1" }, { ...deps(recorded), store });
  assert.equal((await store.list()).length, 1);
  assert.equal((again.payload as { instructions: string }).instructions, report.instructions);
  const real = await handleMystery({ action: "start", mode: "real", product: "audio-podcast", profile: "profesional", missionId: "audio-flannan", idempotencyKey: "panel-real-01", approver: "hans", maxBudgetUsd: 3, estimateUsd: 1, estimateVerified: true, knownCost: true, reservationId: "reserva-panel", maxRetries: 0 }, { ...deps(), env: { MYSTERY_SHOPPER_HANS_AUTH: "autorizacion-de-hans" }, store: memoryStore() });
  const blocked = real.payload as { status: string; spendUsd: number; realMode: { executed: boolean; code: string } };
  assert.equal(blocked.status, "BLOQUEADA");
  assert.equal(blocked.spendUsd, 0);
  assert.equal(blocked.realMode.executed, false);
  assert.equal(blocked.realMode.code, "provider_lock");
});

test("sin recorrido grabado el inicio queda bloqueado y explica dónde corre el navegador", async () => {
  const result = await handleMystery({ action: "start", mode: "fixture", product: "audio-podcast", profile: "principiante", missionId: "audio-flannan", idempotencyKey: "panel-vacio-1" }, deps());
  const report = result.payload as { status: string; errors: string[]; spendUsd: number };
  assert.equal(report.status, "BLOQUEADA");
  assert.match(report.errors[0], /GitHub Actions|serverless/);
  assert.equal(report.spendUsd, 0);
});

test("el disparador es idempotente y no acepta gasto", () => {
  const event = { source: "github" as const, executionId: "github:10:abc1234", sha: "abc1234", conclusion: "success", mode: "fixture", billable: false };
  assert.equal(acceptCiEvent(event, new Set()).accept, true);
  assert.match(acceptCiEvent(event, new Set(["github:10:abc1234"])).reason, /Ya se ejecutó/);
  assert.equal(acceptCiEvent({ ...event, mode: "real" }, new Set()).accept, false);
  assert.equal(acceptCiEvent({ ...event, billable: true }, new Set()).accept, false);
  assert.equal(acceptCiEvent({ source: "vercel", executionId: "vercel:dep-1", sha: "abc1234", preview: "BUILDING", mode: "fixture" }, new Set()).accept, false);
  assert.equal(acceptCiEvent({ source: "vercel", executionId: "vercel:dep-1", sha: "abc1234", preview: "READY", mode: "fixture" }, new Set()).accept, true);
});

test("el historial rechaza ids que salen del directorio", async () => {
  assert.throws(() => assertRunId("../ledger"));
  const dir = await mkdtemp(path.join(tmpdir(), "ms-store-"));
  const store = fileStore(dir);
  const report = reportFromJourney({ id: "run-store-01", idempotencyKey: "run-store-01", mode: "fixture", product: "audio-podcast", profile: "principiante", missionId: "audio-flannan", instructions: "Islas Flannan, en español, 10 minutos.", startedAt: now(), finishedAt: now(), maxBudgetUsd: 0, realMode: { executed: false, code: "fixture", reason: "fixture" }, journey: journey() });
  const saved = await startIdempotent(store, "run-store-01", async () => report);
  assert.equal(saved.reused, false);
  assert.equal((await startIdempotent(store, "run-store-01", async () => report)).reused, true);
  assert.equal((await readdir(dir)).length, 1);
});

test("los informes no conservan correos ni secretos", () => {
  assert.equal(redact("avisa a hans@atomivid.test y sk-abcdef123456"), "avisa a [correo] y [secreto]");
});

test("el módulo no toca motores, Premium ni Supabase", async () => {
  const files = await readdir("src/lib/mystery-shopper");
  for (const name of files.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    const text = await readFile(path.join("src/lib/mystery-shopper", name), "utf8");
    assert.doesNotMatch(text, /from ["']@\/lib\/(podcast|audio-studio|video|paid-calls)|from ["']@supabase|from ["']stripe|ResultView/);
  }
  const route = await readFile("src/app/api/admin/mystery-shopper/route.ts", "utf8");
  assert.match(route, /private, no-store/);
  assert.match(route, /requireCommandCenterAdmin/);
  const page = await readFile("src/app/dashboard/command-center/page.tsx", "utf8");
  assert.match(page, /MysteryShopperPanel/);
  assert.match(page, /notFound\(\)/);
});

test("el recorrido fixture no acepta un host que no sea local", () => {
  const result = spawnSync(process.execPath, ["scripts/mystery-shopper/walk.mjs"], { env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", MS_BASE: "https://atomivid.vercel.app/login", MS_OUT: path.join(tmpdir(), "ms-remote") }, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /local/);
});
