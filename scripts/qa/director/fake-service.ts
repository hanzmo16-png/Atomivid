/**
 * Test database for the PRODUCTIVE worker entrypoint (scripts/render-worker.ts → worker-cli.ts → runRenderJob):
 * an in-memory Supabase (the simulator's query emulation) extended with the RPCs and the auth admin call the worker
 * uses, served to the real modules by `fake-service-loader.mjs`, which maps `@/lib/supabase/service` to this file.
 * Nothing here reaches a network, a real database, a provider or GitHub.
 *
 *  - Seed: ATOMIVID_FAKE_SEED = JSON file { tables: { <table>: Row[] }, env?: {...} } (video_requests, auth_users, …).
 *  - Dump: ATOMIVID_FAKE_DUMP = directory; at process exit `tables.json`, `rpc.json` and every Storage object are
 *    written there (objects under objects/<bucket>/<path>), so the harness can assert from another process.
 *  - Signed URLs are served by a loopback HTTP server (Remotion needs http:// media).
 *  - RPC behaviour mirrors the production contracts used by the worker, with switches for refusal scenarios:
 *      ATOMIVID_FAKE_SUPPLY_REFUSE=<reason>   pi_reserve_job_supply answers { reserved:false, reason }
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createFakeSupabase } from "../../simulator/lib/fake-supabase";

type Row = Record<string, unknown>;
type Rpc = { name: string; args: Row; result: unknown; at: string };

function build() {
  const opts = { signedUrlBase: "http://127.0.0.1:0" };
  const fake = createFakeSupabase(opts);
  const rpcLog: Rpc[] = [];
  const seedPath = process.env.ATOMIVID_FAKE_SEED;
  if (seedPath) {
    const seed = JSON.parse(fs.readFileSync(seedPath, "utf8")) as { tables?: Record<string, Row[]>; objects?: Record<string, string> };
    for (const [name, rows] of Object.entries(seed.tables ?? {})) fake.table(name).push(...rows.map((r) => ({ ...r })));
    // T40: Storage objects left by a previous attempt (keys `<bucket>/<path>`, base64), so recovery can prove they survive.
    for (const [key, b64] of Object.entries(seed.objects ?? {})) fake.objects.set(key, Buffer.from(b64, "base64"));
  }
  // T40: ATOMIVID_FAKE_CRASH_ON_STAGE=<stage> kills the worker process the moment it records that stage (the heartbeat
  // write is applied first, exactly like a worker lost right after it): exit 137, no further writes, tables dumped.
  const crashStage = process.env.ATOMIVID_FAKE_CRASH_ON_STAGE;
  if (crashStage) {
    for (const r of fake.table("video_requests")) {
      let stage = r.progress_stage;
      Object.defineProperty(r, "progress_stage", {
        enumerable: true, configurable: true,
        get: () => stage,
        set: (v: unknown) => { stage = v; if (v === crashStage) { process.stderr.write(`fake-service: simulated worker crash at stage ${String(v)}\n`); process.exit(137); } },
      });
    }
  }
  // Loopback media server for signed URLs (keys are `<bucket>/<path>`, like the simulator's reel scenario).
  const server = http.createServer((req, res) => {
    const key = decodeURIComponent((req.url ?? "/").slice(1).split("?")[0]);
    const b = fake.objects.get(key);
    if (!b) { res.writeHead(404); res.end(); return; }
    const type = key.endsWith(".mp3") ? "audio/mpeg" : key.endsWith(".wav") ? "audio/wav" : key.endsWith(".svg") ? "image/svg+xml" : key.endsWith(".mp4") ? "video/mp4" : key.endsWith(".json") ? "application/json" : "application/octet-stream";
    res.writeHead(200, { "content-type": type, "content-length": b.length });
    res.end(b);
  });
  server.listen(0, "127.0.0.1");
  server.unref();
  const setBase = () => { const a = server.address(); if (a && typeof a === "object") opts.signedUrlBase = `http://127.0.0.1:${a.port}`; };
  setBase();
  server.on("listening", setBase);

  const now = () => new Date().toISOString();
  const rpc = async (name: string, args: Row = {}) => {
    let result: unknown = null, error: { message: string } | null = null;
    const vr = fake.table("video_requests");
    switch (name) {
      case "pi_claim_render_supply": {
        const row = vr.find((r) => r.id === args.p_request_id);
        const ok = !!row && row.user_id === args.p_owner_id && row.status === "processing" && row.render_attempts === args.p_attempt && (row.progress_stage === null || row.progress_stage === undefined || row.progress_stage === "queued");
        if (ok) Object.assign(row!, { progress_stage: "voice", supply_wait_started_at: null, supply_not_before: null });
        result = { claimed: ok };
        break;
      }
      case "pi_reserve_job_supply": {
        const refuse = process.env.ATOMIVID_FAKE_SUPPLY_REFUSE;
        if (refuse) { result = { reserved: false, reason: refuse, provider: "elevenlabs" }; break; }
        fake.table("pi_supply_job_reservations").push({ request_id: args.p_request_id, attempt: args.p_attempt, demands: args.p_demands, status: "reserved", created_at: now() });
        result = { reserved: true };
        break;
      }
      case "pi_release_job_supply": {
        for (const r of fake.table("pi_supply_job_reservations")) if (r.request_id === args.p_request_id && r.attempt === args.p_attempt && r.status === "reserved") r.status = "released";
        result = null;
        break;
      }
      case "pi_submit_with_supply": {
        const op = fake.table("pi_paid_operations").find((r) => r.idempotency_key === args.p_key);
        if (op && op.status === "RESERVED") { op.status = "SUBMITTED"; op.updated_at = now(); result = { submitted: true }; }
        else result = { submitted: false, reason: "already_claimed" };
        break;
      }
      case "pi_supply_state":
        result = { provider: args.p_provider, level: "GREEN", reason: null, free: 1_000_000, coverageHours: 999, remainingRatio: 1 };
        break;
      case "pi_supply_spend":
        result = 0;
        break;
      default:
        error = { message: `fake-service: unknown rpc ${name}` };
    }
    rpcLog.push({ name, args, result: error ?? result, at: now() });
    return { data: result, error };
  };

  const client = Object.assign(fake.client, {
    rpc,
    auth: {
      admin: {
        async getUserById(id: string) {
          const u = fake.table("auth_users").find((r) => r.id === id);
          return u ? { data: { user: { ...u } }, error: null } : { data: { user: null }, error: { message: "user not found" } };
        },
      },
    },
  });

  const dumpDir = process.env.ATOMIVID_FAKE_DUMP;
  if (dumpDir) {
    process.on("exit", () => {
      try {
        fs.mkdirSync(dumpDir, { recursive: true });
        fs.writeFileSync(path.join(dumpDir, "tables.json"), JSON.stringify(Object.fromEntries(fake.tables), null, 2));
        fs.writeFileSync(path.join(dumpDir, "rpc.json"), JSON.stringify(rpcLog, null, 2));
        for (const [key, buf] of fake.objects) {
          const f = path.join(dumpDir, "objects", key);
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.writeFileSync(f, buf);
        }
      } catch (e) { process.stderr.write(`fake-service dump failed: ${e instanceof Error ? e.message : String(e)}\n`); }
    });
  }
  return { client, fake, rpcLog };
}

// One database per process even if this file is loaded twice (ESM hook for `import()` + CommonJS preload for `require`).
const g = globalThis as unknown as { __ATOMIVID_FAKE_SERVICE__?: ReturnType<typeof build> };
export function createServiceClient() {
  g.__ATOMIVID_FAKE_SERVICE__ ??= build();
  return g.__ATOMIVID_FAKE_SERVICE__.client as unknown as import("@supabase/supabase-js").SupabaseClient;
}
