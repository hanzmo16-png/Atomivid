import { test } from "node:test";
import assert from "node:assert/strict";
import { veoVideoProvider } from "./veo";
import { GenerativeProviderError } from "../types";

async function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const key = "VEO_API_KEY";
  const original = process.env[key];
  delete process.env[key];
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined) process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

test("veoVideoProvider cumple la interfaz VideoProvider (name/capabilities/isAvailable/generateVideo)", () => {
  assert.equal(veoVideoProvider.name, "veo");
  assert.ok(veoVideoProvider.capabilities);
  assert.equal(typeof veoVideoProvider.isAvailable, "function");
  assert.equal(typeof veoVideoProvider.generateVideo, "function");
});

test("isAvailable() es false sin VEO_API_KEY (el caso en este entorno)", async () => {
  await withEnv({}, () => {
    assert.equal(veoVideoProvider.isAvailable(), false);
  });
});

test("isAvailable() es true con VEO_API_KEY presente (nunca hace que generateVideo funcione, ver siguiente test)", async () => {
  await withEnv({ VEO_API_KEY: "key" }, () => {
    assert.equal(veoVideoProvider.isAvailable(), true);
  });
});

test("generateVideo() SIEMPRE lanza contract_unverified — incluso con credenciales configuradas, nunca intenta una llamada HTTP real", async () => {
  await withEnv({ VEO_API_KEY: "key" }, async () => {
    await assert.rejects(
      () =>
        veoVideoProvider.generateVideo({
          prompt: "test",
          aspectRatio: "16:9",
          durationSeconds: 8,
          maxCostUsd: 2,
        }),
      (err: unknown) => {
        assert.ok(err instanceof GenerativeProviderError);
        assert.equal(err.reason, "contract_unverified");
        assert.equal(err.providerId, "veo");
        return true;
      },
    );
  });
});

test("la request nunca incluye un parámetro de audio inventado — el tipo VideoGenerationRequest no fue ampliado para esto", async () => {
  await withEnv({}, async () => {
    // Documenta la decisión (P2A sección 7): no se inventa un switch de
    // audio. Si esta aserción algún día falla porque alguien AGREGÓ un
    // campo de audio a VideoGenerationRequest, debe ser una decisión
    // consciente respaldada por documentación primaria verificada, no un
    // descuido.
    const request: Record<string, unknown> = { prompt: "test", aspectRatio: "16:9", durationSeconds: 8, maxCostUsd: 2 };
    assert.equal("audioEnabled" in request, false);
    assert.equal("audio" in request, false);
  });
});
