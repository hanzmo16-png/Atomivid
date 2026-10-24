// vercel.json git.deploymentEnabled: Vercel matches branch names with minimatch; an unmatched branch deploys, and a
// branch matching several rules deploys if ANY of them is true. Evidence branches (orphan commits with captures, no app)
// must never deploy; production and every development branch must keep deploying.
// Run: node --test scripts/qa/vercel-deployment-rules.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const minimatch = require("minimatch");
const rules = require("../../vercel.json").git.deploymentEnabled;

const deploys = (branch) => {
  const hits = Object.entries(rules).filter(([pattern]) => minimatch(branch, pattern));
  return hits.length === 0 || hits.some(([, on]) => on === true);
};

test("evidence/* branches never get a Vercel deployment", () => {
  for (const b of ["evidence/qa-202-203-ux", "evidence/qa-202-203-headers", "evidence/qa-999/nested"]) assert.equal(deploys(b), false, b);
});
test("production and development branches keep deploying", () => {
  for (const b of ["claude/atomivid-mvp-setup-0079jv", "claude/verify-202-203", "claude/qa-aceptacion-ux", "grok/podcast-audiovisual-cierre",
    "grok/p0-auth-ref-trigger", "codex/provider-capacity-evidence", "grok/long-form-p0-evidence-pending-20261019", "evidence", "my-evidence/x"]) assert.equal(deploys(b), true, b);
});
test("the existing per-branch exclusions are kept", () => {
  assert.equal(deploys("codex/provider-monitor-ready"), false);
  assert.equal(deploys("codex/internal-readiness-isolated"), false);
});
test("no rule re-enables everything (a true rule would override the evidence exclusion)", () => {
  assert.ok(Object.values(rules).every((v) => v === false));
});
