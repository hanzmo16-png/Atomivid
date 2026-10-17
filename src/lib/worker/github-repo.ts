/**
 * Strict `owner/repo` validation for GH_WORKER_REPO before it is ever placed in a GitHub API URL.
 * GitHub owners are ASCII letters, digits and single hyphens (not leading/trailing); repository names are ASCII
 * letters, digits, `.`, `_` and `-`, never `.` or `..`. Anything else (query `?`, fragment `#`, percent-encoding,
 * extra path segments, whitespace, a pasted URL) is rejected here, so the only URL this value can build is
 * `https://api.github.com/repos/<owner>/<repo>[/...]` on the intended repository.
 */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

export function isValidOwnerRepo(value: string): boolean {
  const parts = value.split("/");
  if (parts.length !== 2) return false;
  const [owner, repo] = parts;
  return OWNER.test(owner) && REPO.test(repo) && repo !== "." && repo !== "..";
}
