/**
 * Preload for the LOCAL worker process only (node --import tsx --import <this file> scripts/render-worker.ts):
 *  1. registers the module hook that serves the in-memory test database instead of the Supabase client;
 *  2. marks the GitHub dispatch as intercepted (worker-cli's local fixture mode requires it) and refuses any call to
 *     api.github.com in this process;
 *  3. refuses to load when a real-looking Supabase URL or GitHub token is present.
 */
import { register } from "node:module";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(url)) throw new Error("fake-service-loader: NEXT_PUBLIC_SUPABASE_URL must be a loopback placeholder");
if (process.env.GH_WORKER_TOKEN && !process.env.GH_WORKER_TOKEN.startsWith("local-fake-")) throw new Error("fake-service-loader: a real-looking GH_WORKER_TOKEN is present");

register(new URL("./fake-service-hooks.mjs", import.meta.url));
globalThis.__ATOMIVID_GH_DISPATCH_INTERCEPTED__ = true;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/^https:\/\/api\.github\.com\//.test(target)) return new Response(JSON.stringify({ message: "local e2e: refused" }), { status: 403 });
  return realFetch(input, init);
};
