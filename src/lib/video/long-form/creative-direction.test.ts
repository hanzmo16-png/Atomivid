import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { creativeDirectionIssues, narrativeTiming } from "./creative-direction";
import { loadCreativeHistory, summarizeCreativeHistory } from "./creative-history";
import { editorialFixture, passingReview } from "./editorial.test-fixtures";
import { generateDocumentaryScript } from "./documentary-script";
import { editorialApprovalError, type EditorialReport } from "./editorial";

const input = { researchPack: { topic: "Evidence behind a legend", sources: [{ id: "s1", title: "Archive", kind: "primary" as const }], openQuestions: [] },
  targetDurationSeconds: 180, mode: "curiosity_documentary" as const };

test("seven genuinely different proposals must produce three distinct finalists and a valid choice", () => {
  const s = editorialFixture();
  assert.deepEqual(creativeDirectionIssues(s.creativeDirection, s.beats), []);
  for (const change of [
    (d: typeof s.creativeDirection) => { d.finalists = [1, 1, 4]; },
    (d: typeof s.creativeDirection) => { d.chosenAngle = 0; },
    (d: typeof s.creativeDirection) => { d.angles.forEach(a => { a.device = "timeline"; }); },
    (d: typeof s.creativeDirection) => { d.angles[1].premise = d.angles[0].premise; },
  ]) { const d = structuredClone(s.creativeDirection); change(d); assert.ok(creativeDirectionIssues(d, s.beats).length); }
});

test("production markers, invented edit quotes and CTA outside closing cannot pass even a lenient critic", () => {
  const s = editorialFixture();
  let d = structuredClone(s.creativeDirection);
  d.signatureDetail.quote = "This never appeared anywhere";
  assert.ok(creativeDirectionIssues(d, s.beats).length);
  d = structuredClone(s.creativeDirection); d.closingCta = d.signatureDetail;
  assert.ok(creativeDirectionIssues(d, s.beats).some(i => i.includes("CTA")));
  s.beats[0].narration += " [VERIFICAR]";
  assert.ok(creativeDirectionIssues(s.creativeDirection, s.beats).some(i => i.includes("marcadores")));
});

test("creative weaknesses share the existing single correction budget and receive a fresh review", async () => {
  const bad = editorialFixture(), good = editorialFixture(); bad.creativeDirection.chosenAngle = 0;
  let writes = 0, reads = 0, report!: EditorialReport;
  await generateDocumentaryScript({ ...input,
    parse: async ({ system, prompt }) => { writes++; assert.match(system, /test del clon/);
      if (writes === 2) assert.match(prompt, /tres finalistas/); return writes === 1 ? bad : good; },
    review: async ({ prompt, system }) => { reads++; const p = JSON.parse(prompt);
      assert.equal(p.timingEstimate[4].estimatedEndSeconds, 180); assert.match(system, /template_clone/);
      return passingReview(p.script); }, onEditorialApproved: r => { report = r; } });
  assert.equal(writes, 2); assert.equal(reads, 2);
  assert.equal(report.version, "editorial-v2"); assert.equal(report.historyCount, 0);
  assert.equal(editorialApprovalError({ beats: good.beats, editorial: report }), null);
  const missing = { ...report, creativeDirection: undefined };
  assert.ok(editorialApprovalError({ beats: good.beats, editorial: missing }));
  assert.equal(editorialApprovalError({ beats: good.beats, editorial: { ...missing, version: "editorial-v1" } }), null);
});

test("semantic clone or dishonest-title findings from critic block after two attempts, with no extra calls", async () => {
  for (const kind of ["template_clone", "packaging_mismatch", "engagement_bait"] as const) {
    const s = editorialFixture(); let calls = 0;
    const review = passingReview(s);
    review.findings.push({ kind, severity: "blocking", evidence: [review.sections[0]], explanation: "Material problem", repair: "Change the promise and scene" });
    await assert.rejects(generateDocumentaryScript({ ...input, parse: async () => { calls++; return s; }, review: async () => review }), /Material problem/);
    assert.equal(calls, 2);
  }
});

test("history never invents predecessors; actual previous opening cannot be copied verbatim", () => {
  const s = editorialFixture(), d = structuredClone(s.creativeDirection);
  d.avoidedPatterns = ["A", "B", "C"];
  assert.ok(creativeDirectionIssues(d, s.beats).some(i => i.includes("inventes")));
  const history = [{ topic: "Prior", opening: s.beats[0].narration, ending: "end", structure: [] }];
  assert.ok(creativeDirectionIssues(d, s.beats, history).some(i => i.includes("literalmente")));
  assert.ok(creativeDirectionIssues(s.creativeDirection, s.beats, history).some(i => i.includes("tres patrones")));
});

test("writer and critic receive the same bounded account history, with no new provider stage", async () => {
  const s = editorialFixture(); s.creativeDirection.avoidedPatterns = ["Same opening", "Repeated mystery", "Generic CTA"];
  const history = [{ topic: "Previous subject", opening: "A different scene", ending: "An ending", device: "timeline", structure: ["Before", "After"] }];
  let writes = 0, reads = 0, report!: EditorialReport;
  await generateDocumentaryScript({ ...input, creativeHistory: history,
    parse: async ({ prompt }) => { writes++; assert.ok(prompt.includes("Previous subject")); return s; },
    review: async ({ prompt }) => { reads++; assert.deepEqual(JSON.parse(prompt).creativeHistory, history); return passingReview(s); },
    onEditorialApproved: r => { report = r; } });
  assert.equal(writes, 1); assert.equal(reads, 1); assert.equal(report.historyCount, 1);
  assert.equal(editorialApprovalError({ beats: s.beats, editorial: report }), null);
});

test("account memory is scoped before reading and stops before spending when unavailable", async () => {
  const ops: unknown[][] = [];
  const q = { select: (s: string) => { ops.push(["select", s]); return q; }, eq: (k: string, v: string) => { ops.push(["eq", k, v]); return q; },
    order: (k: string, v: unknown) => { ops.push(["order", k, v]); return q; }, limit: async (n: number) => { ops.push(["limit", n]); return { data: [], error: null }; } };
  const client = { from: (name: string) => { ops.push(["from", name]); return q; } } as unknown as SupabaseClient;
  assert.deepEqual(await loadCreativeHistory(client, "authenticated-owner"), []);
  assert.ok(ops.some(o => JSON.stringify(o) === JSON.stringify(["eq", "user_id", "authenticated-owner"])));
  assert.deepEqual(ops.at(-1), ["limit", 5]);
  await assert.rejects(loadCreativeHistory(client, ""), /sesión válida/);
  q.limit = async () => ({ data: [], error: { message: "database unavailable" } } as never);
  await assert.rejects(loadCreativeHistory(client, "authenticated-owner"), /No se inició/);
});

test("history is compact and strips unrelated private properties; times are computed, never guessed", () => {
  const s = editorialFixture();
  const row = { topic: "topic", script_json: { topic: "topic", beats: s.beats.map((b, i) => ({ ...b, id: String(i) })), secret: "do not include" }, email: "private@example.com" };
  const memory = summarizeCreativeHistory(Array.from({ length: 9 }, () => row));
  assert.equal(memory.length, 5);
  assert.ok(!JSON.stringify(memory).includes("private@example.com"));
  assert.ok(!JSON.stringify(memory).includes("do not include"));
  assert.ok(memory.every(h => h.opening.length <= 650 && h.ending.length <= 450));
  assert.equal(narrativeTiming(s.beats).at(-1)?.estimatedEndSeconds, 180);
});
