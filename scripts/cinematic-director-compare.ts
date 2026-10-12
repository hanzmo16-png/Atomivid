/**
 * Reproducible, provider-free comparison: existing approved Göbekli storyboards vs a Cinematic Director V1
 * proposal over the same script beats. Reads repo files only, writes nothing unless --out is given.
 *   npx tsx scripts/cinematic-director-compare.ts [--out docs/cinematic-director/COMPARISON.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { loadRecipeCatalog } from "@/lib/video/director/recipes";
import { proposePlan } from "@/lib/video/director/propose";
import { auditPlan } from "@/lib/video/director/audit";
import { inputFromStoryboard, storyboardBaseline } from "@/lib/video/director/from-storyboard";
import { getGenerativeUnitCosts } from "@/lib/video/long-form/production-plan";

const DIR = "content/long-form/gobekli-tepe-001";
export const FIXTURES = [
  { name: "gobekli-storyboard-003 + script-003", storyboard: "gobekli-storyboard-003.json", script: "gobekli-script-003-current.json" },
  { name: "gobekli-storyboard-002-hybrid + script-002", storyboard: "gobekli-storyboard-002-hybrid.json", script: "gobekli-script-002-final.json" },
  { name: "gobekli-storyboard-001 + script-002", storyboard: "gobekli-storyboard-001.json", script: "gobekli-script-002-final.json" },
];

export function compareAll() {
  const catalog = loadRecipeCatalog();
  // The same unit costs the production plan uses (estimates, not invoices).
  const u = getGenerativeUnitCosts();
  const unitCosts = { ai_image: u.imageUsd, ai_video: u.veoClipUsd };
  return FIXTURES.map(f => {
    const sb = JSON.parse(readFileSync(`${DIR}/${f.storyboard}`, "utf8")), sc = JSON.parse(readFileSync(`${DIR}/${f.script}`, "utf8"));
    const input = inputFromStoryboard(sb.shots, sc.beats, unitCosts);
    const plan = proposePlan(input, catalog);
    const audit = auditPlan(plan, input, catalog);
    return { fixture: f.name, programmeSeconds: input.totalSeconds, unitCosts, baseline: storyboardBaseline(sb.shots), proposal: audit.metrics, issues: audit.issues.map(i => i.code), catalogVersion: plan.catalogVersion };
  });
}

if (process.argv[1]?.endsWith("cinematic-director-compare.ts")) {
  const report = { generatedFrom: "repo files only; 0 provider calls; 0 USD", results: compareAll() };
  const i = process.argv.indexOf("--out");
  if (i > 0) writeFileSync(process.argv[i + 1], JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
