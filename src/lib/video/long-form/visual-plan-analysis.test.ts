import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseVisualPlan, ProductBeatVisualsSchema, ProductReferencedVisualsSchema, VisualSchema } from "./documentary-script";
import { VisualPlanBlockedError, jsonResponseSystem, sceneShapes } from "./json-response";
import { VISUAL_DIAGNOSTIC_KEYS } from "./documentary-script";
import { narrationCatalog } from "./narration-catalog";
import { analyzeVisualPlan, AnalyzerInputError } from "./visual-plan-analysis";
import { runAnalyzer, runAnalyzerCli } from "../../../../scripts/analyze-visual-plan";

// Synthetic fixtures only; SECRET marks text that must never appear in diagnostics.
const beats = [
  { narration: "SECRET alpha one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree." },
  { narration: "SECRET beta canal workers dug through the mountain for years while disease spread through camps." },
];
const catalog = narrationCatalog(beats).filter(e => e.beatIndex === 0);
const scene = (excerptId: string, extra: Record<string, unknown> = {}) => ({ description: "SECRET workers digging a canal", motion: true, subject: "workers", excerptId, ...extra });
const message = (value: unknown) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(value) }] });
const product = { cinematic: false, referenceContract: true };
const blocked = (value: unknown, opts = product) => {
  try { parseVisualPlan(message(value), opts); }
  catch (error) { assert(error instanceof VisualPlanBlockedError); return error; }
  assert.fail("expected an explicit block");
};
const noSecret = (x: unknown) => assert(!JSON.stringify(x).includes("SECRET"), "diagnostics must not carry narration or scene text");

test("12 scenes with 10 malformed and 2 valid is blocked, never approved on the 2 survivors", () => {
  const visuals = [scene(catalog[0].id), scene(catalog[1].id), ...Array.from({ length: 10 }, () => ({ excerptId: catalog[0].id, motion: "yes" }))];
  const error = blocked({ visuals });
  assert.equal(error.shapes.length, 12);
  assert.deepEqual(analyzeVisualPlan(message({ visuals }), beats, 0, product).invalidScenes, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.match(error.shapes[2], /^2\{excerptId:string,motion:string\}$/);
  assert(error.issues.some(i => i.startsWith("invalid_type@visuals.2.")));
  noSecret([error.message, error.issues, error.shapes]);
});

test("duplicate anchors cannot hide a lost scene: blocked, and the analyzer shows duplicates and uncovered excerpts", () => {
  const visuals = [scene(catalog[0].id), scene(catalog[0].id), { excerptId: catalog[1].id, motion: false, subject: "map" }];
  blocked({ visuals });
  const report = analyzeVisualPlan(message({ visuals }), beats, 0, product);
  assert.equal(report.schema, "invalid");
  assert.deepEqual(report.duplicateExcerptIds, [catalog[0].id]);
  assert.deepEqual(report.invalidScenes, [2]);
  // The malformed scene's anchor is NOT coverage: its excerpt is reported as lost.
  assert(report.uncoveredExcerptIds.includes(catalog[1].id));
  assert.equal(report.coveredExcerpts, 1);
  assert.equal(report.scenes, 3);
  noSecret(report);
});

test("absent, null and wrong-type required fields are blocked, never defaulted", () => {
  for (const [key, bad] of [["description", undefined], ["description", null], ["description", 7], ["motion", undefined], ["motion", null], ["motion", "true"], ["subject", undefined], ["subject", null], ["subject", ["x"]], ["excerptId", null], ["excerptId", 3]] as const) {
    const broken: Record<string, unknown> = scene(catalog[1].id);
    if (bad === undefined) delete broken[key]; else broken[key] = bad;
    const error = blocked({ visuals: [scene(catalog[0].id), broken] });
    assert(error.issues.some(i => i.endsWith(`@visuals.1.${key}`)), `${key}=${String(bad)} → ${error.issues}`);
    noSecret([error.message, error.issues, error.shapes]);
  }
  for (const value of [{}, { visuals: null }, { visuals: "x" }, null]) noSecret(blocked(value).shapes);
  assert.deepEqual(sceneShapes({ visuals: null }, VISUAL_DIAGNOSTIC_KEYS), ["visuals:null"]);
});

test("a valid block is returned intact, without added or removed scenes or fields", () => {
  const visuals = [scene(catalog[0].id), scene(catalog[1].id, { era: "1900s", alternates: ["canal dig"] })];
  assert.deepEqual(parseVisualPlan(message({ visuals }), product).visuals, visuals);
  const report = analyzeVisualPlan({ visuals }, beats, 0, product);
  assert.equal(report.schema, "valid");
  assert.equal(report.editorialApproval, "not_evaluated");
  assert.deepEqual(report.issues, []);
  assert.equal(report.anchors.every(a => a.excerptId === "resolved"), true);
});

test("the only normalization is the pre-existing Cinematic V6 drop of invalid OPTIONAL fields; required fields still block", () => {
  const ok = parseVisualPlan(message({ visuals: [scene(catalog[0].id, { beatClass: "NOPE" }), scene(catalog[1].id)] }), { cinematic: true, referenceContract: true });
  assert.equal("beatClass" in ok.visuals[0], false);
  blocked({ visuals: [scene(catalog[0].id, { motion: null }), scene(catalog[1].id)] }, { cinematic: true, referenceContract: true });
});

test("prompt contracts are unchanged (cache identity of saved operations)", () => {
  const h = (s: z.ZodType) => createHash("sha256").update(jsonResponseSystem("X", s)).digest("hex").slice(0, 16);
  assert.deepEqual({ p: h(ProductBeatVisualsSchema), r: h(ProductReferencedVisualsSchema), v: h(VisualSchema) },
    { p: "fe5b4672cc554018", r: "a3777f2b4959f40b", v: "ec9b5852bb001c7b" });
});

test("offline analyzer: no network/provider call, inputs untouched, no narration in output", () => {
  const dir = mkdtempSync(join(tmpdir(), "vpa-"));
  const responsePath = join(dir, "op.script.json"), narrationPath = join(dir, "beats.json");
  writeFileSync(responsePath, JSON.stringify(message({ visuals: [scene(catalog[0].id), { excerptId: catalog[1].id }] })));
  writeFileSync(narrationPath, JSON.stringify({ beats }));
  const before = [responsePath, narrationPath].map(p => [readFileSync(p).toString("hex"), statSync(p).mtimeMs]);
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("network forbidden"); }) as typeof fetch;
  try {
    const out = runAnalyzer({ response: responsePath, narration: narrationPath, beat: 0 });
    assert.equal(out.schema, "invalid");
    assert.equal(out.inputs.response.sha256.length, 64);
    noSecret(out);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(calls, 0);
  assert.deepEqual([responsePath, narrationPath].map(p => [readFileSync(p).toString("hex"), statSync(p).mtimeMs]), before);
});

