/**
 * Mix rules learned from Ocean and DULCE, as CONFIGURABLE, deterministic checks over an
 * ordered timeline. PI V1.1's rhythm pass decides methods; these rules audit the
 * assembled timeline (opening motion, hook density, minimum visible duration, text/black
 * cards, speech timing, repetition, camera use) and choose transitions deterministically.
 * The evaluator never edits the timeline: it reports findings with the rule id that fired.
 */
export type SlotKind = "generated_image" | "animated_generated_image" | "stock_video" | "stock_image" | "graphic" | "text_card" | "black" | "existing_clip";
export type SlotMotion = "static" | "camera" | "live";

export type TimelineSlot = {
  slotId: string;
  startSec: number;
  durationSec: number;
  kind: SlotKind;
  motion: SlotMotion;
  /** Content identity for repetition checks (e.g. dedupKey / asset id). */
  visualKey: string;
  beatId: string;
  transitionIn?: Transition;
};

export type SpeechSegment = { startSec: number; endSec: number };
export type Transition = "cut" | "dissolve" | "dip_to_black" | "match_cut";

export type TimelineRules = {
  rulesVersion: string;
  /** A run of static slots may not exceed these (same spirit as PI rhythm, applied post-assembly). */
  maxConsecutiveStaticSec: number;
  maxConsecutiveStaticSlots: number;
  /** The first slot must carry motion (camera or live) when the plan asks for a moving opening. */
  requireOpeningMotion: boolean;
  /** Hook: at least `hookMinCuts` slots inside the first `hookWindowSec`. */
  hookWindowSec: number;
  hookMinCuts: number;
  minVisibleSec: number;
  maxTextCardSec: number;
  maxBlackSec: number;
  /** Cuts may not land inside a speech segment closer than this to its edges? No: cuts may land anywhere EXCEPT that total duration must match narration within this tolerance. */
  speechDurationToleranceSec: number;
  /** The same visualKey may not reappear within this window. */
  repetitionWindowSec: number;
  /** Camera motion is meaningful only on pictures; never on text cards or black. */
  cameraForbiddenOn: SlotKind[];
  /** Deterministic transition policy. */
  transitions: { beatBoundary: Transition; afterBlack: Transition; default: Transition; maxDissolvesPerMinute: number };
};

/** Values written from the DULCE/Ocean audits (PROVISIONAL; they are data, not code). */
export const TIMELINE_RULES_V1: TimelineRules = {
  rulesVersion: "timeline-rules/1",
  maxConsecutiveStaticSec: 30,
  maxConsecutiveStaticSlots: 6,
  requireOpeningMotion: true,
  hookWindowSec: 15,
  hookMinCuts: 3,
  minVisibleSec: 2.5,
  maxTextCardSec: 6,
  maxBlackSec: 1.5,
  speechDurationToleranceSec: 0.75,
  repetitionWindowSec: 45,
  cameraForbiddenOn: ["text_card", "black", "graphic"],
  transitions: { beatBoundary: "dissolve", afterBlack: "cut", default: "cut", maxDissolvesPerMinute: 4 },
};

export type TimelineFinding = { rule: string; severity: "error" | "warning"; slotIds: string[]; message: string };

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Deterministic transition: same neighbours -> same transition. */
export function chooseTransition(prev: TimelineSlot | null, next: TimelineSlot, rules: TimelineRules): Transition {
  if (!prev) return "cut";
  if (prev.kind === "black") return rules.transitions.afterBlack;
  if (prev.beatId !== next.beatId) return rules.transitions.beatBoundary;
  return rules.transitions.default;
}

