import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { configDiff, workflowLiteralEnv } from "./config-parity";

test("render.yml: valores literales del worker y variables opacas (secretos/expresiones) separados", () => {
  const yml = readFileSync(path.join(__dirname, "../../../.github/workflows/render.yml"), "utf8");
  const { literals, opaque } = workflowLiteralEnv(yml, "name: Renderizar video");
  assert.equal(literals.MAX_AVATAR_COST_USD, "2");
  assert.ok("PRICING_ELEVENLABS_USD_PER_1K_CHARS" in literals);
  assert.ok(opaque.includes("HEYGEN_API_KEY") && !("HEYGEN_API_KEY" in literals), "secrets are never read as values");
});

test("diferencias campo a campo (el caso real: USD 2 en Vercel vs USD 5 en el worker)", () => {
  assert.deepEqual(configDiff({ maxAvatarCostUsd: 2, avatarProvider: "heygen" }, { maxAvatarCostUsd: 5, avatarProvider: "heygen" }), [{ field: "maxAvatarCostUsd", vercel: 2, worker: 5 }]);
  assert.deepEqual(configDiff({ a: 1 }, { a: 1 }), []);
});
