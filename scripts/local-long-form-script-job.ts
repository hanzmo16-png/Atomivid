/**
 * LOCAL DEVELOPMENT ONLY. Runs one queued documentary script job against the local Supabase with a
 * SIMULATED Anthropic (the scripted provider from the durability tests), so a single Long Form
 * request can be walked end to end at USD 0. In production the job is dispatched to the GitHub
 * worker instead (script-job-dispatch.ts); this script never runs there.
 *
 *   node --env-file=.env.local --import tsx scripts/local-long-form-script-job.ts [jobId]
 *
 * Refuses to run on a production runtime, in GitHub Actions, or against a non-loopback Supabase.
 * Only requests to api.anthropic.com are simulated; everything else (local Supabase) is real.
 */
import { createClient } from "@supabase/supabase-js";
import { localSimulationProvidersAllowed } from "../src/lib/video/long-form/mode";
import { runScriptJobStep } from "../src/lib/video/long-form/script-jobs";
import { fakeProvider } from "../src/lib/video/long-form/script-durability.test-fixtures";

/** Distinct, self-consistent scenes per block: the simulated planner otherwise repeats one scene everywhere. */
const SCENES = [
  ["archive letter", "close-up of an archive letter"], ["harbor town", "old harbor town at dawn"], ["lighthouse", "lighthouse on a rocky coast"],
  ["courtroom", "empty historic courtroom"], ["newspaper", "stack of old newspapers"], ["ship deck", "wooden ship deck in fog"],
  ["town square", "cobbled town square"], ["library shelf", "dusty library shelf"], ["map table", "old map spread on a table"],
  ["church tower", "stone church tower"], ["market street", "busy market street"], ["candle desk", "desk lit by a candle"],
];

async function main() {
  if (!localSimulationProvidersAllowed()) {
    throw new Error("Local only: set LONG_FORM_LOCAL_SIMULATION_PROVIDERS=1 with a loopback NEXT_PUBLIC_SUPABASE_URL, outside production and GitHub Actions.");
  }
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  let id = process.argv[2];
  if (!id) {
    const { data, error } = await db.from("documentary_script_jobs").select("id").eq("status", "queued").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error || !data) throw new Error("No queued documentary script job");
    id = data.id as string;
  }
  const provider = fakeProvider();
  const realFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = "offline-fixture-key";
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const target = String(url instanceof Request ? url.url : url);
    if (!target.startsWith("https://api.anthropic.com/")) return realFetch(url as RequestInfo, init);
    const body = JSON.parse(String(init?.body)) as { system?: string; messages: { content: string }[] };
    if (String(body.system ?? "").includes("Planifica escenas")) {
      const { narrationExcerpts } = JSON.parse(body.messages[0].content) as { narrationExcerpts: { id: string; beatIndex: number }[] };
      const beat = narrationExcerpts[0]?.beatIndex ?? 0;
      const visuals = [0, 1].map((i) => {
        const [subject, description] = SCENES[(beat * 2 + i) % SCENES.length];
        return { description, motion: false, subject, excerptId: narrationExcerpts[Math.min(i, narrationExcerpts.length - 1)].id };
      });
      return new Response(JSON.stringify({ id: "msg_local", type: "message", role: "assistant", model: "claude-sonnet-5", stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: "text", text: JSON.stringify({ visuals }) }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return provider.fetch(url, init as { body?: unknown });
  }) as typeof fetch;
  let state = "";
  for (let i = 0; i < 80; i++) {
    state = (await runScriptJobStep(id, db)).state;
    console.log(JSON.stringify({ step: i + 1, state }));
    if (state !== "queued") break;
  }
  const { data } = await db.from("documentary_script_jobs").select("status,stage,error_message,failure_kind").eq("id", id).single();
  console.log(JSON.stringify({ job: id, simulatedAnthropicRequests: provider.state.requests, ...data }));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "local script job failed"); process.exitCode = 1; });
