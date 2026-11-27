import test from "node:test";
import assert from "node:assert/strict";
import { resumeSupplyQueue, resumeSupplyRequest } from "./queue";
import { longFormRenderTimeout } from "@/lib/video/long-form/render-timeout";

type FakeRow = Record<string, unknown>;
type FakeResult = { data: FakeRow | FakeRow[] | null; error: null };
type DispatchInput = Parameters<Parameters<typeof resumeSupplyQueue>[1]>[0];

const now = Date.parse("2026-11-26T12:00:00Z"), waitingAt = "2026-11-26T11:00:00Z";
function service(duration: unknown, mode = "long_form", paidStatus?: string) {
  const row: FakeRow = { id: "request", user_id: "owner", mode, duration_seconds: duration, status: "processing", progress_stage: "queued", render_attempts: 2, supply_wait_started_at: waitingAt, supply_not_before: waitingAt, script_json: { beats: [{ narration: "Narración guardada" }], segments: [{ text: "Narración guardada" }] }, recorded_audio_path: null, long_form_production_plan: { allocation: { maxGenerativeUsd: 0, maxAiImageGenerations: 0, maxAiVideoClips: 0 }, aiImageCount: 0, aiVideoClipCount: 0, providers: { image: "fixture", aiVideo: "fixture" } } };
  const calls: { name: string; args?: Record<string, unknown> }[] = [], updates: Record<string, unknown>[] = [];
  const db = {
    row, calls, updates,
    async rpc(name: string, args?: Record<string, unknown>) { calls.push({ name, args }); return { data: name === "pi_worker_supply_slots" ? { configured: true, free: 1 } : { reserved: true }, error: null }; },
    from(table: string) {
      let columns = "*", patch: Record<string, unknown> | null = null, single = false;
      const filters: ((item: FakeRow) => boolean)[] = [];
      const chain = {
        select(value: string) { columns = value; return chain; },
        eq(key: string, value: unknown) { filters.push(item => item[key] === value); return chain; },
        not(key: string) { filters.push(item => item[key] != null); return chain; },
        lte(key: string, value: string) { filters.push(item => { const current = item[key]; return typeof current === "string" && current <= value; }); return chain; },
        order() { return chain; }, limit() { return chain; },
        update(value: Record<string, unknown>) { patch = value; return chain; },
        maybeSingle() { single = true; return chain; },
        then(resolve: (value: FakeResult) => unknown) {
          const source: FakeRow[] = table === "video_requests" ? [row] : paidStatus ? [{ project_id: row.id, idempotency_key: "existing-paid", status: paidStatus }] : [];
          const selected = source.filter(item => filters.every(filter => filter(item)));
          if (patch) for (const item of selected) { updates.push(patch); Object.assign(item, patch); }
          const projected = selected.map(item => columns === "*" ? { ...item } : Object.fromEntries(columns.split(",").map(key => [key, item[key]])));
          return Promise.resolve({ data: single ? projected[0] ?? null : projected, error: null }).then(resolve);
        },
      };
      return chain;
    },
  };
  return db;
}
async function enforced(fn: () => Promise<void>) {
  const before = process.env.SUPPLY_GUARD_ENFORCED;
  process.env.SUPPLY_GUARD_ENFORCED = "true";
  try { await fn(); } finally { if (before === undefined) delete process.env.SUPPLY_GUARD_ENFORCED; else process.env.SUPPLY_GUARD_ENFORCED = before; }
}
test("durable Long Form queue forwards the same duration-derived timeout, attempt and envelope", async () => enforced(async () => {
  for (const duration of [180, 600, 1200, 1800]) {
    const db = service(duration), dispatched: DispatchInput[] = [];
    assert.equal(await resumeSupplyQueue(db as never, async input => { dispatched.push(input); }, now), 1);
    assert.deepEqual(dispatched, [{ requestId: "request", renderAttempt: 2, mode: "long_form", longFormJobTimeoutMin: longFormRenderTimeout(duration).jobMinutes }]);
    assert.equal(dispatched[0].longFormJobTimeoutMin, duration === 180 ? 45 : longFormRenderTimeout(duration).jobMinutes);
    const reserve = db.calls.find(call => call.name === "pi_reserve_job_supply")!;
    assert.equal(reserve.args?.p_attempt, 2); assert.equal(reserve.args?.p_request_id, "request");
    assert.equal(db.row.render_attempts, 2); assert.equal(db.row.progress_stage, "queued");
    assert.equal(db.updates.length, 1);
    assert.equal(await resumeSupplyQueue(db as never, async () => { throw Error("duplicate dispatch"); }, now), 0);
  }
}));
test("invalid or missing documentary duration does not reserve, mutate progress, or dispatch", async () => enforced(async () => {
  for (const duration of [undefined, null, NaN, Infinity, 0, 179, 1801, "180"]) {
    const db = service(duration), before = JSON.stringify(db.row);
    assert.equal(await resumeSupplyRequest(db as never, "request", "owner", async () => { throw Error("must not dispatch"); }, now), "supply_unavailable");
    assert.equal(db.calls.length, 0); assert.equal(db.updates.length, 0); assert.equal(JSON.stringify(db.row), before);
  }
}));
test("owner resume keeps uncertain-call guard and visual dispatch retains its existing payload", async () => enforced(async () => {
  const blocked = service(180, "long_form", "SUBMITTED");
  assert.equal(await resumeSupplyRequest(blocked as never, "request", "owner", async () => { throw Error("must not dispatch"); }, now), "uncertain_paid_call");
  assert.equal(blocked.calls.length, 0); assert.equal(blocked.updates.length, 0);
  const ownerLong = service(180), ownerDispatch: DispatchInput[] = [];
  assert.equal(await resumeSupplyRequest(ownerLong as never, "request", "owner", async input => { ownerDispatch.push(input); }, now), "dispatched");
  assert.deepEqual(ownerDispatch, [{ requestId: "request", renderAttempt: 2, mode: "long_form", longFormJobTimeoutMin: 45 }]);
  const visual = service(undefined, "visual"), dispatched: DispatchInput[] = [];
  assert.equal(await resumeSupplyRequest(visual as never, "request", "owner", async input => { dispatched.push(input); }, now), "dispatched");
  assert.deepEqual(dispatched, [{ requestId: "request", renderAttempt: 2, mode: "visual" }]);
}));
