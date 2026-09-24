import { test } from "node:test";
import assert from "node:assert/strict";
import { createRecoveryProof, validRecoveryProof, passwordError } from "./recovery";

test("recovery proof rechaza forjado/expirado/usuario incorrecto/sesión incorrecta/clave incorrecta", () => {
  const proof = createRecoveryProof("owner", "session", "test-key", 1000);
  assert.equal(validRecoveryProof(proof, "owner", "session", "test-key", 1001), true);
  for (const [value, user, token, key, now] of [
    [proof + "0", "owner", "session", "test-key", 1001],
    [proof, "other", "session", "test-key", 1001],
    [proof, "owner", "different-session", "test-key", 1001],
    [proof, "owner", "session", "wrong-key", 1001],
    [proof, "owner", "session", "test-key", 901000],
  ] as const) {
    assert.equal(validRecoveryProof(value, user, token, key, now), false);
  }
  assert.equal(validRecoveryProof(undefined, "owner", "session", "test-key"), false);
});

test("passwordError exige 12-128 caracteres y confirmación exacta, sin recortar ni alterar en silencio", () => {
  assert.ok(passwordError("short", "short"));
  assert.ok(passwordError("a".repeat(129), "a".repeat(129)));
  assert.ok(passwordError("a long password", "another password"));
  assert.equal(passwordError(" a long password ", " a long password "), null);
});
