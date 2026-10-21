// fal.ai access check WITHOUT generating anything (USD 0). Four DIFFERENT facts, never merged:
//  1. key_present          — the secret exists in this environment (value never printed).
//  2. key_valid            — fal authenticates it. FAL_KEY: GET queue status of a random, non-existent request id and
//                            compare with the SAME call without credentials; only a different, non-401/403 answer
//                            counts as "authenticated". FAL_ADMIN_KEY: the billing GET answers 200.
//  3. balance_verified     — billing GET returned credits.current_balance in USD (Admin key only).
//  4. generation_completed — NEVER asserted here: only a real, authorized generation (the pilot) proves it.
// Usage (authorized environment with network access, e.g. GitHub Actions): node scripts/fal/access-check.mjs
import crypto from "node:crypto";
const env = process.env;
const present = (v) => typeof v === "string" && v.trim().length > 0;
const t = (ms) => AbortSignal.timeout(ms);
async function status(url, headers = {}) {
  try { const r = await fetch(url, { method: "GET", headers, redirect: "error", signal: t(15000) }); return { status: r.status, body: r.ok ? await r.json().catch(() => null) : null }; }
  catch (e) { return { status: null, error: e instanceof Error ? e.name : "error" }; }
}
const out = {
  checkedAt: new Date().toISOString(),
  key_present: { FAL_KEY: present(env.FAL_KEY), FAL_ADMIN_KEY: present(env.FAL_ADMIN_KEY) },
  key_valid: { FAL_KEY: "not_checked", FAL_ADMIN_KEY: "not_checked", detail: {} },
  balance_verified: { verified: false, usd: null, source: null },
  generation_completed: { verified: false, note: "not tested here: requires an authorized paid generation (pilot)" },
};
const probe = `https://queue.fal.run/recraft/v4/requests/${crypto.randomUUID()}/status`;
if (out.key_present.FAL_KEY) {
  const anon = await status(probe);
  const auth = await status(probe, { Authorization: `Key ${env.FAL_KEY.trim()}` });
  out.key_valid.detail.FAL_KEY = { withoutKey: anon.status, withKey: auth.status };
  out.key_valid.FAL_KEY = auth.status === 401 || auth.status === 403 ? "invalid"
    : auth.status !== null && auth.status !== anon.status ? "valid" : "inconclusive";
}
if (out.key_present.FAL_ADMIN_KEY) {
  const r = await status("https://api.fal.ai/v1/account/billing?expand=credits", { Authorization: `Key ${env.FAL_ADMIN_KEY.trim()}`, Accept: "application/json" });
  out.key_valid.detail.FAL_ADMIN_KEY = { billing: r.status };
  out.key_valid.FAL_ADMIN_KEY = r.status === 200 ? "valid" : r.status === 401 || r.status === 403 ? "invalid_or_not_admin" : "inconclusive";
  const c = r.body?.credits;
  if (r.status === 200 && String(c?.currency ?? "").toUpperCase() === "USD" && typeof c?.current_balance === "number" && Number.isFinite(c.current_balance) && c.current_balance >= 0) {
    out.balance_verified = { verified: true, usd: c.current_balance, source: "GET api.fal.ai/v1/account/billing?expand=credits" };
  }
}
const text = JSON.stringify(out, null, 2);
for (const k of [env.FAL_KEY, env.FAL_ADMIN_KEY]) if (present(k) && text.includes(k.trim())) { console.error("refusing to print: secret in output"); process.exit(2); }
console.log(text);
if (env.GITHUB_STEP_SUMMARY) {
  const fs = await import("node:fs");
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, ["## fal.ai access (no generation, USD 0)", "| check | result |", "|---|---|",
    `| 1. key present | FAL_KEY: ${out.key_present.FAL_KEY} · FAL_ADMIN_KEY: ${out.key_present.FAL_ADMIN_KEY} |`,
    `| 2. key valid | FAL_KEY: ${out.key_valid.FAL_KEY} · FAL_ADMIN_KEY: ${out.key_valid.FAL_ADMIN_KEY} |`,
    `| 3. balance verified | ${out.balance_verified.verified ? `USD ${out.balance_verified.usd}` : "no"} |`,
    `| 4. generation completed | not tested (pilot only) |`, ""].join("\n"));
}
