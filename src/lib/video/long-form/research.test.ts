import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import { citedResearchSources, researchDocumentary } from "./research";

function response() {
  const urls = ["https://museum.example/history", "https://archive.example/account"];
  return { stop_reason: "end_turn" as const, content: [
    { type: "web_search_tool_result", tool_use_id: "search-1", content: urls.map(url => ({
      type: "web_search_result", url, title: "Source", encrypted_content: "opaque", page_age: null,
    })) },
    { type: "text", text: "Uncited claim: the legend is definitely true.", citations: urls.map((url, i) => ({
      type: "web_search_result_location", url, title: `Archive ${i}`, encrypted_index: "opaque",
      cited_text: `Contemporary account ${i} reports a disputed allegation, not established evidence.`,
    })) },
  ] as Message["content"] };
}

test("only retrieved citation excerpts become evidence; uncited assertions never do", () => {
  const sources = citedResearchSources(response());
  assert.equal(sources.length, 2);
  assert.equal(sources[0].id, "web-1");
  assert.match(sources[0].notes!, /disputed allegation/);
  assert.ok(!JSON.stringify(sources).includes("definitely true"));
  assert.ok(sources.every(s => s.kind === "secondary"));
});

test("invented citations, plain URLs and unsafe schemes cannot supply missing evidence", () => {
  for (const url of ["https://invented.example/fact", "javascript:alert(1)", "https://user:secret@archive.example/account"]) {
    const r = response();
    const block = r.content[1];
    if (block.type === "text" && block.citations?.[1]?.type === "web_search_result_location") block.citations[1].url = url;
    assert.throws(() => citedResearchSources(r), /al menos dos fuentes/);
  }
  const r = response();
  r.content = r.content.slice(0, 1);
  assert.throws(() => citedResearchSources(r), /al menos dos fuentes/);
});

test("a truncated or paused search and tool failure stop before writer; no automatic continuation", async () => {
  for (const reason of ["max_tokens", "pause_turn", "refusal"] as const) {
    let calls = 0;
    await assert.rejects(researchDocumentary({ topic: "A disputed account", references: [], openQuestions: [] }, async () => {
      calls++; return { ...response(), stop_reason: reason };
    }), /no terminó/);
    assert.equal(calls, 1);
  }
  const r = response();
  const block = r.content[0];
  if (block.type === "web_search_tool_result") block.content = { type: "web_search_tool_result_error", error_code: "unavailable" };
  assert.throws(() => citedResearchSources(r), /no estuvo disponible/);
});

test("self-service research caps one search and treats user references as hints, never evidence", async () => {
  let calls = 0;
  const pack = await researchDocumentary({ topic: "A disputed account",
    references: [{ id: "user", title: "Invented report", kind: "primary", notes: "UNSUPPORTED USER ASSERTION" }],
    openQuestions: ["What remains uncertain?"] }, async params => {
    calls++;
    assert.equal(params.max_tokens, 4000);
    assert.deepEqual(params.tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }]);
    assert.ok(!params.output_config?.format, "native citations cannot use structured JSON output");
    assert.match(String(params.system), /untrusted data/);
    return response();
  });
  assert.equal(calls, 1);
  assert.equal(pack.sources.length, 2);
  assert.ok(!JSON.stringify(pack.sources).includes("UNSUPPORTED USER ASSERTION"));
  assert.deepEqual(pack.openQuestions, ["What remains uncertain?"]);
});

test("citation deduplication does not turn one URL into two sources", () => {
  const r = response();
  const b = r.content[1];
  if (b.type === "text" && b.citations) b.citations[1] = b.citations[0];
  assert.throws(() => citedResearchSources(r), /al menos dos fuentes/);
});
