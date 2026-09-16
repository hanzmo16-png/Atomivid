import { test } from "node:test";
import assert from "node:assert/strict";
import { MissingEnvVarError, InvalidEnvVarError } from "@/lib/env-errors";
import {
  githubActionsWorker,
  GitHubWorkerDispatchError,
  GitHubWorkerNetworkError,
} from "./github-actions";

const ENV_KEYS = ["GH_WORKER_TOKEN", "GH_WORKER_REPO"] as const;

function withEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => Promise<void>) {
  const original: Partial<Record<string, string | undefined>> = {};
  for (const key of ENV_KEYS) {
    original[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, overrides);
  return fn().finally(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
}

/**
 * Regresión exacta del incidente en producción (Código: 30451999): al
 * disparar el render con RENDER_WORKER=github-actions configurado pero sin
 * GH_WORKER_TOKEN/GH_WORKER_REPO válidos, el worker lanzaba un `Error`
 * genérico indistinguible de cualquier otro fallo — classifyRenderError no
 * podía dar un mensaje accionable y el cliente veía "Intenta de nuevo en un
 * momento", que es engañoso para un problema de configuración permanente.
 */
test("trigger lanza MissingEnvVarError(GH_WORKER_TOKEN) si falta el token", async () => {
  await withEnv({ GH_WORKER_REPO: "owner/repo" }, async () => {
    await assert.rejects(
      () => githubActionsWorker.trigger({ requestId: "req-1" }),
      (error: unknown) => {
        assert.ok(error instanceof MissingEnvVarError);
        assert.equal(error.varName, "GH_WORKER_TOKEN");
        return true;
      },
    );
  });
});

test("trigger lanza MissingEnvVarError(GH_WORKER_REPO) si falta el repo", async () => {
  await withEnv({ GH_WORKER_TOKEN: "fake-token-value" }, async () => {
    await assert.rejects(
      () => githubActionsWorker.trigger({ requestId: "req-1" }),
      (error: unknown) => {
        assert.ok(error instanceof MissingEnvVarError);
        assert.equal(error.varName, "GH_WORKER_REPO");
        return true;
      },
    );
  });
});

test("trigger lanza GitHubWorkerDispatchError con el status HTTP cuando la API de GitHub responde con error", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () =>
    new Response("bad credentials", { status: 401 })) as typeof fetch;

  try {
    await withEnv({ GH_WORKER_TOKEN: "fake-token-value", GH_WORKER_REPO: "owner/repo" }, async () => {
      await assert.rejects(
        () => githubActionsWorker.trigger({ requestId: "req-1" }),
        (error: unknown) => {
          assert.ok(error instanceof GitHubWorkerDispatchError);
          assert.equal(error.status, 401);
          // El mensaje de log de servidor puede incluir el cuerpo, pero
          // nunca el token — se envía por header, no aparece en el mensaje.
          assert.ok(!error.message.includes("fake-token-value"));
          return true;
        },
      );
    });
  } finally {
    global.fetch = originalFetch;
  }
});

/**
 * Auditoría de la solicitud real (incidente Código f25825c0: token
 * fine-grained scopeado correctamente, "last used" reciente en GitHub,
 * pero 401/403 reportado por ATOMIVID). Captura exactamente lo que
 * trigger() manda a fetch() para verificar mecánicamente, no solo por
 * lectura manual: endpoint y método correctos, el token no se transforma
 * ni se le antepone/recorta nada antes de ir en el header Authorization,
 * los headers son los que GitHub espera para un PAT fine-grained, y el
 * body tiene exactamente el event_type y client_payload esperados.
 */
