// Re-audit of PR #191 at ed7afd4 (copied into a throw-away worktree by the audit workflow; never committed
// to the PR). Verifies the fixes for ALTO-1, ALTO-2, MEDIO-1 and MEDIO-2. No provider calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { stableHash } from "@/lib/production-intelligence/canonical";
import { narrationCatalog } from "./narration-catalog";
import { editorialBlockers, type EditorialScript } from "./editorial";
import { openingEvidence, validateOrRepairOpeningReview } from "./editorial-opening-repair";
import { DocumentaryResponseError, validateDocumentaryValue } from "./json-response";
import { normalizeToContract } from "./response-normalizer";
import { scriptFailureKind, retryPatch } from "./script-jobs";
import { applyVisualAnchorRepair } from "./visual-anchor-repair";
import { applyFunctionRepair, sectionFunctionRepairTargets } from "./editorial-function-repair";
import { parseVisualPlan } from "./documentary-script";

function scenario(beats = 10, firstWords = 230) {
  const narration = (b: number, n: number) => Array.from({ length: n }, (_, i) => `w${b}x${i}`).join(" ");
  const bs = Array.from({ length: beats }, (_, i) => ({ type: "discovery", purpose: `p${i}`, claims: [], narration: narration(i, i === 0 ? firstWords : 200) }));
  const script = { beats: bs, storyPlan: { centralQuestion: "q", openingPromise: "p", firstAnswer: "a", endingAnswer: "e", sections: [] } } as unknown as EditorialScript;
  const cat = narrationCatalog(bs), first = (i: number) => cat.find(e => e.beatIndex === i)!.id;
  const late = cat.find(e => e.beatIndex === 0 && Number(e.id.split(":w")[1]) > 160)!;
  const raw = { sections: bs.map((_, i) => ({ excerptId: first(i), contribution: `c${i}`, function: i === beats - 1 ? "resolution" : "new_information" })),
    firstAnswer: { delivered: true, evidence: { excerptId: late.id }, explanation: "x" }, ending: { resolvesPromise: true, evidence: { excerptId: first(beats - 1) }, explanation: "e" }, findings: [] };
  return { script, raw, eligible: openingEvidence(bs), late, cat };
}
const resp = (body: unknown, stop = "end_turn") => ({ stop_reason: stop, content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }] });
const run = (s: ReturnType<typeof scenario>, body: unknown, stop?: string) => validateOrRepairOpeningReview({ rawReview: s.raw, script: s.script, model: "t", send: async () => resp(body, stop) });

test("R-A2 (ALTO-1) contradictory verdicts inside evidence are rejected, never normalised into an approval", async () => {
  const s = scenario(), id = s.eligible[0].id;
  const variants = [
    { delivered: true, evidence: { excerptId: id, delivered: false }, explanation: "ok" },
    { delivered: true, evidence: { excerptId: id, delivered: "false" }, explanation: "ok" },
    { delivered: true, evidence: { excerptId: id, explanation: "No concrete reward appears before word 150" }, explanation: "ok" },
    { delivered: true, evidence: { excerptId: id, verdict: "not delivered" }, explanation: "ok" },
    { delivered: true, evidence: { excerptId: id, delivered: true }, explanation: "ok" },          // redundant but not verified: still technical
    { delivered: true, evidence: { excerptId: id, quote: "text that is not the excerpt" }, explanation: "ok" },
    { delivered: true, evidence: { excerptId: id, beatIndex: 3 }, explanation: "ok" },
    { delivered: true, evidence: { excerptId: id }, explanation: "ok", findings: [] },
  ];
  for (const fa of variants) {
    const err = await run(s, { firstAnswer: fa }).then(() => null, e => e);
    assert.ok(err instanceof DocumentaryResponseError, `must reject: ${JSON.stringify(fa.evidence)}`);
    assert.equal(scriptFailureKind(err), "technical");
  }
});

test("R-A2b verified echoes of the excerpt (same quote, same block) and blank keys are the only accepted extras", async () => {
  const s = scenario(), e = s.eligible[0];
  const ok = await run(s, { firstAnswer: { delivered: true, evidence: { excerptId: e.id, quote: e.quote, beatIndex: e.beatIndex, explanation: "" }, explanation: "ok" } });
  assert.equal(ok.firstAnswer.delivered, true);
  assert.equal(ok.firstAnswer.evidence.quote, e.quote);
  const incident = await run(s, { firstAnswer: { delivered: true, evidence: { excerptId: e.id, explanation: "" }, explanation: "x".repeat(565) } });
  assert.equal(incident.firstAnswer.delivered, true, "incident 23d86d0a shape is accepted");
});

