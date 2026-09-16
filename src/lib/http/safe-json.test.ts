import { test } from "node:test";
import assert from "node:assert/strict";
import { safeParseJsonResponse } from "./safe-json";

test("safeParseJsonResponse: regresión — cuerpo vacío no revienta, da mensaje seguro", async () => {
  // Reproduce exactamente el caso reportado: una respuesta cuyo cuerpo
  // llegó vacío (p. ej. la función serverless se cortó a medias) —
  // response.json() a secas lanzaría "Unexpected end of JSON input".
  const response = new Response("", { status: 500 });
  const result = await safeParseJsonResponse(response);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 500);
    assert.ok(result.error.length > 0);
    assert.ok(!result.error.includes("Unexpected end of JSON input"));
  }
});

test("safeParseJsonResponse: regresión — cuerpo no-JSON (p. ej. HTML de un gateway) no revienta", async () => {
  const response = new Response("<html><body>504 Gateway Timeout</body></html>", {
    status: 504,
    headers: { "content-type": "text/html" },
  });
  const result = await safeParseJsonResponse(response);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 504);
    assert.ok(!result.error.includes("<html>"));
  }
});

test("safeParseJsonResponse: éxito con JSON válido devuelve los datos", async () => {
  const response = new Response(JSON.stringify({ status: "script_ready", script: { title: "x" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const result = await safeParseJsonResponse<{ status: string }>(response);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.status, "script_ready");
  }
});

test("safeParseJsonResponse: error JSON válido del servidor propaga el mensaje del servidor", async () => {
  const response = new Response(JSON.stringify({ error: "Necesitas una suscripción activa." }), {
    status: 402,
  });
  const result = await safeParseJsonResponse(response);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 402);
    assert.equal(result.error, "Necesitas una suscripción activa.");
  }
});

test("safeParseJsonResponse: JSON de error sin campo 'error' cae al mensaje genérico", async () => {
  const response = new Response(JSON.stringify({ somethingElse: true }), { status: 500 });
  const result = await safeParseJsonResponse(response);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error.length > 0);
  }
});

test("safeParseJsonResponse: nunca expone el cuerpo crudo no-JSON en el mensaje de error", async () => {
  const secretLookingBody = "sk_live_should_never_leak_in_error_message";
  const response = new Response(secretLookingBody, { status: 500 });
  const result = await safeParseJsonResponse(response);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(!result.error.includes(secretLookingBody));
  }
});
