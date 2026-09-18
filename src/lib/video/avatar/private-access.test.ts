import test from "node:test";
import assert from "node:assert/strict";
import { canPrepareAvatar } from "./private-access";

test("private preparation denies anonymous, unconfirmed, unconfigured and other accounts", () => {
  const owner = { email: "owner@example.test", email_confirmed_at: "2026-09-18" };
  assert.equal(canPrepareAvatar(null, owner.email), false);
  assert.equal(canPrepareAvatar(owner, ""), false);
  assert.equal(canPrepareAvatar({ email: owner.email }, owner.email), false);
  assert.equal(canPrepareAvatar(owner, "other@example.test"), false);
  assert.equal(canPrepareAvatar(owner, " OWNER@example.test "), true);
});
