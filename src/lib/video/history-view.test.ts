import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveHistoryViewState } from "./history-view";
import { pendingRequestCta } from "./request-view";

/**
 * Regresión directa del blocker real de QA (2026-09-25, Android/producción):
 * "crear solicitud -> Historial" mostraba el estado vacío en vez de la
 * solicitud recién creada, porque el SELECT fallaba (migración pendiente)
 * y el error nunca se distinguía de "cero filas". Estas pruebas fijan esa
 * distinción para que no pueda volver a colapsarse sin que un test falle.
 */

test("un error de consulta NUNCA se confunde con 'sin solicitudes' — incluso con data:null", () => {
  const state = resolveHistoryViewState(null, { message: "column video_requests.aspect_ratio does not exist" });
  assert.equal(state.kind, "error");
});

test("un error de consulta con data:[] (algunos clientes lo devuelven así) también es 'error', no 'empty'", () => {
  const state = resolveHistoryViewState([], { message: "boom" });
  assert.equal(state.kind, "error");
});

test("sin error y sin filas es 'empty' (cuenta nueva, de verdad sin solicitudes)", () => {
  const state = resolveHistoryViewState([], null);
  assert.equal(state.kind, "empty");
  const stateUndefined = resolveHistoryViewState(undefined, null);
  assert.equal(stateUndefined.kind, "empty");
});

test("una solicitud recién creada en estado 'pending' (Reel, sin guion todavía) SÍ aparece en la lista — no solo las COMPLETED", () => {
  const pendingRequest = {
    id: "req-1",
    mode: "visual",
    status: "pending",
    video_path: null,
  };
  const state = resolveHistoryViewState([pendingRequest], null);
  assert.equal(state.kind, "list");
  if (state.kind === "list") {
    assert.equal(state.requests.length, 1);
    assert.equal(state.requests[0].status, "pending");
  }
});

test("regresión completa del blocker: crear solicitud -> historial query -> pending visible -> CTA correcto", () => {
  const newlyCreatedReel = {
    id: "req-blocker-repro",
    mode: "visual",
    status: "pending",
    video_path: null,
  };

  const state = resolveHistoryViewState([newlyCreatedReel], null);
  assert.equal(state.kind, "list", "la solicitud recién creada debe llegar al historial, no al estado vacío");
  if (state.kind !== "list") return;

  const [visibleRequest] = state.requests;
  assert.equal(visibleRequest.status, "pending");

  const cta = pendingRequestCta(visibleRequest.id);
  assert.equal(cta.label, "Generar guion");
  assert.equal(cta.endpoint, "/api/generate/req-blocker-repro/script");
  assert.equal(cta.redirectTo, "/dashboard/review/req-blocker-repro");
});

test("una mezcla de estados (pending/script_ready/processing/completed/failed) preserva TODAS las filas, sin filtrar por status", () => {
  const rows = ["pending", "script_ready", "processing", "completed", "failed"].map((status, i) => ({
    id: `req-${i}`,
    status,
  }));
  const state = resolveHistoryViewState(rows, null);
  assert.equal(state.kind, "list");
  if (state.kind === "list") {
    assert.equal(state.requests.length, 5);
    assert.deepEqual(
      state.requests.map((r) => r.status),
      ["pending", "script_ready", "processing", "completed", "failed"],
    );
  }
});
