import { test } from "node:test";
import assert from "node:assert/strict";
import { getVideoProvider } from "./index";

const KEYS = ["VIDEO_PROVIDER", "PREMIUM_CLIPS_ENABLED", "RUNWAY_API_KEY"];

async function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const originals = KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of KEYS) delete process.env[k];
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

test("sin nada configurado, se usa el fixture", async () => {
  await withEnv({}, () => {
    assert.equal(getVideoProvider().name, "fixture");
  });
});

test("VIDEO_PROVIDER=runway con clave PERO sin PREMIUM_CLIPS_ENABLED cae a fixture (interruptor de gasto explícito)", async () => {
  await withEnv({ VIDEO_PROVIDER: "runway", RUNWAY_API_KEY: "fake-key" }, () => {
    assert.equal(getVideoProvider().name, "fixture");
  });
});

test("VIDEO_PROVIDER=runway con PREMIUM_CLIPS_ENABLED pero sin clave cae a fixture", async () => {
  await withEnv({ VIDEO_PROVIDER: "runway", PREMIUM_CLIPS_ENABLED: "true" }, () => {
    assert.equal(getVideoProvider().name, "fixture");
  });
});

test("VIDEO_PROVIDER=runway + PREMIUM_CLIPS_ENABLED + clave presente sí selecciona runway", async () => {
  await withEnv({ VIDEO_PROVIDER: "runway", PREMIUM_CLIPS_ENABLED: "true", RUNWAY_API_KEY: "fake-key" }, () => {
    assert.equal(getVideoProvider().name, "runway");
  });
});

test("el fixture genera un clip determinístico sin red", async () => {
  await withEnv({}, async () => {
    const provider = getVideoProvider();
    const asset = await provider.generateVideo({ prompt: "a person running", aspectRatio: "9:16", durationSeconds: 5, maxCostUsd: 1 });
    assert.ok(asset.buffer.byteLength > 0);
    assert.equal(asset.costUsd, 0);
  });
});