test("R-ALTO-2 technical failures stay technical (no paid editorial correction); content outcomes stay editorial", async () => {
  const s = scenario();
  for (const [body, stop] of [["not json", undefined], [{ firstAnswer: { delivered: true } }, "max_tokens"], ["Sure! {}", undefined], [{}, undefined],
    [{ firstAnswer: { delivered: "true", evidence: { excerptId: s.eligible[0].id }, explanation: "y" } }, undefined]] as const) {
    const err = await run(s, body, stop).then(() => null, e => e);
    assert.ok(err instanceof DocumentaryResponseError);
    assert.equal(scriptFailureKind(err), "technical");
    assert.deepEqual(retryPatch({ status: "failed", failure_kind: "technical", retry_count: 0, editorial_rounds: 0, resubmit_allowance: 0 }), { retry_count: 1 }, "retry, not an editorial round");
  }
  for (const id of [s.late.id, "invented:b0:w1"]) {
    const out = await run(s, { firstAnswer: { delivered: true, evidence: { excerptId: id }, explanation: "claims early reward" } });
    assert.equal(out.firstAnswer.delivered, false); assert.ok(editorialBlockers(out).length > 0);
  }
  const own = await run(s, { firstAnswer: { delivered: false, evidence: { excerptId: s.late.id }, explanation: "Model's own reason" } });
  assert.equal(own.firstAnswer.explanation, "Model's own reason");
});

test("R-A13 (MEDIO-1) the four validators accept a blank extra key and still reject informative ones", () => {
  const catalog = [{ id: "r:b0:w0", beatIndex: 0, quote: "one two three four five" }, { id: "r:b0:w5", beatIndex: 0, quote: "six seven eight nine ten" }];
  const raw = { visuals: [{ excerptId: "missing", description: "a" }, { excerptId: "r:b0:w5", description: "b" }] };
  assert.equal(applyVisualAnchorRepair(raw, catalog, [0], { replacements: [{ index: 0, excerptId: "r:b0:w0", reason: "" }] }).visuals[0].excerptId, "r:b0:w0");
  assert.throws(() => applyVisualAnchorRepair(raw, catalog, [0], { replacements: [{ index: 0, excerptId: "r:b0:w0", reason: "better" }] }));
  const review = { sections: [{ function: "setup" }, { function: "bogus" }] };
  assert.throws(() => applyFunctionRepair(review, [1], { replacements: [{ path: "sections/1/function", function: "setup", note: "x" }] }));
  const fixed = applyFunctionRepair(review, [1], { replacements: [{ path: "sections/1/function", function: "consequence", note: "" }] }) as typeof review;
  assert.equal(fixed.sections[1].function, "consequence");
  const plan = (scene: Record<string, unknown>) => resp({ visuals: [scene, { ...scene }] });
  const scene = { description: "a dated archive page", motion: false, excerptId: "r:b0:w0", searchQueries: [] };
  assert.doesNotThrow(() => parseVisualPlan(plan({ ...scene, note: null }), { cinematic: false, referenceContract: true }));
  const strict = z.object({ a: z.string() }).strict();
  assert.ok(sectionFunctionRepairTargets({ a: "x", b: "" }, strict) === null, "blank key alone is not a repair target");
});

test("R-MEDIO-2/idempotency the opening-repair request is byte-identical to production for the same input", async () => {
  const s = scenario(); let seen: unknown;
  await run(s, { firstAnswer: { delivered: true, evidence: { excerptId: s.eligible[0].id }, explanation: "ok" } }).catch(() => {});
  await validateOrRepairOpeningReview({ rawReview: s.raw, script: s.script, model: "claude-sonnet-5", send: async (p) => { seen = p; return resp({ firstAnswer: { delivered: true, evidence: { excerptId: s.eligible[0].id }, explanation: "ok" } }); } });
  console.log("RA_FINGERPRINT", stableHash(seen, 16));
});

test("R-A5 normalisation is idempotent, non-mutating, prototype-safe", () => {
  const schema = z.object({ e: z.object({ excerptId: z.string() }).strict() }).strict();
  const raw = JSON.parse('{"e":{"excerptId":"id","note":""},"__proto__":""}'); const frozen = structuredClone(raw);
  const once = normalizeToContract(schema, raw), twice = normalizeToContract(schema, once.value);
  assert.deepEqual(raw, frozen); assert.deepEqual(once.value, twice.value); assert.equal(twice.actions.length, 0);
  assert.equal(({} as Record<string, unknown>).note, undefined);
  assert.throws(() => validateDocumentaryValue(schema, { e: { excerptId: "id", note: "content" } }), DocumentaryResponseError);
});

test("R-A11 retry after interruption reuses the committed response: one paid call", async () => {
  const s = scenario(); const ledger = new Map<string, ReturnType<typeof resp>>(); let paid = 0, crash = true;
  const send = async (p: Record<string, unknown>) => { const k = stableHash(p, 16);
    if (!ledger.has(k)) { paid++; ledger.set(k, resp({ firstAnswer: { delivered: true, evidence: { excerptId: s.eligible[0].id, explanation: "" }, explanation: "ok" } })); }
    if (crash) { crash = false; throw new Error("interrupted"); } return ledger.get(k)!; };
  await assert.rejects(validateOrRepairOpeningReview({ rawReview: s.raw, script: s.script, model: "t", send: send as never }));
  const a = await validateOrRepairOpeningReview({ rawReview: s.raw, script: s.script, model: "t", send: send as never });
  const b = await validateOrRepairOpeningReview({ rawReview: s.raw, script: s.script, model: "t", send: send as never });
  assert.equal(paid, 1); assert.deepEqual(a, b);
});
