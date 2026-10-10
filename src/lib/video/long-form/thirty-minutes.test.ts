import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LONG_FORM_MAX_BEATS, narrationWordBudget } from "./duration-budget";
import { BeatFragmentSchema } from "./documentary-script";
import { LONG_FORM_OUTPUT_POLICY, renderMaxVideoKbps, storageCeilingBytes, decideOutputFit } from "./output-policy";
import { withHeartbeat } from "./produce";
import { pexelsFetch } from "@/lib/ai/footage";

const MiB = 1024 * 1024;

test("30 minutes: 20 beats of ~90 s (4500 words), every fragment index up to 19 is accepted", () => {
  const b = narrationWordBudget(1800);
  assert.equal(b.beats, 20);
  assert.equal(b.totalWords, 4500);
  assert.equal(b.wordsPerBeat, 225);
  assert.equal(LONG_FORM_MAX_BEATS, 20);
  assert.equal(narrationWordBudget(420).beats, 5, "short documentaries unchanged");
  const ok = BeatFragmentSchema.shape.index.safeParse(19);
  const over = BeatFragmentSchema.shape.index.safeParse(20);
  assert.ok(ok.success && !over.success);
});

test("30 minutes: the render bitrate keeps the delivered file under the demonstrated Storage ceiling (no 2-pass refit)", () => {
  const ceiling = storageCeilingBytes({});
  assert.equal(ceiling, 500 * MiB);
  const kbps = renderMaxVideoKbps(1800, ceiling);
  assert.ok(kbps >= LONG_FORM_OUTPUT_POLICY.minFitVideoKbps && kbps < 2200, `kbps=${kbps}`);
  const worstBytes = ((kbps + 192) * 1000 * 1800) / 8;
  assert.equal(decideOutputFit({ bytes: worstBytes, durationSeconds: 1800, ceilingBytes: ceiling }).action, "upload");
  assert.equal(renderMaxVideoKbps(300, ceiling), 5000, "short videos keep the full quality cap");
  assert.equal(storageCeilingBytes({ LONG_FORM_STORAGE_MAX_OBJECT_BYTES: String(900 * MiB) }), 900 * MiB, "a configured ceiling wins");
});

test("heartbeat: beats while long work runs and stops afterwards; a failing beat never fails the work", async () => {
  let beats = 0;
  const value = await withHeartbeat(() => { beats++; throw new Error("db down"); }, 10)(() => new Promise((r) => setTimeout(() => r(42), 55)));
  assert.equal(value, 42);
  assert.ok(beats >= 3, `beats=${beats}`);
  const after = beats;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(beats, after);
});

test("Pexels: a 429 waits until the reset window and retries instead of failing the production", async () => {
  const slept: number[] = [];
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) return new Response("", { status: 429, headers: { "x-ratelimit-reset": String(1000 + 120) } });
    return new Response(JSON.stringify({ videos: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const res = await pexelsFetch("https://api.pexels.com/videos/search?q=x", "k", { fetchImpl, now: () => 1_000_000, sleep: async (ms) => { slept.push(ms); } });
  assert.equal(res.ok, true);
  assert.equal(calls, 2);
  assert.equal(slept.reduce((a, b) => a + b, 0), 122_000, "waited until reset + 2 s, in heartbeat slices");
  assert.deepEqual(await res.json(), { videos: [] });
});

test("Pexels: a window longer than the limit fails cleanly; 5xx is retried", async () => {
  const far = (async () => new Response("", { status: 429, headers: { "retry-after": String(5 * 3600) } })) as unknown as typeof fetch;
  assert.equal((await pexelsFetch("u1", "k", { fetchImpl: far, sleep: async () => {} })).status, 429);
  let n = 0;
  const flaky = (async () => (++n < 2 ? new Response("", { status: 502 }) : new Response("{}", { status: 200 }))) as unknown as typeof fetch;
  assert.equal((await pexelsFetch("u2", "k", { fetchImpl: flaky, sleep: async () => {} })).ok, true);
});

test("form, server action and workflow allow 30-minute documentaries with enough time", () => {
  assert.match(readFileSync("src/app/dashboard/long-form/new/page.tsx", "utf8"), /max=\{30\}/);
  assert.match(readFileSync("src/app/dashboard/long-form/new/actions.ts", "utf8"), /MAX_DURATION_MINUTES = 30/);
  const wf = readFileSync(".github/workflows/render.yml", "utf8");
  assert.match(wf, /'long_form'\) && 330 \|\| 18/);
  assert.match(wf, /'long_form'\) && 300 \|\| 12/);
  assert.match(readFileSync("src/lib/video/long-form/durable-shot-assets.ts", "utf8"), /SIGNED_URL_TTL_SECONDS = 8 \* 60 \* 60/);
});
