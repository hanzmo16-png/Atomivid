/**
 * CommonJS counterpart of fake-service-hooks.mjs: tsx loads the TypeScript graph as CommonJS (no "type": "module"),
 * so `require("@/lib/supabase/service")` never reaches the ESM resolve hook. This preload maps that request to the
 * in-memory test database at the CommonJS resolver level. Load with `--require` after `--import tsx`.
 */
const Module = require("node:module");
const path = require("node:path");

const FAKE = path.join(__dirname, "fake-service.ts");
const TARGET = /(^@\/lib\/supabase\/service(\.ts)?$)|(\/lib\/supabase\/service(\.ts)?$)/;
const original = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  const fromHarness = parent && parent.filename && parent.filename.includes(`${path.sep}scripts${path.sep}qa${path.sep}director${path.sep}`);
  if (typeof request === "string" && TARGET.test(request) && !fromHarness) return FAKE;
  return original.call(this, request, parent, ...rest);
};
