// Readiness for real 15-minute Long Form productions (2026-10-23, job e8048599 «Leonidas vs Attila»).
// SIMULATED: provider responses and the database are fakes; nothing here contacts a provider or Supabase.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dropSceneStubs, parseVisualPlan } from "./documentary-script";
import { VisualPlanBlockedError } from "./json-response";
import { recraftProductionBlocker, recraftBlockedMessage } from "./recraft-readiness";
import { resumeConfirmation, resumeRefusal, resumeScriptJob, type ResumeRow } from "./script-job-resume";
import { reelVoiceChoices } from "@/lib/video/reel-voices";
import { inferTone } from "@/lib/providers/music/tone";
import type { AccountVoice } from "@/lib/podcast/voices";

const resp = (body: unknown) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(body) }] });
const scene = (i: number) => ({ description: `Spartan hoplites hold the pass at dawn ${i}`, motion: i % 2 === 0, subject: "hoplites", action: "marching",
  place: "Thermopylae", era: "480 BC", alternates: ["phalanx"], beatClass: "PLACE", impact: 2, impactReason: "sets the stakes", excerptId: `rev:b5:w${i * 4}` });
const STUB = { id: "s1_b" };                                   // exact shape of incident 150fb502 (one 4-char key value)
const opts = { cinematic: true, referenceContract: true, dropStubs: true };

test("150fb502 shape: 10 scenes with a {id} stub between two adjacent anchors parses into the 9 real scenes", () => {
  const visuals = [scene(0), STUB, ...Array.from({ length: 8 }, (_, i) => scene(i + 1))];
  const raw = { visuals };
  const frozen = structuredClone(raw);
  const out = parseVisualPlan(resp(raw), opts);
  assert.equal(out.visuals.length, 9);
  assert.ok(out.visuals.every(v => typeof v.description === "string"));
  assert.deepEqual(raw, frozen, "the saved response is not mutated");
});

test("all ten blocks: a stub at any position (start, middle, end) is removed when two real scenes remain", () => {
  for (let block = 0; block < 10; block++) {
    const n = 2 + (block % 9);                                   // 2..10 real scenes per block
    const real = Array.from({ length: n }, (_, i) => scene(i));
    for (const at of [0, Math.floor(n / 2), n]) {
      const visuals = [...real.slice(0, at), STUB, ...real.slice(at)];
      assert.equal(parseVisualPlan(resp({ visuals }), opts).visuals.length, n, `block ${block + 1}, stub at ${at}`);
    }
  }
});

test("block-5 shape is left untouched: with fewer than two real scenes the existing repair/blocking path runs", () => {
  const value = { visuals: [scene(0), STUB] };
  assert.equal(dropSceneStubs(value), value);
  assert.throws(() => parseVisualPlan(resp(value), opts), VisualPlanBlockedError);
});

test("malformed scenes are never removed: any scene field keeps the entry and the block still blocks", () => {
  for (const bad of [{ id: "x", description: 5 }, { description: "only a description" }, { excerptId: "rev:b5:w0" }, "a string entry", null, ["array"],
    { note: "Spartans brace behind their shields" }, { UNKNOWN_SYNTHETIC_KEY: "unknown data" }, { id: "x", extra: { nested: true } }]) {
    const visuals = [scene(0), bad, scene(1), scene(2)];
    assert.throws(() => parseVisualPlan(resp({ visuals }), opts), VisualPlanBlockedError, JSON.stringify(bad));
  }
  assert.throws(() => parseVisualPlan(resp({ visuals: [STUB, STUB] }), opts), VisualPlanBlockedError, "stubs only: no scene at all");
});

test("stub removal is idempotent and counts multiple stubs", () => {
  const once = dropSceneStubs({ visuals: [STUB, scene(0), { note: "" }, { ref: 7, flag: true }, scene(1), scene(2)] }) as { visuals: unknown[] };
  assert.equal(once.visuals.length, 3);
  assert.equal(dropSceneStubs(once), once);
});

test("Recraft cannot be locked in while it cannot start (closed policy, no fal balance key, red balance)", async () => {
  const svc = (state: unknown, error: unknown = null) => ({ rpc: async () => ({ data: state, error }) }) as never;
  const env = { FAL_ADMIN_KEY: "admin" };
  assert.match(String(await recraftProductionBlocker(svc({ level: "UNKNOWN", reason: "policy unconfigured" }), env)), /límites de gasto/);
  assert.match(String(await recraftProductionBlocker(svc({ level: "GREEN" }), {})), /fal\.ai/);
  assert.match(String(await recraftProductionBlocker(svc({ level: "GREEN" }), { FAL_KEY: "api only" })), /fal\.ai/);
  assert.match(String(await recraftProductionBlocker(svc(null, { message: "x" }), env)), /control/);
  assert.match(String(await recraftProductionBlocker(svc({ level: "RED" }), env)), /saldo/);
  assert.equal(await recraftProductionBlocker(svc({ level: "UNKNOWN", reason: "balance unverified or stale" }), env), null, "a stale balance is refreshed at start");
  assert.equal(await recraftProductionBlocker(svc({ level: "YELLOW" }), env), null);
  assert.match(recraftBlockedMessage("x"), /No se confirmó ni cobró nada/);
});