test("trigger construye la solicitud POST /repos/{owner}/{repo}/dispatches exactamente como espera GitHub", async () => {
  const originalFetch = global.fetch;
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  const RAW_TOKEN = "fake-fine-grained-token-value-for-test-9f8a7b";

  try {
    await withEnv({ GH_WORKER_TOKEN: RAW_TOKEN, GH_WORKER_REPO: "hanzmo16-png/Atomivid" }, async () => {
      await githubActionsWorker.trigger({ requestId: "req-abc-123" });
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(capturedUrl, "https://api.github.com/repos/hanzmo16-png/Atomivid/dispatches");
  assert.equal(capturedInit?.method, "POST");

  const headers = capturedInit?.headers as Record<string, string>;
  // El token va exactamente como llegó de la variable de entorno, sin
  // recortar, sin re-serializar, sin texto extra antepuesto — solo el
  // esquema "Bearer " estándar, que GitHub acepta tanto para PAT classic
  // como fine-grained.
  assert.equal(headers.Authorization, `Bearer ${RAW_TOKEN}`);
  assert.equal(headers.Accept, "application/vnd.github+json");
  assert.equal(headers["X-GitHub-Api-Version"], "2022-11-28");

  const body = JSON.parse(capturedInit?.body as string);
  assert.equal(body.event_type, "render-video");
  assert.deepEqual(body.client_payload, { requestId: "req-abc-123" });
});

test("trigger no lanza si la API de GitHub responde ok", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;

  try {
    await withEnv({ GH_WORKER_TOKEN: "fake-token-value", GH_WORKER_REPO: "owner/repo" }, async () => {
      await githubActionsWorker.trigger({ requestId: "req-1" });
    });
  } finally {
    global.fetch = originalFetch;
  }
});

for (const status of [422, 429, 500, 503]) {
  test(`trigger lanza GitHubWorkerDispatchError con status ${status}`, async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () => new Response("detalle interno", { status })) as typeof fetch;

    try {
      await withEnv({ GH_WORKER_TOKEN: "fake-token-value", GH_WORKER_REPO: "owner/repo" }, async () => {
        await assert.rejects(
          () => githubActionsWorker.trigger({ requestId: "req-1" }),
          (error: unknown) => {
            assert.ok(error instanceof GitHubWorkerDispatchError);
            assert.equal(error.status, status);
            return true;
          },
        );
      });
    } finally {
      global.fetch = originalFetch;
    }
  });
}

test("trigger lanza InvalidEnvVarError(GH_WORKER_REPO) si el repo no tiene forma owner/repo", async () => {
  for (const badRepo of ["not-a-repo", "https://github.com/owner/repo", "owner/repo/extra", " "]) {
    await withEnv({ GH_WORKER_TOKEN: "fake-token-value", GH_WORKER_REPO: badRepo }, async () => {
      await assert.rejects(
        () => githubActionsWorker.trigger({ requestId: "req-1" }),
        (error: unknown) => {
          assert.ok(error instanceof InvalidEnvVarError);
          assert.equal(error.varName, "GH_WORKER_REPO");
          return true;
        },
      );
    });
  }
});

test("trigger lanza GitHubWorkerNetworkError si fetch rechaza (DNS/conexión)", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  try {
    await withEnv({ GH_WORKER_TOKEN: "fake-token-value", GH_WORKER_REPO: "owner/repo" }, async () => {
      await assert.rejects(
        () => githubActionsWorker.trigger({ requestId: "req-1" }),
        (error: unknown) => {
          assert.ok(error instanceof GitHubWorkerNetworkError);
          return true;
        },
      );
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("trigger lanza GitHubWorkerNetworkError si la señal de abort se dispara (timeout)", async () => {
  // Simula lo que produce el AbortController interno al vencer
  // DISPATCH_TIMEOUT_MS, sin esperar los 15s reales — el mock rechaza
  // igual que lo haría fetch() cuando su propia señal se aborta.
  const originalFetch = global.fetch;
  global.fetch = (async () => {
    throw new DOMException("The operation was aborted.", "AbortError");
  }) as typeof fetch;

  try {
    await withEnv({ GH_WORKER_TOKEN: "fake-token-value", GH_WORKER_REPO: "owner/repo" }, async () => {
      await assert.rejects(
        () => githubActionsWorker.trigger({ requestId: "req-1" }),
        (error: unknown) => {
          assert.ok(error instanceof GitHubWorkerNetworkError);
          return true;
        },
      );
    });
  } finally {
    global.fetch = originalFetch;
  }
});
