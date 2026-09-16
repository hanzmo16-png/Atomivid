import { test } from "node:test";
import assert from "node:assert/strict";
import { getRenderWorker } from "./index";

const ENV_KEYS = ["RENDER_WORKER", "GH_WORKER_TOKEN", "GH_WORKER_REPO"] as const;

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

test("getRenderWorker cae a inline cuando faltan las credenciales de GitHub Actions", () => {
  withEnv({}, () => {
    assert.equal(getRenderWorker().name, "inline");
  });
});

test("getRenderWorker cae a inline si solo está GH_WORKER_TOKEN sin GH_WORKER_REPO", () => {
  withEnv({ GH_WORKER_TOKEN: "fake-token-value" }, () => {
    assert.equal(getRenderWorker().name, "inline");
  });
});

test("getRenderWorker respeta RENDER_WORKER=inline aunque haya credenciales de GitHub Actions", () => {
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
