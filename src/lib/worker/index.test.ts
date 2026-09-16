import { test } from "node:test";
import assert from "node:assert/strict";
import { getRenderWorker } from "./index";
import { MissingEnvVarError } from "@/lib/env-errors";

const ENV_KEYS = ["RENDER_WORKER", "GH_WORKER_TOKEN", "GH_WORKER_REPO", "VERCEL"] as const;

function withEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => void) {
  const original: Partial<Record<string, string | undefined>> = {};
  for (const key of ENV_KEYS) {
    original[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, overrides);
  try {
    fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

test("getRenderWorker usa github-actions cuando GH_WORKER_TOKEN y GH_WORKER_REPO están presentes", () => {
  withEnv({ GH_WORKER_TOKEN: "fake-token-value", GH_WORKER_REPO: "owner/repo" }, () => {
    assert.equal(getRenderWorker().name, "github-actions");
  });
});

test("getRenderWorker cae a inline cuando faltan las credenciales de GitHub Actions (fuera de Vercel)", () => {
  withEnv({}, () => {
    assert.equal(getRenderWorker().name, "inline");
  });
});

test("getRenderWorker cae a inline si solo está GH_WORKER_TOKEN sin GH_WORKER_REPO (fuera de Vercel)", () => {
  withEnv({ GH_WORKER_TOKEN: "fake-token-value" }, () => {
    assert.equal(getRenderWorker().name, "inline");
  });
});

test("getRenderWorker respeta RENDER_WORKER=inline aunque haya credenciales de GitHub Actions (fuera de Vercel)", () => {
  withEnv(
    { RENDER_WORKER: "inline", GH_WORKER_TOKEN: "fake-token-value", GH_WORKER_REPO: "owner/repo" },
    () => {
      assert.equal(getRenderWorker().name, "inline");
    },
  );
});

test("getRenderWorker respeta RENDER_WORKER=github-actions explícito", () => {
  withEnv({ RENDER_WORKER: "github-actions" }, () => {
    assert.equal(getRenderWorker().name, "github-actions");
  });
});

/**
 * Regresión exacta del incidente en producción (Código cde1d3da): con
 * VERCEL=1 (siempre presente en cualquier función de Vercel) y sin
 * GH_WORKER_TOKEN/GH_WORKER_REPO, el fallback automático anterior caía en
 * "inline", que intentó cargar @remotion/bundler dentro de la función y
 * falló con "Cannot find module '@rspack/binding'". En Vercel,
 * getRenderWorker() nunca debe devolver el worker inline — ni por
 * fallback automático ni por override explícito — y debe detenerse con
 * un error explícito y tipado (nombre exacto de la variable) en vez de
 * intentarlo.
 */
test("getRenderWorker en Vercel usa github-actions cuando las credenciales están presentes", () => {
  withEnv({ VERCEL: "1", GH_WORKER_TOKEN: "fake-token-value", GH_WORKER_REPO: "owner/repo" }, () => {
    assert.equal(getRenderWorker().name, "github-actions");
  });
});

test("getRenderWorker en Vercel lanza MissingEnvVarError(GH_WORKER_TOKEN) si falta, sin caer a inline", () => {
  withEnv({ VERCEL: "1", GH_WORKER_REPO: "owner/repo" }, () => {
    assert.throws(
      () => getRenderWorker(),
      (error: unknown) => {
        assert.ok(error instanceof MissingEnvVarError);
        assert.equal(error.varName, "GH_WORKER_TOKEN");
        return true;
      },
    );
  });
});

test("getRenderWorker en Vercel lanza MissingEnvVarError(GH_WORKER_REPO) si falta, sin caer a inline", () => {
  withEnv({ VERCEL: "1", GH_WORKER_TOKEN: "fake-token-value" }, () => {
    assert.throws(
      () => getRenderWorker(),
      (error: unknown) => {
        assert.ok(error instanceof MissingEnvVarError);
        assert.equal(error.varName, "GH_WORKER_REPO");
        return true;
      },
    );
  });
});

test("getRenderWorker en Vercel lanza MissingEnvVarError sin ninguna credencial configurada", () => {
  withEnv({ VERCEL: "1" }, () => {
    assert.throws(() => getRenderWorker(), MissingEnvVarError);
  });
});

test("getRenderWorker en Vercel ignora RENDER_WORKER=inline — nunca selecciona el worker inline", () => {
  withEnv(
    {
      VERCEL: "1",
      RENDER_WORKER: "inline",
      GH_WORKER_TOKEN: "fake-token-value",
      GH_WORKER_REPO: "owner/repo",
    },
    () => {
      assert.equal(getRenderWorker().name, "github-actions");
    },
  );
});

test("getRenderWorker en Vercel con RENDER_WORKER=inline y sin credenciales sigue sin caer a inline", () => {
  withEnv({ VERCEL: "1", RENDER_WORKER: "inline" }, () => {
    assert.throws(() => getRenderWorker(), MissingEnvVarError);
  });
});
