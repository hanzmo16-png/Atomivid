import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStoryboard } from "./index";
import type { GeneratedScript } from "@/lib/providers/types";

const KEYS = ["VISUAL_DIRECTOR_ENABLED", "ANTHROPIC_API_KEY"];

async function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const originals = KEYS.map((k) => [k, process.env[k]] as const);
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
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

function makeScript(): GeneratedScript {
  return { title: "t", segments: [{ text: "hola mundo", visualQuery: "person" }] };
}

test("con VISUAL_DIRECTOR_ENABLED apagado, buildStoryboard usa el modo simulado sin tocar la red, aunque haya ANTHROPIC_API_KEY", async () => {
  await withEnv({ VISUAL_DIRECTOR_ENABLED: "false", ANTHROPIC_API_KEY: "fake-key-present" }, async () => {
    const { source } = await buildStoryboard(makeScript());
    assert.equal(source, "simulated");
  });
});

test("con VISUAL_DIRECTOR_ENABLED encendido pero SIN ANTHROPIC_API_KEY, cae a simulado en vez de lanzar", async () => {
  await withEnv({ VISUAL_DIRECTOR_ENABLED: "true", ANTHROPIC_API_KEY: undefined }, async () => {
    await assert.doesNotReject(async () => {
      const { source } = await buildStoryboard(makeScript());
      assert.equal(source, "simulated");
    });
  });
});
