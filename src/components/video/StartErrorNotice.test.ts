import { test } from "node:test";
import assert from "node:assert/strict";
import { startErrorNextStep } from "./StartErrorNotice";

// Local run (chatgpt-08): a failed worker trigger leaves the request `failed` with the attempt counted, and the
// video page offers «Reintentar» — the notice used to send the owner to an «Iniciar producción» button that
// does not exist in that state.
test("the start-error notice names a button the page actually shows", () => {
  assert.match(startErrorNextStep("script_ready", true)!, /«Iniciar producción»/);
  assert.match(startErrorNextStep("failed", true)!, /«Reintentar»/);
  assert.doesNotMatch(startErrorNextStep("failed", true)!, /Iniciar producción/);
  assert.doesNotMatch(startErrorNextStep("failed", false)!, /Reintentar|Iniciar producción/);
});

test("a stale notice (production already running or finished) is not shown", () => {
  for (const status of ["processing", "completed", "pending", "script_generating"]) assert.equal(startErrorNextStep(status, true), null);
});
