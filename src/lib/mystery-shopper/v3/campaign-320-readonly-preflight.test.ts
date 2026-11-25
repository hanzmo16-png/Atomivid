import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CAMPAIGN_320_READONLY_ROUTES,
  evaluateReadonlyObservation,
  type ReadonlyObservation,
} from "./campaign-320-readonly-preflight";

const good: ReadonlyObservation = {
  surface: "reels",
  requestedPath: CAMPAIGN_320_READONLY_ROUTES.reels,
  finalPath: "/dashboard/new?formato=reel",
  httpStatus: 200,
  loginRedirect: false,
  notFound: false,
  requiredVisible: { Reel: true, "Duración deseada": true },
  enabledPaidControl: false,
};

test("issue #320: el preflight de Reels y Podcast usa las rutas reales", () => {
  assert.equal(CAMPAIGN_320_READONLY_ROUTES.reels, "/dashboard/new?formato=reel");
  assert.equal(CAMPAIGN_320_READONLY_ROUTES["video-podcast"], "/dashboard/podcast");
});

test("issue #320: una superficie completa sin control de gasto habilitado pasa", () => {
  assert.deepEqual(evaluateReadonlyObservation(good), { state: "PASS", reasons: [] });
});

test("issue #320: login o 404 son bloqueo verificable; controles ausentes son FAIL", () => {
  assert.equal(evaluateReadonlyObservation({ ...good, loginRedirect: true, finalPath: "/login" }).state, "BLOCKED");
  assert.equal(evaluateReadonlyObservation({ ...good, httpStatus: 404, notFound: true }).state, "BLOCKED");
  const fail = evaluateReadonlyObservation({ ...good, requiredVisible: { Reel: false } });
  assert.equal(fail.state, "FAIL");
  assert.match(fail.reasons.join(" "), /control requerido/i);
});

test("issue #320: el preflight no contiene acciones mutantes ni clics pagados", () => {
  const source = readFileSync(new URL("./campaign-320-readonly-preflight.ts", import.meta.url), "utf8");
  for (const forbidden of [".click(", ".fill(", ".check(", ".selectOption(", "request.post(", "request.put(", "request.delete("]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.equal(evaluateReadonlyObservation({ ...good, enabledPaidControl: true }).state, "FAIL");
});

 test("issue #320: generación audiovisual pendiente de autorización queda BLOCKED, no FAIL del motor ni PASS", () => {
  const r = evaluateReadonlyObservation({ ...good, surface: "video-podcast", generationBlocked: true });
  assert.equal(r.state, "BLOCKED"); assert.match(r.reasons.join(" "), /desactivada/);
});
