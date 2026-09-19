import test from "node:test";
import assert from "node:assert/strict";
import { renderFailureMessage } from "./job-error";
test("provider URLs, tokens and arbitrary raw details do not reach the UI",()=>{
  for (const raw of ["failed https://private.test/photo?token=secret", "HTTP 403 private-key-secret", "timeout private-key-secret"]) {
    const message=renderFailureMessage(raw);
    assert.ok(!message.includes("secret"));assert.ok(!message.includes("https://"));
  }
});
test("access and overload failures give different next steps",()=>{
  assert.match(renderFailureMessage("HTTP 429"),/espera unos minutos/);
  assert.match(renderFailureMessage("HTTP 403"),/repetir ahora no resolverá/i);
});
