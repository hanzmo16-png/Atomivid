/** Shared, verbatim exam helpers (extracted unchanged from exam.ts so V1 and V1.1 use the identical Ocean normalization). */
import fs from "node:fs";
import { parseShotContract, type ShotContract } from "@/lib/production-intelligence/contract";
export const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

export function overlap(name: string, pi: string[], human: string[]) {
  const P_ = new Set(pi), H = new Set(human);
  const inter = [...P_].filter((x) => H.has(x)).sort();
  const union = new Set([...P_, ...H]);
  return { comparison: name, pi: pi.length, human: human.length, intersection: inter, piOnly: [...P_].filter((x) => !H.has(x)).sort(), humanOnly: [...H].filter((x) => !P_.has(x)).sort(), precision: r4(inter.length / (P_.size || 1)), recall: r4(inter.length / (H.size || 1)), jaccard: r4(inter.length / (union.size || 1)) };
}

export type Sb = { shotId: string; beatId: string; durationApprox: number; assetType: string; motion: string; hybridClassification: string; reused?: boolean; description: string; visualIntent: string; estimatedCostUsd?: number; billableVideoSeconds?: number; aiGenerated?: boolean };
export const sb = JSON.parse(fs.readFileSync("docs/pi-exam/ocean-input/ocean-storyboard-001.v003.json", "utf8")) as { shots: Sb[] };
export const manifest = JSON.parse(fs.readFileSync("docs/pi-exam/ocean-input/episode-manifest.json", "utf8"));
export const scenes = (manifest.scenes ?? manifest) as { source: { kind: string; key?: string } }[];
export const FINISHED = 659.343, BUDGET = 17.65;
export const CREATURE = /\b(fish|fishes|angler|dragonfish|jelly|squid|octopus|shrimp|worm|animal|lure|bacteria|silhouette|counterillumination|biolumin)/i;
export const VEHICLE = /\b(vehicle|rov|submersible|deep discoverer|bathyscaphe|trieste)/i;
export const PEOPLE = /\b(people|person|men|crew|scientist|piccard|walsh)\b/i;
export function oceanContract(s: Sb, aiLeverage: "LOW" | "MEDIUM" | "HIGH"): ShotContract {
  const text = `${s.visualIntent} ${s.description}`;
  const common = { shotId: s.shotId, narrationIntent: s.visualIntent, visualIntent: s.description, desiredDuration: s.durationApprox, maxGeneratedDuration: 8, qualityTier: "economy" as const, continuityGroup: s.beatId, existingApprovedAssetId: s.reused ? s.shotId : null };
  if (s.hybridClassification === "AI_RECREATION") {
    const shotClass = CREATURE.test(text) ? "creature" : VEHICLE.test(text) ? "object" : "landscape";
    return parseShotContract({ ...common, shotClass, motionRequirement: "simple", motionLeverage: aiLeverage, riskClass: shotClass === "creature" ? "MEDIUM" : "LOW", humanIntervention: "human", stockAvailable: false });
  }
  if (s.motion === "map-graphic") return parseShotContract({ ...common, shotClass: "map", motionRequirement: "camera_only", motionLeverage: "LOW", riskClass: "LOW", stockAvailable: false });
  if (s.motion === "figure-over-motion") return parseShotContract({ ...common, shotClass: "graphic", motionRequirement: "camera_only", motionLeverage: "LOW", riskClass: "LOW", stockAvailable: true });
  if (s.motion.startsWith("still-push")) return parseShotContract({ ...common, shotClass: PEOPLE.test(text) ? "other" : "object", motionRequirement: "camera_only", motionLeverage: "LOW", riskClass: "LOW", stockAvailable: true });
  return parseShotContract({ ...common, shotClass: "broll", motionRequirement: "simple", motionLeverage: "LOW", riskClass: "LOW", stockAvailable: true });
}
export const oldMethod = (s: Sb) => (s.motion.startsWith("ai-animation") ? "GENERATIVE_VIDEO (Veo 8 s)" : s.motion === "real-footage" ? "STOCK" : s.motion === "figure-over-motion" ? "GRAPHIC_OVER_FOOTAGE" : s.motion === "map-graphic" ? "MAP_GRAPHIC" : "ARCHIVAL_STILL_PUSH");
