import { test } from "node:test";
import assert from "node:assert/strict";
import { createRecoveryProof, validRecoveryProof, passwordError, recoveryOrigin } from "./recovery";
import { safeRedirectTarget } from "./errors";
test("recovery proof rejects forged, expired, wrong-user and wrong-session requests", () => {
  const proof = createRecoveryProof("owner", "session", "test-key", 1000);
  assert.equal(validRecoveryProof(proof, "owner", "session", "test-key", 1001), true);
  for (const [value, user, token, key, now] of [
    [proof + "0", "owner", "session", "test-key", 1001],
    [proof, "other", "session", "test-key", 1001],
    [proof, "owner", "different-session", "test-key", 1001],
    [proof, "owner", "session", "wrong-key", 1001],
    [proof, "owner", "session", "test-key", 901000],
  ] as const) assert.equal(validRecoveryProof(value, user, token, key, now), false);
  assert.equal(validRecoveryProof(undefined, "owner", "session", "test-key"), false);
});
test("password constraints do not trim or silently alter a password", () => {
  assert.ok(passwordError("short", "short"));
  assert.ok(passwordError("a".repeat(129), "a".repeat(129)));
  assert.ok(passwordError("a long password", "another password"));
  assert.equal(passwordError(" a long password ", " a long password "), null);
});
test("recovery origin is configured HTTPS; redirects cannot escape the app", () => {
  assert.equal(recoveryOrigin("https://atomivid.example"), "https://atomivid.example");
  for (const origin of [undefined, "http://evil.example", "https://user:pass@example.com", "https://example.com/path"]) assert.throws(() => recoveryOrigin(origin));
  for (const path of ["//evil.example", "/\\evil.example", "/\nevil.example", "https://evil.example"]) assert.equal(safeRedirectTarget(path), null);
});
