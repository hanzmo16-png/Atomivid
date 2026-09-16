import { test } from "node:test";
import assert from "node:assert/strict";
import { MissingEnvVarError, InvalidEnvVarError } from "@/lib/env-errors";
import { GitHubWorkerDispatchError, GitHubWorkerNetworkError } from "@/lib/worker/github-actions";
import { classifyRenderError, generateDiagnosticId, logRenderError, RenderStageError } from "./render-error";

test("generateDiagnosticId da identificadores cortos y distintos en cada llamada", () => {
  const a = generateDiagnosticId();
  const b = generateDiagnosticId();
  assert.ok(a.length > 0);
  assert.notEqual(a, b);
});

test("classifyRenderError incluye el identificador de diagnóstico en el mensaje", () => {
  const id = "abc12345";
  const message = classifyRenderError(new Error("algo interno"), id);
  assert.ok(message.includes(id));
});

test("classifyRenderError menciona el nombre exacto de la variable ausente", () => {
  const id = "abc12345";
  const message = classifyRenderError(new MissingEnvVarError("GH_WORKER_TOKEN"), id);
  assert.ok(message.includes("GH_WORKER_TOKEN"));
  assert.ok(message.includes(id));
});

test("classifyRenderError nunca expone el mensaje crudo del error", () => {
  const id = "abc12345";
  const rawMessage = "No se pudo activar el worker de GitHub Actions (HTTP 401): bad credentials";
  const message = classifyRenderError(new Error(rawMessage), id);
  assert.ok(!message.includes(rawMessage));
  assert.ok(!message.includes("bad credentials"));
});

test("logRenderError registra el código de un error de Supabase (objeto plano, no Error)", () => {
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    logRenderError("test", { message: "duplicate key", code: "23505" }, "abc12345");
  } finally {
    console.error = original;
  }
  assert.equal(calls.length, 1);
  const serialized = JSON.stringify(calls);
  assert.ok(serialized.includes("23505"));
});

test("classifyRenderError (el mensaje que sí ve el cliente) nunca expone un valor que aparezca en el error crudo", () => {
  // Simula el peor caso: un error cuyo mensaje sí trae algo sensible (por
  // un bug en otro punto del código, p. ej.). El límite de seguridad real
  // está en classifyRenderError, no en logRenderError — el log de servidor
  // puede y debe registrar el detalle completo para poder diagnosticar,
  // pero lo que se le devuelve al cliente jamás debe incluirlo.
  const FAKE_TOKEN = "super-secret-value-should-never-leak-9f8a7b";
  const id = "abc12345";
  const message = classifyRenderError(new Error(`fallo con token ${FAKE_TOKEN} incluido`), id);
  assert.ok(!message.includes(FAKE_TOKEN));
});

/**
 * Regresión exacta del incidente en producción (Código: 30451999, y su
 * seguimiento Código: f25825c0): un fallo al disparar el worker de
 * GitHub Actions caía en un solo mensaje genérico ("token sin permisos o
 * expiró") que trataba 401 y 403 como si fueran lo mismo. Son fallos
 * distintos y accionables de forma distinta: 401 es que GitHub rechazó
 * la credencial misma (inválida/revocada/no coincide); 403 es que
 * GitHub SÍ reconoció el token pero negó la acción por falta de
 * autorización (permisos insuficientes, política de la organización).
 * En el incidente real, GitHub mostraba "Last used within the last
 * week" para el token — evidencia de que la credencial fue reconocida,
 * lo que apunta a 403, no a 401 — pero el mensaje anterior no permitía
 * distinguir cuál de los dos había ocurrido.
 */
test("classifyRenderError da un mensaje distinto y específico para 401 (credencial rechazada)", () => {
  const id = "abc12345";
  const message = classifyRenderError(new GitHubWorkerDispatchError(401, "Bad credentials"), id);
  assert.ok(message.includes("GH_WORKER_TOKEN"));
  assert.ok(message.includes("401"));
  assert.ok(message.includes(id));
  assert.ok(!message.includes("Bad credentials"));
});

test("classifyRenderError da un mensaje distinto y específico para 403 (token reconocido, sin autorización)", () => {
  const id = "abc12345";
  const message = classifyRenderError(
    new GitHubWorkerDispatchError(403, "Resource not accessible by personal access token"),
    id,
  );
  assert.ok(message.includes("GH_WORKER_TOKEN"));
  assert.ok(message.includes("403"));
  assert.ok(message.includes(id));
  assert.ok(!message.includes("Resource not accessible by personal access token"));
});

test("classifyRenderError da textos distintos para 401 y 403 (no deben ser el mismo mensaje)", () => {
  const id = "abc12345";
  const message401 = classifyRenderError(new GitHubWorkerDispatchError(401, ""), id);
  const message403 = classifyRenderError(new GitHubWorkerDispatchError(403, ""), id);
  assert.notEqual(message401, message403);
});

