import { test } from "node:test";
import assert from "node:assert/strict";
import { recraftAllowedFor } from "./recraft-access";

const OWNER = "0f8fad5b-d9cb-469f-a165-70867728950e";
const owner = { id: OWNER, email_confirmed_at: "2026-10-01T00:00:00Z" };

test("pilot: only the confirmed internal owner may choose Recraft while the general flag is off", () => {
  assert.equal(recraftAllowedFor(owner, { INTERNAL_PRODUCTION_OWNER_USER_ID: OWNER }), true);
  assert.equal(recraftAllowedFor({ ...owner, id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed" }, { INTERNAL_PRODUCTION_OWNER_USER_ID: OWNER }), false, "another account");
  assert.equal(recraftAllowedFor({ id: OWNER }, { INTERNAL_PRODUCTION_OWNER_USER_ID: OWNER }), false, "unconfirmed email");
  assert.equal(recraftAllowedFor(owner, {}), false, "no configuration = nobody");
  assert.equal(recraftAllowedFor(null, { INTERNAL_PRODUCTION_OWNER_USER_ID: OWNER }), false);
  assert.equal(recraftAllowedFor(owner, { INTERNAL_PRODUCTION_OWNER_USER_ID: "not-a-uuid" }), false);
});

test("worker: the Recraft-only variable carries the owner id; the general flag opens it to everyone", () => {
  assert.equal(recraftAllowedFor(owner, { RECRAFT_PILOT_OWNER_USER_ID: OWNER }), true);
  assert.equal(recraftAllowedFor({ id: "x", email_confirmed_at: "t" }, { RECRAFT_REEL_ENABLED: "true" }), true);
  assert.equal(recraftAllowedFor({ id: "x", email_confirmed_at: "t" }, { RECRAFT_REEL_ENABLED: "false", RECRAFT_PILOT_OWNER_USER_ID: OWNER }), false);
});
