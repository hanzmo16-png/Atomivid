import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyGithubOidc, type OidcPolicy } from "./github-oidc";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const now = 1_900_000_000;
const sha = "5d059bc13a27a3902f05f9e22fa09014b0d2adee";
const otherSha = "a".repeat(40);
const strict: OidcPolicy = { repository: "hanzmo16-png/Atomivid", defaultBranch: "claude/atomivid-mvp-setup-0079jv", environment: "Preview", audience: "atomivid-sentinel-readiness", workflows: ["mystery-shopper.yml"] };
const pinned = { ...strict, detachedDeploymentSha: sha };
const ref = `refs/heads/${strict.defaultBranch}`;
const workflow = (version: string) => `${strict.repository}/.github/workflows/mystery-shopper.yml@${version}`;
const jwks = async () => ({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "fixture", kty: "RSA" }] });
function token(patch: Record<string, unknown> = {}) {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture" })).toString("base64url");
  const c = Buffer.from(JSON.stringify({ iss: "https://token.actions.githubusercontent.com", aud: strict.audience, exp: now + 300, nbf: now, iat: now, repository: strict.repository, environment: "Preview", event_name: "deployment_status", ref: "", sha, workflow_ref: workflow(sha), run_id: "123", ...patch })).toString("base64url");
  return `${h}.${c}.${sign("RSA-SHA256", Buffer.from(`${h}.${c}`), privateKey).toString("base64url")}`;
}
const verify = (patch: Record<string, unknown> = {}, policy: OidcPolicy = pinned) => verifyGithubOidc(token(patch), policy, jwks, now);

test("exact deployed commit permits the authenticated detached deployment workflow only with an explicit trusted pin", async () => {
  for (const value of [undefined, "", sha, ref]) for (const wr of [workflow(sha), workflow(ref)]) {
    assert.equal((await verify({ ref: value, workflow_ref: wr })).ok, true);
  }
});

test("pin applies to every deployment event even when it carries the ordinary default branch", async () => {
  for (const value of [undefined, "", sha, ref]) for (const wrong of [undefined, "", otherSha, sha.toUpperCase(), 42]) {
    assert.equal((await verify({ ref: value, sha: wrong, workflow_ref: workflow(ref) })).ok, false);
  }
});

test("detached support rejects other refs, types, events, workflows and reusable code", async () => {
  for (const value of [null, 0, false, {}, [], [ref], "refs/heads/other", "refs/tags/v1", "refs/pull/343/merge", otherSha]) {
    assert.equal((await verify({ ref: value })).ok, false);
  }
  for (const event_name of ["workflow_dispatch", "schedule", "pull_request", "pull_request_target", "repository_dispatch", undefined]) {
    assert.equal((await verify({ event_name })).ok, false);
  }
  for (const workflow_ref of [workflow(otherSha), workflow(sha.toUpperCase()), workflow(ref.toUpperCase()), workflow(sha) + "/extra", workflow("refs/heads/other"), workflow(sha).replace("mystery-shopper.yml", "other.yml"), workflow(sha).replace(strict.repository, "other/repo"), [workflow(sha)], null]) {
    assert.equal((await verify({ workflow_ref })).ok, false);
  }
  for (const job_workflow_ref of [workflow(otherSha), "other", [workflow(sha)], null]) {
    assert.equal((await verify({ job_workflow_ref })).ok, false);
  }
});

test("detached deployment preserves signature, issuer, audience, repository, environment and expiry checks", async () => {
  for (const patch of [{ iss: "https://attacker.invalid" }, { aud: "atomivid-drive-token" }, { repository: "other/repo" }, { environment: "Production" }, { environment: undefined }, { exp: now - 100 }, { iat: now + 100 }, { nbf: now + 100 }]) {
    assert.equal((await verify(patch)).ok, false);
  }
  const parts = token().split(".");
  parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
  assert.equal((await verifyGithubOidc(parts.join("."), pinned, jwks, now)).ok, false);
  assert.equal((await verifyGithubOidc(token(), pinned, async () => ({ keys: [] }), now)).ok, false);
});

test("unconfigured consumers retain strict branch policy; detached fallback never reaches Drive", async () => {
  for (const value of [undefined, "", sha]) assert.equal((await verify({ ref: value, workflow_ref: workflow(ref) }, strict)).ok, false);
  assert.equal((await verify({ ref, workflow_ref: workflow(sha) }, strict)).ok, false);
  assert.equal((await verify({ event_name: "workflow_dispatch", ref, workflow_ref: workflow(ref) }, strict)).ok, true);
  assert.equal((await verify({ event_name: "schedule", ref, workflow_ref: workflow(ref) }, strict)).ok, true);
  const drive: OidcPolicy = { ...strict, audience: "atomivid-drive-token", workflows: ["orchestrator.yml"] };
  assert.equal((await verify({ aud: drive.audience, workflow_ref: `${strict.repository}/.github/workflows/orchestrator.yml@${sha}` }, drive)).ok, false);
});

test("invalid direct pins fail closed and normal branch observers remain valid with a configured pin", async () => {
  for (const detachedDeploymentSha of ["", "bad", sha.toUpperCase(), "g".repeat(40)]) {
    for (const value of ["", ref]) assert.equal((await verify({ ref: value, workflow_ref: workflow(ref) }, { ...strict, detachedDeploymentSha })).ok, false);
  }
  for (const event_name of ["workflow_dispatch", "schedule"]) {
    assert.equal((await verify({ event_name, ref, workflow_ref: workflow(ref) }, pinned)).ok, true);
    assert.equal((await verify({ event_name, ref, workflow_ref: workflow(sha) }, pinned)).ok, false);
  }
});

test("repository casing is normalized but workflow files and reusable references remain case-sensitive", async () => {
  assert.equal((await verify({ repository: strict.repository.toLowerCase(), workflow_ref: workflow(sha).replace(strict.repository, strict.repository.toLowerCase()) })).ok, true);
  assert.equal((await verify({ job_workflow_ref: workflow(sha).replace(strict.repository, strict.repository.toLowerCase()) })).ok, true);
  for (const p of [pinned, strict]) {
    const version = p === strict ? ref : sha;
    const claims = { ref, workflow_ref: workflow(version), sha };
    const wrongCase = workflow(version).replace("mystery-shopper.yml", "MYSTERY-SHOPPER.yml");
    assert.equal((await verify({ ...claims, workflow_ref: wrongCase }, p)).ok, false);
    assert.equal((await verify({ ...claims, job_workflow_ref: wrongCase }, p)).ok, false);
  }
});
