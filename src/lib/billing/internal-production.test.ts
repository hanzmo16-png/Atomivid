import { test } from "node:test";
import assert from "node:assert/strict";
import { canProduceInternalLongForm } from "./internal-production";
import { canAccessLongFormBeta } from "../video/long-form/private-access";
import { canPrepareAvatar } from "../video/avatar/private-access";

const id = "12345678-1234-4234-8234-123456789abc";
test("internal grant requires exact UUID and confirmed authenticated account", () => {
  const user = { id, email_confirmed_at: "2026-10-05" };
  assert.equal(canProduceInternalLongForm(user, id), true);
  for (const configured of ["", "*", "not-a-uuid", `${id},other`, "00000000-0000-4000-8000-000000000000"]) {
    assert.equal(canProduceInternalLongForm(user, configured), false);
  }
  assert.equal(canProduceInternalLongForm(null, id), false);
  assert.equal(canProduceInternalLongForm({ id }, id), false);
  assert.equal(canProduceInternalLongForm({ email_confirmed_at: "2026-10-05" }, id), false);
});

test("internal Long Form grant does not grant avatar access; removing it denies Long Form", t => {
  const original = process.env.INTERNAL_LONG_FORM_USER_ID;
  t.after(() => { if (original === undefined) delete process.env.INTERNAL_LONG_FORM_USER_ID; else process.env.INTERNAL_LONG_FORM_USER_ID = original; });
  process.env.INTERNAL_LONG_FORM_USER_ID = id;
  const user = { id, email: "internal@example.test", email_confirmed_at: "2026-10-05" };
  assert.equal(canAccessLongFormBeta(user), true);
  assert.equal(canPrepareAvatar(user, "other@example.test"), false);
  delete process.env.INTERNAL_LONG_FORM_USER_ID;
  assert.equal(canAccessLongFormBeta({ id, email_confirmed_at: user.email_confirmed_at }), false);
});