const SECRET_KEYS = ["SECRET_NARRATION_SYNTHETIC", "SECRET line one\nSECRET line two", "SECRET".padEnd(100_000, "x")];
const bounded = (x: unknown) => { noSecret(x); assert(JSON.stringify(x).length < 4000, "diagnostic must stay bounded"); };

test("R1: unknown keys are never echoed (narrative text, newlines, 100k chars): counted by type under a fixed label", () => {
  const visuals = [Object.fromEntries([...SECRET_KEYS.map(k => [k, null] as const), ["motion", null]]), scene(catalog[1].id)];
  const error = blocked({ visuals });
  assert.equal(error.shapes[0], "0{motion:null,other:null*3}");
  bounded([error.message, error.issues, error.shapes]);
  bounded(analyzeVisualPlan(message({ visuals }), beats, 0, product));
  // Unknown keys alongside a VALID scene keep it valid (lenient schema strips them) and stay unnamed.
  const ok = analyzeVisualPlan(message({ visuals: [scene(catalog[0].id, { [SECRET_KEYS[1]]: "SECRET" }), scene(catalog[1].id)] }), beats, 0, product);
  assert.equal(ok.schema, "valid");
  assert.match(ok.shapes[0], /other:string\*1}$/);
  bounded(ok);
});

test("R1: scene count, issues and output are bounded with counters for what was omitted", () => {
  const visuals = Array.from({ length: 5000 }, () => ({ [SECRET_KEYS[0]]: 1, motion: "SECRET" }));
  const error = blocked({ visuals });
  assert.equal(error.shapes.length, 13);
  assert.equal(error.shapes[12], "omitted_scenes:4988");
  assert(error.issues.at(-1)!.startsWith("omitted_issues:"));
  bounded([error.message, error.issues, error.shapes]);
  const report = analyzeVisualPlan(message({ visuals }), beats, 0, product);
  assert.equal(report.omittedScenes, 4988);
  assert.equal(report.invalidSceneCount, 5000);
  assert.equal(report.anchors.length, 12);
  bounded(report);
});

test("R1: other error routes carry fixed text only", () => {
  for (const response of [{ stop_reason: "max_tokens", content: [] }, { stop_reason: "end_turn", content: [{ type: "text", text: "SECRET not json {" }] }, { stop_reason: "refusal", content: [{ type: "text", text: "SECRET" }] }]) {
    assert.throws(() => parseVisualPlan(response, product), (e: Error) => (noSecret([e.message, (e as { issues?: unknown }).issues]), true));
    const report = analyzeVisualPlan(response, beats, 0, product);
    assert.equal(report.schema, "invalid");
    noSecret(report);
  }
  assert.equal([...VISUAL_DIAGNOSTIC_KEYS].every(k => /^[a-zA-Z]{1,20}$/.test(k)), true);
});

