/**
 * Final Cut Intelligence V1 policy: every threshold the editorial inspection uses, as data.
 * Rhythm thresholds are the Production Core timeline rules (same numbers, one source);
 * audio targets are the existing mastering targets. Nothing here names a project.
 */
import { TIMELINE_RULES_V1, type TimelineRules } from "../production-core/timeline-rules";
import { LOUDNESS_TARGET } from "../video/audio-master";

export type FinalCutPolicy = {
  policyVersion: string;
  rhythm: TimelineRules;
  visual: {
    maxShotSec: number;
    /** Shots shorter than this in a row = machine-gun cutting. */
    tooFastCutSec: number;
    tooFastRunMin: number;
    maxUnexpectedBlackSec: number;
    freezeSec: number;
    expectedWidth: number;
    expectedHeight: number;
    expectedFps: number;
  };
  audio: {
    integratedLufsTarget: number;
    integratedLufsTolerance: number;
    truePeakMaxDbtp: number;
    maxSilenceSec: number;
    minFadeSec: number;
    /** Music louder than this relative to voice, in dB, is "music over voice". */
    musicOverVoiceDb: number;
  };
  subtitles: {
    minDisplaySec: number;
    maxDisplaySec: number;
    maxCharsPerSecond: number;
    maxGapSec: number;
    /** A caption may start this early / end this late relative to the speech window. */
    speechWindowSlackSec: number;
    safeArea: { top: number; bottom: number; left: number; right: number };
  };
  opening: { windowSec: number; minShotCount: number; maxAvgShotSec: number; minMovementDensity: number; maxStillStreakSec: number; maxBlackSec: number; maxTitleCardSec: number };
  autoFix: { maxBlackTrimSec: number; maxSilenceTrimSec: number; maxTextCardShortenSec: number; maxSubtitleShiftSec: number; loudnessCorrectMaxLu: number };
  /** Below this confidence an issue is never auto-fixed: it escalates. */
  minConfidenceForAutoFix: number;
  minConfidenceForSmartRepair: number;
  /** A master with this many ESCALATE issues or one blocking issue cannot pass. */
  blockingSeverities: readonly Severity[];
};

export const SEVERITIES = ["info", "minor", "major", "blocking"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const FINAL_CUT_POLICY_V1: FinalCutPolicy = {
  policyVersion: "final-cut-policy/1",
  rhythm: TIMELINE_RULES_V1,
  visual: { maxShotSec: 22, tooFastCutSec: 1.2, tooFastRunMin: 4, maxUnexpectedBlackSec: 0.3, freezeSec: 4, expectedWidth: 1920, expectedHeight: 1080, expectedFps: 30 },
  audio: { integratedLufsTarget: LOUDNESS_TARGET.INTEGRATED_LUFS, integratedLufsTolerance: 1.5, truePeakMaxDbtp: LOUDNESS_TARGET.TRUE_PEAK_DBTP, maxSilenceSec: 3, minFadeSec: 0.3, musicOverVoiceDb: -6 },
  subtitles: { minDisplaySec: 0.8, maxDisplaySec: 7, maxCharsPerSecond: 21, maxGapSec: 4, speechWindowSlackSec: 0.35, safeArea: { top: 0.05, bottom: 0.1, left: 0.05, right: 0.05 } },
  opening: { windowSec: 30, minShotCount: 5, maxAvgShotSec: 6, minMovementDensity: 0.5, maxStillStreakSec: 10, maxBlackSec: 0.5, maxTitleCardSec: 4 },
  autoFix: { maxBlackTrimSec: 1.0, maxSilenceTrimSec: 1.5, maxTextCardShortenSec: 3, maxSubtitleShiftSec: 0.5, loudnessCorrectMaxLu: 4 },
  minConfidenceForAutoFix: 0.9,
  minConfidenceForSmartRepair: 0.6,
  blockingSeverities: ["blocking"],
};
