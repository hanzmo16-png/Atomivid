import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertLongFormAccess,
  assertLongFormCliAllowed,
  isLongFormAllowlisted,
  isLongFormEnabled,
  LongFormDisabledError,
  LongFormNotAllowlistedError,
} from "./access";

test("Long Form is off by default", () => {
  assert.equal(isLongFormEnabled({}), false);
});

test("allowlist is server-side and not email-in-frontend only", () => {
  const env = {
    LONG_FORM_ENABLED: "true",
    LONG_FORM_ALLOWLIST_USER_IDS: "user-1",
    LONG_FORM_ALLOWLIST_EMAILS: "owner@example.com",
  };
  assert.equal(isLongFormAllowlisted({ id: "user-1" }, env), true);
  assert.equal(isLongFormAllowlisted({ email: "owner@example.com" }, env), true);
  assert.equal(isLongFormAllowlisted({ email: "random@example.com" }, env), false);
});

test("assertLongFormAccess fails closed", () => {
  assert.throws(() => assertLongFormAccess({ email: "a@b.c" }, {}), LongFormDisabledError);
  assert.throws(
    () =>
      assertLongFormAccess(
        { email: "a@b.c" },
        { LONG_FORM_ENABLED: "1", LONG_FORM_ALLOWLIST_EMAILS: "owner@x.com" },
      ),
    LongFormNotAllowlistedError,
  );
});

test("P0 CLI runs only with LONG_FORM_P0_CLI=1 and does not enable the product flag", () => {
  assert.throws(() => assertLongFormCliAllowed({}), LongFormDisabledError);
  assert.doesNotThrow(() => assertLongFormCliAllowed({ LONG_FORM_P0_CLI: "1" }));
  assert.equal(isLongFormEnabled({ LONG_FORM_P0_CLI: "1" }), false);
});