test("R2: invalid beat indices, beats and JSON are rejected with fixed codes, never accepted", () => {
  const ok = message({ visuals: [scene(catalog[0].id), scene(catalog[1].id)] });
  for (const beat of [-1, 2, 99, 1.5, NaN]) assert.throws(() => analyzeVisualPlan(ok, beats, beat, product), (e: unknown) => e instanceof AnalyzerInputError && e.code === "beat_out_of_range");
  for (const bad of [[], {}, { beats: "SECRET" }, [{ narration: 7 }], [{ narration: "SECRET two words" }], [null], "SECRET"])
    assert.throws(() => analyzeVisualPlan(ok, bad, 0, product), (e: unknown) => e instanceof AnalyzerInputError && e.code === "narration_invalid" && !e.message.includes("SECRET"));
  const dir = mkdtempSync(join(tmpdir(), "vpa-"));
  const files = { good: join(dir, "r.json"), beats: join(dir, "b.json"), badJson: join(dir, "x.json"), badBeats: join(dir, "y.json"), huge: join(dir, "h.json") };
  writeFileSync(files.good, JSON.stringify(ok)); writeFileSync(files.beats, JSON.stringify(beats));
  writeFileSync(files.badJson, "{\"SECRET\": unterminated"); writeFileSync(files.badBeats, JSON.stringify({ beats: [{ narration: "SECRET" }] }));
  writeFileSync(files.huge, JSON.stringify({ pad: "SECRET".repeat(400_000) }));
  const before = Object.values(files).map(p => [readFileSync(p).toString("hex"), statSync(p).mtimeMs]);
  const cli = (...a: string[]) => runAnalyzerCli(a);
  const cases: Array<[string[], string]> = [
    [["--response", files.good, "--narration", files.beats, "--beat", "-1"], "beat_out_of_range"],
    [["--response", files.good, "--narration", files.beats, "--beat", "2"], "beat_out_of_range"],
    [["--response", files.badJson, "--narration", files.beats, "--beat", "0"], "response_invalid"],
    [["--response", files.huge, "--narration", files.beats, "--beat", "0"], "response_invalid"],
    [["--response", join(dir, "missing-SECRET.json"), "--narration", files.beats, "--beat", "0"], "response_invalid"],
    [["--response", files.good, "--narration", files.badJson, "--beat", "0"], "narration_invalid"],
    [["--response", files.good, "--narration", files.badBeats, "--beat", "0"], "narration_invalid"],
    [["--response", files.good, "--beat", "0"], "usage"],
  ];
  for (const [args, code] of cases) {
    const out = cli(...args);
    assert.equal(out.exitCode, 2, code);
    assert.deepEqual(JSON.parse(out.output), { error: code });
  }
  assert.equal(JSON.parse(cli("--response", files.good, "--narration", files.beats, "--beat", "0").output).schema, "valid");
  assert.deepEqual(Object.values(files).map(p => [readFileSync(p).toString("hex"), statSync(p).mtimeMs]), before);
});

test("R2: schema-valid is not editorial approval; pipeline anchoring and quote fallback are reported separately", () => {
  // One schema-valid scene: valid schema, but below the pipeline's two anchored scenes.
  const one = analyzeVisualPlan(message({ visuals: [scene(catalog[0].id)] }), beats, 0, product);
  assert.deepEqual([one.schema, one.editorialApproval, one.pipelineAnchoring.meetsMinimum], ["valid", "not_evaluated", false]);
  // Quote fallback (no excerptId) anchors like the pipeline; an unlocatable quote does not.
  const words = beats[0].narration.split(" ").slice(1, 8).join(" ");
  const q = analyzeVisualPlan(message({ visuals: [{ description: "d", motion: false, subject: "s", quote: words }, { description: "d", motion: false, subject: "s", quote: "SECRET nowhere in this narration at all" }] }), beats, 0, product);
  assert.deepEqual(q.anchors.map(a => a.anchor), ["quote", "none"]);
  assert.equal(q.pipelineAnchoring.anchoredValidScenes, 1);
  noSecret(q);
  // Unresolved ids are classified without echoing them.
  const other = narrationCatalog(beats).find(e => e.beatIndex === 1)!.id;
  const u = analyzeVisualPlan(message({ visuals: [scene(other), scene("0000000000000000:b0:w0"), scene("SECRET-id")] }), beats, 0, product);
  assert.deepEqual(u.unresolvedExcerptIds, { otherRevision: 1, otherBeat: 1, notCatalogFormat: 1 });
  noSecret(u);
});
