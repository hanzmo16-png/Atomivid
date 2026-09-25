import { test } from "node:test";
import assert from "node:assert/strict";
import { getAvatarProvider } from "./index";
import { ProviderConfigurationError } from "../production";

const KEYS = ["AVATAR_PROVIDER", "HEYGEN_API_KEY", "DID_API_KEY", "ATOMIVID_RUNTIME"];

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

test("AVATAR_PROVIDER=did sin DID_API_KEY cae a fixture", async () => {
  await withEnv({ AVATAR_PROVIDER: "did" }, () => {
    assert.equal(getAvatarProvider().name, "fixture");
  });
});

test("AVATAR_PROVIDER=did con clave presente sí selecciona did", async () => {
  await withEnv({ AVATAR_PROVIDER: "did", DID_API_KEY: "fake-key" }, () => {
    assert.equal(getAvatarProvider().name, "did");
  });
});

// QA real (2026-09-25, "HEYGEN PROVIDER CONFIG INCOMPLETE"): en producción
// (ATOMIVID_RUNTIME=production) sin la clave, getAvatarProvider() no debe
// caer al fixture — debe fallar cerrado con ProviderConfigurationError, y
// ese error debe llevar el nombre exacto de la variable que falta (nunca su
// valor) para que run-job.ts pueda registrarlo junto al diagnosticId.
test("en producción, AVATAR_PROVIDER=heygen sin HEYGEN_API_KEY falla cerrado con missingEnvVars=['HEYGEN_API_KEY']", async () => {
  await withEnv({ AVATAR_PROVIDER: "heygen", ATOMIVID_RUNTIME: "production" }, () => {
    assert.throws(getAvatarProvider, ProviderConfigurationError);
    try {
      getAvatarProvider();
      assert.fail("se esperaba que lanzara ProviderConfigurationError");
    } catch (error) {
      assert.ok(error instanceof ProviderConfigurationError);
      assert.deepEqual(error.missingEnvVars, ["HEYGEN_API_KEY"]);
      assert.ok(!error.message.includes("HEYGEN"), "el mensaje al usuario nunca debe nombrar la variable faltante");
    }
  });
});

test("en producción, AVATAR_PROVIDER=did sin DID_API_KEY falla cerrado con missingEnvVars=['DID_API_KEY']", async () => {
  await withEnv({ AVATAR_PROVIDER: "did", ATOMIVID_RUNTIME: "production" }, () => {
    try {
      getAvatarProvider();
      assert.fail("se esperaba que lanzara ProviderConfigurationError");
    } catch (error) {
      assert.ok(error instanceof ProviderConfigurationError);
      assert.deepEqual(error.missingEnvVars, ["DID_API_KEY"]);
    }
  });
});
