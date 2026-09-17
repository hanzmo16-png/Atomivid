import { test } from "node:test";
import assert from "node:assert/strict";
import { getAvatarProvider } from "./index";

const KEYS = ["AVATAR_PROVIDER", "HEYGEN_API_KEY"];

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
    assert.equal(getAvatarProvider().name, "fixture");
  });
});

test("AVATAR_PROVIDER=heygen sin HEYGEN_API_KEY cae a fixture", async () => {
  await withEnv({ AVATAR_PROVIDER: "heygen" }, () => {
    assert.equal(getAvatarProvider().name, "fixture");
  });
});

test("AVATAR_PROVIDER=heygen con clave presente sí selecciona heygen", async () => {
  await withEnv({ AVATAR_PROVIDER: "heygen", HEYGEN_API_KEY: "fake-key" }, () => {
    assert.equal(getAvatarProvider().name, "heygen");
  });
});
