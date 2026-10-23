// Prints the ledger fingerprint of the opening-repair request for a fixed input (run on both SHAs).
import { test } from "node:test";
import { stableHash } from "@/lib/production-intelligence/canonical";
import { narrationCatalog } from "./narration-catalog";
import { openingEvidence, validateOrRepairOpeningReview } from "./editorial-opening-repair";
test("fingerprint", async () => {
  const narration = (b: number, n: number) => Array.from({ length: n }, (_, i) => `w${b}x${i}`).join(" ");
  const bs = Array.from({ length: 10 }, (_, i) => ({ type: "discovery", purpose: `p${i}`, claims: [], narration: narration(i, i === 0 ? 230 : 200) }));
  const script = { beats: bs, storyPlan: { centralQuestion: "q", openingPromise: "p", firstAnswer: "a", endingAnswer: "e", sections: [] } } as never;
  const cat = narrationCatalog(bs), first = (i: number) => cat.find(e => e.beatIndex === i)!.id;
  const late = cat.find(e => e.beatIndex === 0 && Number(e.id.split(":w")[1]) > 160)!;
  const raw = { sections: bs.map((_, i) => ({ excerptId: first(i), contribution: `c${i}`, function: i === 9 ? "resolution" : "new_information" })),
    firstAnswer: { delivered: true, evidence: { excerptId: late.id }, explanation: "x" }, ending: { resolvesPromise: true, evidence: { excerptId: first(9) }, explanation: "e" }, findings: [] };
  let seen: unknown; const id = openingEvidence(bs)[0].id;
  await validateOrRepairOpeningReview({ rawReview: raw, script, model: "claude-sonnet-5", send: async (p) => { seen = p; return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ firstAnswer: { delivered: true, evidence: { excerptId: id }, explanation: "ok" } }) }] }; } });
  console.log("FP_OPENING", stableHash(seen, 16));
});
