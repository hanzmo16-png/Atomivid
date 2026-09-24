import { test } from "node:test";
import assert from "node:assert/strict";
import { klingVideoProvider } from "./kling";
import { GenerativeProviderError } from "../types";

async function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const keys = ["KLING_ACCESS_KEY_ID", "KLING_ACCESS_KEY_SECRET"];
  const originals = keys.map((k) => [k, process.env[k]] as const);
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined) process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of originals) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("klingVideoProvider cumple la interfaz VideoProvider (name/capabilities/isAvailable/generateVideo)", () => {
  assert.equal(klingVideoProvider.name, "kling");
  assert.ok(klingVideoProvider.capabilities);
  assert.equal(typeof klingVideoProvider.isAvailable, "function");
  assert.equal(typeof klingVideoProvider.generateVideo, "function");
});

test("isAvailable() es false sin KLING_ACCESS_KEY_ID/KLING_ACCESS_KEY_SECRET (el caso en este entorno)", async () => {
  await withEnv({}, () => {
    assert.equal(klingVideoProvider.isAvailable(), false);
  });
});

test("isAvailable() es true solo con AMBAS credenciales presentes (nunca hace que generateVideo funcione, ver siguiente test)", async () => {
  await withEnv({ KLING_ACCESS_KEY_ID: "id", KLING_ACCESS_KEY_SECRET: "secret" }, () => {
    assert.equal(klingVideoProvider.isAvailable(), true);
  });
  await withEnv({ KLING_ACCESS_KEY_ID: "id" }, () => {
    assert.equal(klingVideoProvider.isAvailable(), false);
  });
});

test("generateVideo() SIEMPRE lanza contract_unverified — incluso con credenciales configuradas, nunca intenta una llamada HTTP real", async () => {
  await withEnv({ KLING_ACCESS_KEY_ID: "id", KLING_ACCESS_KEY_SECRET: "secret" }, async () => {
    await assert.rejects(
      () =>
        klingVideoProvider.generateVideo({
          prompt: "test",
          aspectRatio: "16:9",
          durationSeconds: 5,
          maxCostUsd: 1,
        }),
      (err: unknown) => {
        assert.ok(err instanceof GenerativeProviderError);
        assert.equal(err.reason, "contract_unverified");
        assert.equal(err.providerId, "kling");
        return true;
      },
    );
  });
});

test("generateVideo() lanza igual SIN credenciales (defensa en profundidad, no depende de isAvailable())", async () => {
  await withEnv({}, async () => {
    await assert.rejects(
      () => klingVideoProvider.generateVideo({ prompt: "test", aspectRatio: "16:9", durationSeconds: 5, maxCostUsd: 1 }),
      GenerativeProviderError,
    );
  });
});
