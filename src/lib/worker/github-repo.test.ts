import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidOwnerRepo } from "./github-repo";

test("owner/repo estricto: acepta solo nombres válidos de GitHub", () => {
  for (const ok of ["hanzmo16-png/Atomivid", "a/b", "org-1/repo.name_2-x", "User/repo-"]) assert.ok(isValidOwnerRepo(ok), ok);
});

test("owner/repo estricto: rechaza query, fragmento, codificación, navegación, URL, espacios y segmentos extra", () => {
  for (const bad of ["owner/repo?x=1", "owner/repo#frag", "owner/re%2Fpo", "owner/..", "owner/.", "owner/../other", "owner/repo/extra", "/owner/repo",
    "owner/", "/repo", "owner repo", "owner/repo ", "https://github.com/owner/repo", "owner\\repo", "-owner/repo", "ow--ner/repo", "owner-/repo", "", "owner//repo", "ówner/repo"]) {
    assert.ok(!isValidOwnerRepo(bad), JSON.stringify(bad));
  }
});