const voice = (voiceId: string, category: string, language = "en", name = voiceId): AccountVoice =>
  ({ voiceId, name, language, category, previewUrl: `https://example.test/${voiceId}.mp3`, accent: null, gender: null, isOwner: false });

test("the Thermopylae narrator (David, professional library voice) is offered even with many premade voices", () => {
  const premade = ["Adam00000", "Alice0000", "Bella0000", "Brian0000", "Charlie00"].map(id => voice(id, "premade"));
  const choices = reelVoiceChoices([...premade, voice("cCYjmrGZaI86GUJ7F2Nn", "professional", "en", "David - Audiobook & Documentary")], "en", "uYlzyj2kIZo3HfBB21vF");
  const david = choices.find(c => c.voiceId === "cCYjmrGZaI86GUJ7F2Nn");
  assert.ok(david); assert.equal(david!.kind, "library");
  assert.equal(choices.filter(c => c.kind === "stock").length, 3, "the premade cap is unchanged");
  const other = reelVoiceChoices([voice("SomeLib0001", "professional")], "en", "x");
  assert.equal(other.length, 0, "an unapproved library voice is still not offered");
  const owned = reelVoiceChoices([{ ...voice("cCYjmrGZaI86GUJ7F2Nn", "cloned"), isOwner: true }], "en", "x");
  assert.equal(owned.length, 0, "a private clone with that id still needs an explicit grant");
});

test("a battle documentary gets a cinematic music tone", () => {
  assert.equal(inferTone({ style: "documental", topic: "LEONIDAS vs ATTILA: THE BATTLE THAT NEVER HAPPENED", scriptText: "Two armies, one empire" })[0], "cinematic");
  assert.equal(inferTone({ style: "documental", topic: "La guerra que nunca ocurrió" })[0], "cinematic");
  assert.deepEqual(inferTone({ topic: "toward the warmth" }), ["reflective"], "no substring false positives");
});

const row = (over: Partial<ResumeRow> = {}): ResumeRow => ({ id: "e8048599-0000-4000-8000-000000000000", status: "failed", failure_kind: "technical", error_code: "150fb502",
  retry_count: 3, run_token: null, updated_at: "2026-10-23T19:13:36.643Z", editorial_checkpoint: { pass: 1 }, ...over });
const req = { jobId: "e8048599-0000-4000-8000-000000000000", expectedErrorCode: "150fb502", expectedRetryCount: 3, confirm: "RESUME-e8048599" };

test("owner resume is fail-closed: exact code, retry count, confirmation, failed+technical, checkpoint, no live run", () => {
  assert.equal(resumeConfirmation(req.jobId), "RESUME-e8048599");
  assert.equal(resumeRefusal(req, row()), null);
  for (const [over, r] of [[{ status: "running" }, req], [{ failure_kind: "editorial" }, req], [{ error_code: "other" }, req], [{ retry_count: 2 }, req],
    [{ run_token: "t" }, req], [{ editorial_checkpoint: null }, req], [{}, { ...req, confirm: "yes" }], [{}, { ...req, jobId: "nope" }]] as const)
    assert.ok(resumeRefusal(r as typeof req, row(over as Partial<ResumeRow>)), JSON.stringify(over));
  assert.ok(resumeRefusal(req, null));
});

test("owner resume requeues once with compare-and-swap and keeps retry_count", async () => {
  let current = row(); const patches: Record<string, unknown>[] = [];
  const svc = { from: () => {
    const q: Record<string, unknown> & { filters: [string, unknown][]; patch?: Record<string, unknown> } = { filters: [] } as never;
    const api = {
      select: () => api, eq: (k: string, v: unknown) => { q.filters.push([k, v]); return api; },
      maybeSingle: async () => ({ data: current, error: null }),
      update: (p: Record<string, unknown>) => { q.patch = p; return api; },
      then: (resolve: (v: unknown) => void) => {
        const match = q.filters.every(([k, v]) => (current as never)[k] === v);
        if (q.patch && match) { patches.push(q.patch); current = { ...current, ...q.patch } as ResumeRow; resolve({ data: [{ id: current.id }], error: null }); }
        else resolve({ data: [], error: null });
      },
    };
    return api;
  } } as never;
  assert.deepEqual(await resumeScriptJob(svc, req), { ok: true });
  assert.equal(current.status, "queued"); assert.equal(current.retry_count, 3);
  assert.equal(patches.length, 1); assert.ok(!("retry_count" in patches[0]));
  const again = await resumeScriptJob(svc, req);
  assert.equal(again.ok, false, "a second resume is refused: the job is no longer failed");
});

test("without stub removal (repair-first path) the stub still blocks, so the #193 scene repair runs first", () => {
  const visuals = [scene(0), STUB, ...Array.from({ length: 8 }, (_, i) => scene(i + 1))];
  assert.throws(() => parseVisualPlan(resp({ visuals }), { cinematic: true, referenceContract: true }), VisualPlanBlockedError);
});
