/**
 * END GAME C: cancelar un Reel en cola o en producción, sin cobros nuevos, y recuperarlo con «Reintentar».
 * Hermético: cliente Supabase con fetch simulado, ledger en memoria; ningún proveedor ni red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { canCancelReel, isCancelledFailure, REEL_CANCELLED_MESSAGE } from "./reel-cancel";
import { cancelReelAttempt } from "./reel-cancel-server";
import { attemptState } from "./attempt-state";
import { describeStoredFailure, renderFailureMessage } from "./job-error";
import { canReviewReelRetry } from "./reel-retry";
import { AttemptNoLongerActiveError, guardNewPaidCalls } from "@/lib/paid-calls/active-attempt";
import { executePaidOperation, memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { ResultView } from "@/components/video/ResultView";
import type { VideoRequestSummary } from "./request-view";

const GUARD_ENV = ["NODE_ENV", "VERCEL", "ATOMIVID_RUNTIME", "SUPPLY_GUARD_ENFORCED"] as const;
let saved: Record<string, string | undefined> = {};
test.beforeEach(() => {
  saved = Object.fromEntries(GUARD_ENV.map((k) => [k, process.env[k]]));
  for (const k of GUARD_ENV) delete (process.env as Record<string, string | undefined>)[k];
  (process.env as Record<string, string>).NODE_ENV = "test";
});
test.afterEach(() => { for (const k of GUARD_ENV) { if (saved[k] === undefined) delete (process.env as Record<string, string | undefined>)[k]; else (process.env as Record<string, string>)[k] = saved[k]!; } });

type Row = Record<string, unknown>;
function database(initial: Row) {
  const row: Row = { id: "r", user_id: "owner", mode: "visual", status: "processing", render_attempts: 1, progress_stage: "footage", ...initial };
  const patches: URLSearchParams[] = [];
  const matches = (filters: URLSearchParams) => [...filters].every(([key, value]) => key === "select"
    || (value === "is.null" ? row[key] === null || row[key] === undefined : `eq.${row[key]}` === value));
  const client = createClient("https://database.test", "fixture-only", { global: { fetch: async (input, init) => {
    const filters = new URL(String(input)).searchParams;
    const ok = matches(filters);
    if (init?.method === "PATCH") { patches.push(filters); if (ok) Object.assign(row, JSON.parse(String(init.body))); }
    const body = init?.method === "PATCH" ? (ok ? [{ id: row.id }] : []) : (ok ? { id: row.id } : null);
    return new Response(JSON.stringify(body), { status: ok || init?.method === "PATCH" ? 200 : 406, headers: { "content-type": "application/json" } });
  } } });
  return { row, client, patches };
}

test("solo un Reel visual en proceso, antes de subir el video, se puede cancelar", () => {
  for (const stage of [null, "queued", "voice", "footage", "music", "render"]) assert.equal(canCancelReel({ mode: "visual", status: "processing", progress_stage: stage }), true, String(stage));
  assert.equal(canCancelReel({ mode: "visual", status: "processing", progress_stage: "uploading" }), false, "el video ya está hecho");
  assert.equal(canCancelReel({ status: "processing", progress_stage: "voice" }), true, "filas antiguas sin mode son Reel");
  for (const mode of ["avatar", "long_form"]) assert.equal(canCancelReel({ mode, status: "processing", progress_stage: "voice" }), false, mode);
  for (const status of ["pending", "script_ready", "completed", "failed"]) assert.equal(canCancelReel({ mode: "visual", status, progress_stage: null }), false, status);
});

test("cancelar es un compare-and-set del mismo intento y etapa; deja el Reel en failed reintentable", async () => {
  const { row, client, patches } = database({ progress_stage: "footage", script_json: { segments: [{ text: "Hola." }] } });
  assert.equal(await cancelReelAttempt(client, row as never), "cancelled");
  for (const fence of ["id", "user_id", "mode", "status", "render_attempts", "progress_stage"]) assert.ok(patches[0].has(fence), `falta ${fence}`);
  assert.equal(row.status, "failed"); assert.equal(row.progress_stage, null);
  const stored = String(row.error_message);
  assert.ok(isCancelledFailure(stored));
  assert.equal(describeStoredFailure(stored).action, "retry", "nunca «soporte»: se puede reintentar");
  assert.ok(renderFailureMessage(stored).startsWith(REEL_CANCELLED_MESSAGE), "el texto llega intacto (lleva código)");
  // «Reintentar» (revisión → POST /render) sigue disponible: misma regla que el historial y la página de revisión.
  assert.equal(canReviewReelRetry({ ...row, created_at: new Date().toISOString(), render_started_at: null } as never, Date.now()), true);
  // Segundo clic / otra pestaña: ya no está en proceso → no toca nada.
  assert.equal(await cancelReelAttempt(client, { ...row, status: "processing", progress_stage: "footage" } as never), "changed");
});

test("si el worker avanzó de etapa entre la lectura y el clic, la cancelación no pisa nada", async () => {
  const { row, client } = database({ progress_stage: "music" });
  assert.equal(await cancelReelAttempt(client, { ...row, progress_stage: "footage" } as never), "changed");
  assert.equal(row.status, "processing"); assert.equal(row.progress_stage, "music");
  const { row: queued, client: c2 } = database({ progress_stage: null });
  assert.equal(await cancelReelAttempt(c2, queued as never), "cancelled", "en cola (sin etapa) también");
  assert.equal(await cancelReelAttempt(c2, { ...queued, status: "processing", mode: "avatar" } as never), "not_cancellable");
});

test("tras cancelar, el worker no envía ninguna llamada de pago nueva (ni dentro de la misma etapa)", async () => {
  const { row, client } = database({ progress_stage: "footage" });
  const state = attemptState(client, { requestId: "r", userId: "owner", attempt: 1 });
  const ledger = guardNewPaidCalls(memoryLedgerStore(), state.assertActive);
  let providerCalls = 0;
  const port = { async submit() { providerCalls++; return { providerJobId: "sync:k" }; }, async poll() { return { resultRef: "ok", actualUsd: 0.04 }; } };
  const op = (key: string) => ({ idempotencyKey: key, projectId: "r", shotId: key, provider: "recraft", model: "m", method: "image", attemptKind: "initial", reservedUsd: 0.04, capacityUnits: 1 }) as never;
  const now = () => new Date(0).toISOString();
  await executePaidOperation(ledger, op("scene-1"), port, now);
  assert.equal(providerCalls, 1, "antes de cancelar: normal");
  assert.equal(await cancelReelAttempt(client, row as never), "cancelled");
  await assert.rejects(executePaidOperation(ledger, op("scene-2"), port, now), AttemptNoLongerActiveError);
  assert.equal(providerCalls, 1, "la escena 2 no llegó al proveedor");
  assert.equal((await ledger.get("scene-2"))?.status, "RESERVED", "sin cobro: queda reservada y un reintento la reanuda");
  assert.equal((await ledger.get("scene-1"))?.status, "COMMITTED", "lo ya pagado se conserva");
});

test("el worker del Reel usa el guardián y termina sin error cuando el intento fue cancelado", () => {
  const job = fs.readFileSync("src/lib/video/run-job.ts", "utf8");
  assert.match(job, /beforeNewPaidCall: assertActive,/);
  assert.match(job, /if \(!result\.data\) throw new AttemptNoLongerActiveError\(\);/);
  assert.match(job, /if \(!failed\.error && !failed\.data && error instanceof AttemptNoLongerActiveError\) return;/);
  const gen = fs.readFileSync("src/lib/video/generate-video.ts", "utf8");
  assert.match(gen, /ledger: beforeNewPaidCall \? guardNewPaidCalls\(/);
  const route = fs.readFileSync("src/app/api/generate/[id]/cancel/route.ts", "utf8");
  assert.match(route, /\.eq\("id", id\)\.eq\("user_id", user\.id\)/, "solo el dueño");
  assert.doesNotMatch(route, /providers|getRenderWorker|reserveJobSupply|assertCanGenerate/, "cancelar nunca llama a un proveedor ni reserva");
});

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as never;
const base = { id: "33333333-3333-4333-8333-333333333333", mode: "visual", topic: "Mary Celeste", style: "Misterio", duration_seconds: 15, language: "es",
  status: "processing", video_path: null, error_message: null, script_json: { segments: [{ text: "Hola." }] }, progress_stage: "footage",
  render_attempts: 1, render_started_at: new Date(0).toISOString(), created_at: new Date(0).toISOString() } as unknown as VideoRequestSummary;
const render = (r: Partial<VideoRequestSummary>) => renderToStaticMarkup(<AppRouterContext.Provider value={router}><ResultView request={{ ...base, ...r }} nowMs={60_000} /></AppRouterContext.Provider>);

test("UI: progreso real por etapa con «Cancelar producción»; nunca en Avatar ni al subir; cancelado se puede revisar y reintentar", () => {
  const html = render({});
  assert.match(html, /Buscando imágenes por escena…/);
  assert.match(html, /aria-valuenow="45"/, "porcentaje de la etapa real que escribió el worker");
  assert.match(html, /Cancelar producción/);
  assert.doesNotMatch(render({ progress_stage: "uploading" }), /Cancelar producción/);
  assert.doesNotMatch(render({ mode: "avatar" }), /Cancelar producción/);
  const cancelled = render({ status: "failed", progress_stage: null, error_message: `${REEL_CANCELLED_MESSAGE} (Código: 0a1b2c3d)` });
  assert.match(cancelled, /Producción cancelada\./);
  assert.match(cancelled, /href="\/dashboard\/review\/33333333-3333-4333-8333-333333333333"/);
  assert.match(render({ status: "failed", progress_stage: null, error_message: "x (Código: 0a1b2c3d)" }), /No se pudo generar este video\./);
});

test("Reel fallido recuperable: la página del video dice «Revisar y reintentar» y la revisión ofrece «Reintentar»", () => {
  const failed = render({ status: "failed", progress_stage: null, render_attempts: 1, created_at: new Date(50_000).toISOString(),
    render_started_at: new Date(50_000).toISOString(), error_message: `${REEL_CANCELLED_MESSAGE} (Código: 0a1b2c3d)` });
  assert.match(failed, /Revisar y reintentar/);
  const exhausted = render({ status: "failed", progress_stage: null, render_attempts: 3, error_message: "x (Código: 0a1b2c3d)" });
  assert.doesNotMatch(exhausted, /Revisar y reintentar/, "sin intentos: solo revisar");
  const review = fs.readFileSync("src/app/dashboard/review/[id]/ScriptReview.tsx", "utf8");
  assert.match(review, /reelRetryEligible \? "Reintentar" : "Generar video final"/);
});
