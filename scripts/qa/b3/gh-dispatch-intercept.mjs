/**
 * T-34 B3 — preload for the LOCAL web server only (NODE_OPTIONS=--import). Replaces the GitHub dispatch with a local
 * record so the web/worker split can be reproduced on one machine: POST api.github.com/repos/<r>/dispatches never
 * leaves the process (204 + one JSON line in $B3_DISPATCH_LOG); any other api.github.com call is refused.
 * Refuses to load unless the repo is the synthetic `local-test/*` one.
 */
import fs from "node:fs";

const LOG = process.env.B3_DISPATCH_LOG;
if (!LOG || !/^local-test\//.test(process.env.GH_WORKER_REPO ?? "")) throw new Error("b3 intercept: B3_DISPATCH_LOG and GH_WORKER_REPO=local-test/* are required");
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/^https:\/\/api\.github\.com\//.test(url)) {
    if (/\/repos\/local-test\/[^/]+\/dispatches$/.test(url) && (init.method ?? "GET").toUpperCase() === "POST") {
      const body = JSON.parse(String(init.body ?? "{}"));
      fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), event: body.event_type, payload: body.client_payload }) + "\n");
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ message: "b3 intercept: refused" }), { status: 403 });
  }
  return realFetch(input, init);
};
