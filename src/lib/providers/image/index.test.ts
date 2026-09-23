import { test } from "node:test";
import assert from "node:assert/strict";
import { getImageProvider } from "./index";

async function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const keys = ["IMAGE_PROVIDER", "OPENAI_API_KEY"];
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

test("sin IMAGE_PROVIDER configurado, se usa el fixture", async () => {
  await withEnv({}, () => {
    assert.equal(getImageProvider().name, "fixture");
  });
});

test("IMAGE_PROVIDER=openai sin OPENAI_API_KEY cae a fixture (nunca falla al arrancar)", async () => {
  await withEnv({ IMAGE_PROVIDER: "openai" }, () => {
    assert.equal(getImageProvider().name, "fixture");
  });
});

test("IMAGE_PROVIDER=openai con OPENAI_API_KEY presente sí selecciona openai", async () => {
  await withEnv({ IMAGE_PROVIDER: "openai", OPENAI_API_KEY: "sk-test-fake-not-a-real-key" }, () => {
    assert.equal(getImageProvider().name, "openai");
  });
});

test("el fixture genera una imagen determinística sin red y respeta el aspecto 9:16 declarado en capabilities", async () => {
  await withEnv({}, async () => {
    const provider = getImageProvider();
    const asset = await provider.generateImage({ prompt: "a tired person", aspectRatio: "9:16", maxCostUsd: 1 });
    assert.ok(asset.buffer.byteLength > 0);
    assert.equal(asset.costUsd, 0);
    assert.equal(asset.width, 1080);
    assert.equal(asset.height, 1920);
  });
});

test("el fixture también genera 16:9 (Long Form) con el tamaño landscape correcto, sin afectar 9:16", async () => {
  await withEnv({}, async () => {
    const provider = getImageProvider();
    const landscape = await provider.generateImage({ prompt: "ancient stone pillars", aspectRatio: "16:9", maxCostUsd: 1 });
    assert.equal(landscape.width, 1920);
    assert.equal(landscape.height, 1080);
    const portrait = await provider.generateImage({ prompt: "a tired person", aspectRatio: "9:16", maxCostUsd: 1 });
    assert.equal(portrait.width, 1080);
    assert.equal(portrait.height, 1920);
  });
});
