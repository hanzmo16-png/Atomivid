import { test } from "node:test";
import assert from "node:assert/strict";
import { isInternalProductionOwner } from "./internal-production";
import { canAccessLongFormBeta } from "../video/long-form/private-access";
import { canPrepareAvatar } from "../video/avatar/private-access";
import { isCommandCenterAdmin } from "../command-center/access";

const id = "12345678-1234-4234-8234-123456789abc";
test("internal grant requires exact UUID and confirmed authenticated account", () => {
  const user = { id, email_confirmed_at: "2026-10-05" };
  assert.equal(isInternalProductionOwner(user, { INTERNAL_PRODUCTION_OWNER_USER_ID: id }), true);
  for (const configured of ["", "*", "not-a-uuid", `${id},other`, "00000000-0000-4000-8000-000000000000"]) {
    assert.equal(isInternalProductionOwner(user, { INTERNAL_PRODUCTION_OWNER_USER_ID: configured }), false);
  }
  assert.equal(isInternalProductionOwner(null, { INTERNAL_PRODUCTION_OWNER_USER_ID: id }), false);
  assert.equal(isInternalProductionOwner({ id }, { INTERNAL_PRODUCTION_OWNER_USER_ID: id }), false);
  assert.equal(isInternalProductionOwner({ email_confirmed_at: "2026-10-05" }, { INTERNAL_PRODUCTION_OWNER_USER_ID: id }), false);
});

test("internal owner grants supported private production; revocation removes access", t => {
  const original = process.env.INTERNAL_PRODUCTION_OWNER_USER_ID;
  t.after(() => { if (original === undefined) delete process.env.INTERNAL_PRODUCTION_OWNER_USER_ID; else process.env.INTERNAL_PRODUCTION_OWNER_USER_ID = original; });
  process.env.INTERNAL_PRODUCTION_OWNER_USER_ID = id;
  const user = { id, email: "internal@example.test", email_confirmed_at: "2026-10-05" };
  assert.equal(canAccessLongFormBeta(user), true);
  assert.equal(isInternalProductionOwner(user, {}), false);
  assert.equal(canPrepareAvatar(user, "other@example.test"), true);
  assert.equal(isCommandCenterAdmin(user, { INTERNAL_PRODUCTION_OWNER_USER_ID: id }), true);
  assert.equal(isCommandCenterAdmin({ ...user, id: "other" }, { INTERNAL_PRODUCTION_OWNER_USER_ID: id }), false);
  assert.equal(isCommandCenterAdmin(user, {}), false);
  delete process.env.INTERNAL_PRODUCTION_OWNER_USER_ID;
  assert.equal(canAccessLongFormBeta({ id, email_confirmed_at: user.email_confirmed_at }), false);
});
