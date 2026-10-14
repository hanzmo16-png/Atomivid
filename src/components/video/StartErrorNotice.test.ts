import { test } from "node:test";
import assert from "node:assert/strict";
import { startNoticeText } from "@/lib/video/start-outcome";

const at = (status: string, retryAvailable = true, attempts = 1) => ({ status, attempts, retryAvailable });
const MSG = "Fallo temporal (Código: 0a1b2c3d)";

// Local run (chatgpt-08): a failed worker trigger leaves the request `failed` with the attempt counted, and the
// video page offers «Reintentar» — the notice used to send the owner to an «Iniciar producción» button that
// does not exist in that state.
test("the start-error notice names a button the page actually shows", () => {
  assert.match(startNoticeText(at("script_ready"), MSG, null)!, /«Iniciar producción»/);
  assert.match(startNoticeText(at("failed"), MSG, null)!, /«Reintentar»/);
  assert.doesNotMatch(startNoticeText(at("failed"), MSG, null)!, /Iniciar producción/);
  assert.doesNotMatch(startNoticeText(at("failed", false), MSG, null)!, /Reintentar|Iniciar producción/);
});

test("a stale notice (production already running or finished) is not shown", () => {
  for (const status of ["processing", "completed", "pending", "script_generating"]) assert.equal(startNoticeText(at(status), MSG, null), null);
});