test("classifyRenderError da un mensaje específico para GH_WORKER_REPO incorrecto (404)", () => {
  const id = "abc12345";
  const message = classifyRenderError(new GitHubWorkerDispatchError(404, "Not Found"), id);
  assert.ok(message.includes("GH_WORKER_REPO"));
  assert.ok(message.includes("404"));
  assert.ok(message.includes(id));
  assert.ok(!message.includes("Not Found"));
});

test("classifyRenderError incluye el status HTTP (no el cuerpo) para un 5xx de GitHub", () => {
  const id = "abc12345";
  const message = classifyRenderError(
    new GitHubWorkerDispatchError(500, "internal server error detail"),
    id,
  );
  assert.ok(message.includes("500"));
  assert.ok(!message.includes("internal server error detail"));
});

test("classifyRenderError da un mensaje específico para 422 (datos inválidos) sin exponer el cuerpo", () => {
  const id = "abc12345";
  const message = classifyRenderError(new GitHubWorkerDispatchError(422, "validation failed"), id);
  assert.ok(message.includes(id));
  assert.ok(!message.includes("validation failed"));
});

test("classifyRenderError da un mensaje específico para 429 (límite de peticiones)", () => {
  const id = "abc12345";
  const message = classifyRenderError(new GitHubWorkerDispatchError(429, "rate limited"), id);
  assert.ok(/l[íi]mite/i.test(message));
  assert.ok(!message.includes("rate limited"));
});

test("classifyRenderError cae al mensaje con status para un código HTTP no clasificado específicamente", () => {
  const id = "abc12345";
  const message = classifyRenderError(new GitHubWorkerDispatchError(400, "bad request detail"), id);
  assert.ok(message.includes("400"));
  assert.ok(!message.includes("bad request detail"));
});

test("classifyRenderError reusa el mensaje seguro de InvalidEnvVarError (sin el valor real)", () => {
  const id = "abc12345";
  const message = classifyRenderError(
    new InvalidEnvVarError("GH_WORKER_REPO", '"owner/repo"'),
    id,
  );
  assert.ok(message.includes("GH_WORKER_REPO"));
  assert.ok(message.includes(id));
});

test("classifyRenderError da un mensaje de red/timeout para GitHubWorkerNetworkError sin exponer la causa cruda", () => {
  const id = "abc12345";
  const message = classifyRenderError(
    new GitHubWorkerNetworkError(new TypeError("connect ECONNREFUSED 10.0.0.1:443")),
    id,
  );
  assert.ok(message.includes(id));
  assert.ok(!message.includes("ECONNREFUSED"));
  assert.ok(!message.includes("10.0.0.1"));
});

/**
 * Regresión exacta del incidente en producción (Código: 7bd9fef1): un
 * fallo de red/conexión de Supabase en cualquiera de las etapas del
 * endpoint (leer la solicitud, verificar la suscripción, marcarla como
 * "processing") no era ni Error de GitHub Actions ni MissingEnvVarError
 * — caía en el mismo GENERIC_RENDER_ERROR que cualquier otra cosa,
 * indistinguible de un problema del worker. RenderStageError da un
 * mensaje distinto por etapa sin exponer el error crudo de Supabase.
 */
for (const stage of ["fetch_request", "check_subscription", "mark_processing"] as const) {
  test(`classifyRenderError da un mensaje específico para la etapa "${stage}" sin exponer la causa cruda`, () => {
    const id = "abc12345";
    const rawCause = { message: "connect ETIMEDOUT 10.0.0.5:5432", code: "57P03" };
    const message = classifyRenderError(new RenderStageError(stage, rawCause), id);
    assert.ok(message.includes(id));
    assert.ok(!message.includes("ETIMEDOUT"));
    assert.ok(!message.includes("10.0.0.5"));
    assert.ok(!message.includes("57P03"));
  });
}

test("classifyRenderError da mensajes distintos para cada etapa de RenderStageError", () => {
  const id = "abc12345";
  const messages = new Set(
    (["fetch_request", "check_subscription", "mark_processing"] as const).map((stage) =>
      classifyRenderError(new RenderStageError(stage, new Error("boom")), id),
    ),
  );
  assert.equal(messages.size, 3);
});

test("logRenderError registra la etapa y desenvuelve la causa real de RenderStageError", () => {
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    logRenderError(
      "test",
      new RenderStageError("check_subscription", { message: "duplicate key", code: "23505" }),
      "abc12345",
    );
  } finally {
    console.error = original;
  }
  // Dos líneas: una anunciando la etapa, otra con el detalle de la causa
  // real (reusa la rama existente para errores planos de Supabase).
  assert.equal(calls.length, 2);
  const serialized = JSON.stringify(calls);
  assert.ok(serialized.includes("check_subscription"));
  assert.ok(serialized.includes("23505"));
});
