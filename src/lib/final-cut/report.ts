/**
 * Final Cut Report: the structured, deterministic output of one inspection of one master.
 * issueId is content-addressed (category, rule, range, shot), so the same defect found twice
 * has the same id and reinspection can prove it disappeared.
 */
import { z } from "zod";
import { stableHash } from "../production-intelligence/canonical";
import { SEVERITIES, type Severity } from "./policy";

export const INSPECTION_VERSION = "final-cut-inspection/1";
export const ISSUE_CATEGORIES = ["visual", "rhythm", "audio", "subtitles", "opening", "technical"] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];
export const REPAIR_CLASSES = ["AUTO_FIX", "SMART_REPAIR", "ESCALATE", "NONE"] as const;
export type RepairClass = (typeof REPAIR_CLASSES)[number];

export type Issue = {
  issueId: string;
  category: IssueCategory;
  rule: string;
  severity: Severity;
  /** 0..1: how sure the detector is that this is a real defect (a measured black frame ~1; a semantic guess ~0.3). */
  confidence: number;
  startTime: number | null;
  endTime: number | null;
  shotId: string | null;
  description: string;
  evidence: Record<string, unknown>;
  recommendedAction: string;
  repairClass: RepairClass;
};

export type IssueDraft = Omit<Issue, "issueId" | "repairClass"> & { repairClass?: RepairClass };

export function issueId(d: Pick<IssueDraft, "category" | "rule" | "startTime" | "endTime" | "shotId">): string {
  return "fci_" + stableHash({ c: d.category, r: d.rule, s: d.startTime, e: d.endTime, sh: d.shotId }, 20);
}

export type OpeningMetrics = { windowSec: number; shotCount: number; averageShotSec: number | null; movementDensity: number | null; stillStreakMaxSec: number; blackSec: number | null; titleCardSec: number; visualRepetitions: number; assessable: boolean };
export type EditorialMetrics = { slots: number; averageShotSec: number | null; longestShotSec: number | null; longestStaticRunSec: number | null; staticShare: number | null; motionDensity: number | null; transitions: number; textCardSec: number; blackSec: number | null; captions: number };
export type TechnicalMetrics = { durationSec: number; width: number | null; height: number | null; fps: number | null; integratedLufs: number | null; truePeakDbtp: number | null; silenceSec: number | null; blackSec: number | null; freezeSec: number | null };

export type FinalCutReport = {
  inspectionVersion: typeof INSPECTION_VERSION;
  policyVersion: string;
  reportId: string;
  masterId: string;
  productionId: string;
  source: { kind: string; ref: string };
  mode: "INSPECT_ONLY" | "REPAIR";
  timestamp: string;
  technical: TechnicalMetrics;
  editorial: EditorialMetrics;
  opening: OpeningMetrics;
  issues: Issue[];
  counts: Record<RepairClass, number> & { blocking: number; notAssessable: string[] };
  verdict: "PASS" | "REPAIR_REQUIRED" | "FAIL" | "HUMAN_REVIEW_REQUIRED";
  reasons: string[];
  /** Fingerprint of the inspected EDL (proves INSPECT_ONLY touched nothing). */
  inputSha256: string;
};

export const FinalCutReportSchema = z.object({
  inspectionVersion: z.literal(INSPECTION_VERSION), policyVersion: z.string(), reportId: z.string(), masterId: z.string(), productionId: z.string(),
  source: z.object({ kind: z.string(), ref: z.string() }), mode: z.enum(["INSPECT_ONLY", "REPAIR"]), timestamp: z.string(),
  technical: z.record(z.string(), z.number().nullable()), editorial: z.record(z.string(), z.number().nullable()), opening: z.record(z.string(), z.union([z.number(), z.boolean()]).nullable()),
  issues: z.array(z.object({ issueId: z.string(), category: z.enum(ISSUE_CATEGORIES), rule: z.string(), severity: z.enum(SEVERITIES), confidence: z.number().min(0).max(1), startTime: z.number().nullable(), endTime: z.number().nullable(), shotId: z.string().nullable(), description: z.string(), evidence: z.record(z.string(), z.unknown()), recommendedAction: z.string(), repairClass: z.enum(REPAIR_CLASSES) })),
  counts: z.record(z.string(), z.unknown()), verdict: z.enum(["PASS", "REPAIR_REQUIRED", "FAIL", "HUMAN_REVIEW_REQUIRED"]), reasons: z.array(z.string()), inputSha256: z.string(),
});
