import test from "node:test";
import assert from "node:assert/strict";
import { renderFailureMessage } from "./job-error";
test("provider URLs, tokens and arbitrary raw details do not reach the UI",()=>{
  for (const raw of ["failed https://private.test/photo?token=secret", "HTTP 403 private-key-secret", "timeout private-key-secret"]) {
    const message=renderFailureMessage(raw);
    assert.ok(!message.includes("secret"));assert.ok(!message.includes("https://"));
  }
});
test("access and overload failures give different next steps",()=>{
  assert.match(renderFailureMessage("HTTP 429"),/espera unos minutos/);
  assert.match(renderFailureMessage("HTTP 403"),/repetir ahora no resolverá/i);
});

/**
 * Regresión del Blocker #3 de QA (2026-09-25): un mensaje que ya viene de
 * classifyScriptError/classifyRenderError (finalizado, ya seguro, con su
 * propio código de diagnóstico al final) se reclasificaba OTRA VEZ aquí
 * con patrones pensados para el texto crudo que persiste run-job.ts —
 * como esos mensajes ya-clasificados no encajan en ninguno de los 4
 * patrones de arriba, siempre caían en el fallback más genérico posible,
 * perdiendo la especificidad que ya tenían. Un mensaje con esa firma
 * ahora se devuelve intacto; uno sin ella sigue reclasificándose como
 * siempre (el caso real de run-job.ts, que si no coincide con ningún
 * patrón conocido, debe seguir cayendo en el genérico — nunca mostrar
 * texto crudo de proveedor sin reconocer).
 */
test("un mensaje que ya trae nuestro código de diagnóstico (classifyScriptError/classifyRenderError) se devuelve sin reclasificar", () => {
  const already = "El servicio de generación de guiones está recibiendo demasiadas solicitudes en este momento. Tu solicitud sigue guardada; espera unos minutos y reintenta. (Código: a1b2c3d4)";
  assert.equal(renderFailureMessage(already), already);
});

/**
 * Regresión exacta del QA real (2026-09-25, "AVATAR REAL HEYGEN ATTEMPT
 * FAILED"): el error_message real de la solicitud fallida de Hans era
 * literalmente "El modo avatar no está habilitado (AVATAR_MODE_ENABLED=false)."
 * — sin código de diagnóstico (run-job.ts no lo añadía todavía) — y se
 * mostró como el genérico "No se pudo completar este intento...". Con
 * run-job.ts ahora añadiendo el sufijo, el mismo mensaje real debe pasar
 * intacto, tal como lo prueba ya el test genérico de arriba — aquí se fija
 * con el texto EXACTO de ese incidente para no perder esta regresión
 * concreta si el mecanismo genérico cambiara de forma.
 */
test('el error_message real del incidente (AVATAR_MODE_ENABLED=false), con código de diagnóstico, se muestra intacto', () => {
  const real = "El modo avatar no está habilitado (AVATAR_MODE_ENABLED=false). (Código: a1b2c3d4)";
  assert.equal(renderFailureMessage(real), real);
});

test("un mensaje SIN el código de diagnóstico (texto crudo real de run-job.ts) se sigue reclasificando como antes", () => {
  const raw = "ElevenLabs respondió 500: error temporal del proveedor de voz.";
  const message = renderFailureMessage(raw);
  assert.notEqual(message, raw);
  assert.equal(message, "No se pudo completar este intento. Tu solicitud sigue guardada. Revisa su estado y contacta al soporte si el problema continúa.");
});
