/** Zero-cost harness: an in-memory documentary_script_jobs table with the same
 * claim/finish semantics as the SQL functions, and a scripted provider behind
 * the REAL Anthropic SDK (global fetch). Nothing leaves the process. */
import { stableHash } from "@/lib/production-intelligence/canonical";
import { editorialFixture } from "./editorial.test-fixtures";

type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

export function fakeService(owner: { id: string; email: string }) {
  const tables: Record<string, Row[]> = { documentary_script_jobs: [], video_requests: [] };
  let clock = Date.parse("2026-10-07T00:00:00Z");
  const now = () => new Date(clock += 1000).toISOString();
  function query(table: string) {
    const filters: Filter[] = [];
    let patch: Row | null = null, upsert: { row: Row; conflict: string[] } | null = null, selected = false, limitN = Infinity;
    const run = () => {
      const rows = tables[table];
      if (upsert) {
        const { row, conflict } = upsert;
        if (!rows.some(r => conflict.every(k => r[k] === row[k])))
          rows.push({ id: crypto.randomUUID(), request_id: crypto.randomUUID(), status: "queued", stage: "En cola", error_message: null, run_token: null,
            failure_kind: null, error_code: null, retry_count: 0, editorial_rounds: 0, resubmit_allowance: 0, editorial_checkpoint: null,
            created_at: now(), updated_at: now(), ...row });
        return { data: null, error: null };
      }
      const hit = rows.filter(r => filters.every(f => f(r))).slice(0, limitN);
      if (patch) { for (const r of hit) Object.assign(r, structuredClone(patch)); return { data: selected ? hit.map(r => ({ id: r.id })) : null, error: null }; }
      return { data: hit.map(r => structuredClone(r)), error: null };
    };
    const builder = {
      select() { selected = true; return builder; },
      eq(k: string, v: unknown) { filters.push(r => r[k] === v); return builder; },
      neq(k: string, v: unknown) { filters.push(r => r[k] !== v); return builder; },
      lt(k: string, v: string) { filters.push(r => String(r[k]) < v); return builder; },
      is(k: string, v: unknown) { filters.push(r => (r[k] ?? null) === v); return builder; },
      order() { return builder; },
      limit(n: number) { limitN = n; return builder; },
      update(p: Row) { patch = p; return builder; },
      upsert(row: Row, opts: { onConflict: string }) { upsert = { row, conflict: opts.onConflict.split(",") }; return builder; },
      async maybeSingle() { const r = run(); return { data: (r.data as Row[])[0] ?? null, error: null }; },
      async single() { const r = run(); const d = (r.data as Row[])[0]; return d ? { data: d, error: null } : { data: null, error: { message: "none" } }; },
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) { try { resolve(run()); } catch (e) { reject(e); } },
    };
    return builder;
  }
  const service = {
    tables, setClock(ms: number) { clock = ms; }, now,
    from: (t: string) => query(t),
    auth: { admin: { getUserById: async () => ({ data: { user: { id: owner.id, email: owner.email, email_confirmed_at: "2026-01-01T00:00:00Z" } }, error: null }) } },
    async rpc(name: string, args: { p_id: string; p_token: string; p_script?: Row }) {
      const job = tables.documentary_script_jobs.find(r => r.id === args.p_id);
      if (name === "claim_documentary_script_job") {
        if (!job) return { data: { state: "missing" }, error: null };
        if (job.status !== "queued") return { data: { state: job.status }, error: null };
        Object.assign(job, { status: "running", run_token: args.p_token, error_message: null, updated_at: now() });
        return { data: { state: "claimed" }, error: null };
      }
      if (name === "finish_documentary_script_job") {
        if (!job || job.status !== "running" || job.run_token !== args.p_token) return { data: null, error: { message: "ownership lost" } };
        const script = args.p_script as { editorial?: { status?: string }; beats?: unknown[] };
        if (script.editorial?.status !== "approved" || (script.beats?.length ?? 0) < 5) return { data: null, error: { message: "editorial approval required" } };
        tables.video_requests.push({ id: job.request_id, user_id: job.user_id, status: "script_ready", script_json: script });
        Object.assign(job, { status: "completed", stage: "Guion listo", run_token: null, updated_at: now() });
        return { data: null, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
  };
  return service;
}

const URLS = ["https://museum.example/history", "https://archive.example/account"];
const message = (text: string, stop = "end_turn") => ({ id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-5",
  stop_reason: stop, content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 100 } });

export type ProviderMode = { truncateWriter?: boolean; repetitive?: boolean; reviewerExtraKeys?: boolean; hangOn?: "writer"; failWriterFormat?: boolean };
/** Scripted provider. `paid` counts distinct requests (a ledger would charge
 * each once); `requests` counts every HTTP request the SDK made. */
export function fakeProvider(mode: ProviderMode = {}) {
  const script = editorialFixture();
  const seen = new Set<string>();
  const state = { requests: 0, paid: 0, writerCalls: 0, continuations: 0, reviews: 0, visuals: 0, release: () => {} };
  const plan = { fragment: "plan", creativeDirection: script.creativeDirection, storyPlan: script.storyPlan, title: script.title,
    workingTitleOptions: script.workingTitleOptions, hook: script.hook };
  const beat = (i: number) => JSON.stringify({ fragment: "beat", index: i, type: script.beats[i].type, purpose: script.beats[i].purpose,
    narration: script.beats[i].narration, claims: [] });
  async function respond(body: { system?: string; messages: { content: string }[]; tools?: unknown[] }) {
    const system = String(body.system ?? ""), prompt = body.messages[0].content;
    if (body.tools) return { id: "msg_research", type: "message", role: "assistant", model: "claude-sonnet-5", stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 100 },
      content: [{ type: "web_search_tool_result", tool_use_id: "s1", content: URLS.map(url => ({ type: "web_search_result", url, title: "Source", encrypted_content: "x", page_age: null })) },
        { type: "text", text: "Notes.", citations: URLS.map((url, i) => ({ type: "web_search_result_location", url, title: `Archive ${i}`, encrypted_index: "x", cited_text: `Contemporary account ${i} reports a disputed allegation.` })) }] };
    if (system.includes("fragments-v1")) {
      state.writerCalls++;
      if (mode.hangOn === "writer") await new Promise<void>(r => { state.release = r; });
      if (mode.failWriterFormat) return message("I cannot produce JSON today.");
      if (prompt.includes("CONTINUACIÓN ESTRUCTURADA")) {
        state.continuations++;
        // Repeats an already saved block on purpose: the assembler must ignore it.
        return message([beat(1), beat(3), beat(4)].join("\n"));
      }
      if (mode.truncateWriter) return message([JSON.stringify(plan), beat(0), beat(1), beat(2), beat(3).slice(0, 120)].join("\n"), "max_tokens");
      return message([JSON.stringify(plan), ...script.beats.map((_, i) => beat(i))].join("\n"));
    }
    if (system.includes("editor crítico")) {
      state.reviews++;
      const { narrationExcerpts: catalog, script: draft } = JSON.parse(prompt) as { narrationExcerpts: { id: string; beatIndex: number; quote: string }[]; script: { beats: unknown[] } };
      const first = (b: number) => catalog.find(e => e.beatIndex === b)!;
      const ref = (b: number) => mode.reviewerExtraKeys ? { excerptId: first(b).id, quote: first(b).quote.toUpperCase(), beatIndex: b } : { excerptId: first(b).id };
      const last = draft.beats.length - 1;
      return message(JSON.stringify({
        sections: draft.beats.map((_, i) => ({ ...ref(i), contribution: `Aportación ${i + 1}`, function: i === last ? "resolution" : "new_information" })),
        firstAnswer: { delivered: true, evidence: ref(0), explanation: "Primera respuesta concreta." },
        ending: { resolvesPromise: true, evidence: ref(last), explanation: "Resolución fundamentada." },
        findings: mode.repetitive ? [{ kind: "repeated_promise", severity: "blocking", evidence: [ref(1), ref(2)],
          explanation: "Dos bloques repiten la misma promesa sin información nueva.", repair: "Sustituye una por una consecuencia." }] : [],
      }));
    }
    if (system.includes("Planifica escenas")) {
      state.visuals++;
      const { narrationExcerpts } = JSON.parse(prompt) as { narrationExcerpts: { id: string }[] };
      return message(JSON.stringify({ visuals: [0, 1].map(i => ({ description: "researcher reading dated archive", motion: false, subject: "archive",
        excerptId: narrationExcerpts[Math.min(i, narrationExcerpts.length - 1)].id })) }));
    }
    throw new Error("unexpected provider request");
  }
  const fetch = async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body));
    state.requests++;
    const key = stableHash(body, 16);
    if (!seen.has(key)) { seen.add(key); state.paid++; }
    return new Response(JSON.stringify(await respond(body)), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, state, script };
}