export function evaluateTimeline(slots: TimelineSlot[], rules: TimelineRules, ctx: { speech: SpeechSegment[]; openingMotionRequested: boolean }): { pass: boolean; findings: TimelineFinding[]; stats: { totalSec: number; staticShareOfHook: number; longestStaticRunSec: number } } {
  const f: TimelineFinding[] = [];
  const ordered = [...slots].sort((a, b) => a.startSec - b.startSec || a.slotId.localeCompare(b.slotId));
  const total = ordered.length ? r2(ordered[ordered.length - 1].startSec + ordered[ordered.length - 1].durationSec) : 0;

  // Contiguity: no gaps or overlaps (a timeline with holes shows black by accident).
  for (let i = 1; i < ordered.length; i++) {
    const gap = r2(ordered[i].startSec - (ordered[i - 1].startSec + ordered[i - 1].durationSec));
    if (Math.abs(gap) > 0.01) f.push({ rule: "R_CONTIGUOUS", severity: "error", slotIds: [ordered[i - 1].slotId, ordered[i].slotId], message: `${gap > 0 ? "gap" : "overlap"} of ${Math.abs(gap)} s` });
  }
  // Opening motion from second 0 when the plan asks for it.
  if (rules.requireOpeningMotion && ctx.openingMotionRequested && ordered.length && ordered[0].motion === "static") f.push({ rule: "R_OPENING_MOTION", severity: "error", slotIds: [ordered[0].slotId], message: "the opening slot is static; the plan requires motion from second 0" });
  // Hook density.
  const hookSlots = ordered.filter((s) => s.startSec < rules.hookWindowSec);
  if (ordered.length && hookSlots.length < rules.hookMinCuts) f.push({ rule: "R_HOOK_DENSITY", severity: "error", slotIds: hookSlots.map((s) => s.slotId), message: `${hookSlots.length} slots in the first ${rules.hookWindowSec} s; at least ${rules.hookMinCuts} required` });
  const hookStatic = hookSlots.reduce((t, s) => t + (s.motion === "static" ? Math.min(s.durationSec, rules.hookWindowSec - s.startSec) : 0), 0);
  // Minimum visible duration, text cards, black.
  for (const s of ordered) {
    if (s.durationSec < rules.minVisibleSec - 1e-9 && s.kind !== "black") f.push({ rule: "R_MIN_VISIBLE", severity: "error", slotIds: [s.slotId], message: `${s.durationSec} s on screen is below the ${rules.minVisibleSec} s minimum` });
    if (s.kind === "text_card" && s.durationSec > rules.maxTextCardSec) f.push({ rule: "R_TEXT_CARD_MAX", severity: "error", slotIds: [s.slotId], message: `text card held ${s.durationSec} s (max ${rules.maxTextCardSec})` });
    if (s.kind === "black" && s.durationSec > rules.maxBlackSec) f.push({ rule: "R_BLACK_MAX", severity: "error", slotIds: [s.slotId], message: `black for ${s.durationSec} s (max ${rules.maxBlackSec})` });
    if (s.motion === "camera" && rules.cameraForbiddenOn.includes(s.kind)) f.push({ rule: "R_CAMERA_MEANINGFUL", severity: "error", slotIds: [s.slotId], message: `camera motion on a ${s.kind} has no meaning` });
  }
  // Static runs.
  let run: TimelineSlot[] = [], longest = 0;
  const flush = () => { const sec = r2(run.reduce((t, s) => t + s.durationSec, 0)); longest = Math.max(longest, sec); if (run.length && (sec > rules.maxConsecutiveStaticSec || run.length > rules.maxConsecutiveStaticSlots)) f.push({ rule: "R_STATIC_RUN", severity: "error", slotIds: run.map((s) => s.slotId), message: `${run.length} consecutive static slots / ${sec} s exceed ${rules.maxConsecutiveStaticSlots} / ${rules.maxConsecutiveStaticSec} s` }); run = []; };
  for (const s of ordered) { if (s.motion === "static") run.push(s); else flush(); }
  flush();
  // Speech timing: the picture never stretches or cuts the narration.
  const speechEnd = ctx.speech.length ? Math.max(...ctx.speech.map((s) => s.endSec)) : 0;
  if (ctx.speech.length && Math.abs(total - speechEnd) > rules.speechDurationToleranceSec) f.push({ rule: "R_SPEECH_TIMING", severity: "error", slotIds: [], message: `timeline ${total} s vs narration ${r2(speechEnd)} s: beyond ${rules.speechDurationToleranceSec} s tolerance` });
  // Repetition.
  const lastSeen = new Map<string, TimelineSlot>();
  for (const s of ordered) {
    const p = lastSeen.get(s.visualKey);
    if (p && s.startSec - (p.startSec + p.durationSec) < rules.repetitionWindowSec) f.push({ rule: "R_REPETITION", severity: "warning", slotIds: [p.slotId, s.slotId], message: `visual ${s.visualKey} reappears after ${r2(s.startSec - (p.startSec + p.durationSec))} s (< ${rules.repetitionWindowSec} s)` });
    lastSeen.set(s.visualKey, s);
  }
  // Transitions: deterministic and not overused.
  let dissolves = 0;
  ordered.forEach((s, i) => {
    const expected = chooseTransition(i ? ordered[i - 1] : null, s, rules);
    if (s.transitionIn && s.transitionIn !== expected) f.push({ rule: "R_TRANSITION_DETERMINISTIC", severity: "error", slotIds: [s.slotId], message: `transition ${s.transitionIn} differs from the policy's ${expected}` });
    if ((s.transitionIn ?? expected) === "dissolve") dissolves++;
  });
  if (total > 0 && dissolves / (total / 60) > rules.transitions.maxDissolvesPerMinute) f.push({ rule: "R_TRANSITION_DENSITY", severity: "warning", slotIds: [], message: `${dissolves} dissolves in ${r2(total / 60)} min` });

  return { pass: !f.some((x) => x.severity === "error"), findings: f, stats: { totalSec: total, staticShareOfHook: r2(hookStatic / Math.min(rules.hookWindowSec, Math.max(total, 1e-9))), longestStaticRunSec: longest } };
}
