import type { NarrativeBeat, SegmentPlan } from "./types";

export function planSegments(beats: NarrativeBeat[], maxSegmentSec = 12): SegmentPlan[] {
  const plans: SegmentPlan[] = [];
  let bucket: NarrativeBeat[] = [];
  let acc = 0;

  const flush = () => {
    if (!bucket.length) return;
    const shots = bucket.flatMap((b) => b.shots);
    plans.push({
      id: `seg-${String(plans.length + 1).padStart(2, "0")}`,
      beatIds: bucket.map((b) => b.id),
      shotIds: shots.map((s) => s.id),
      startSec: bucket[0].startTargetSec,
      endSec: bucket[bucket.length - 1].endTargetSec,
      status: "pending",
    });
    bucket = [];
    acc = 0;
  };

  for (const beat of beats) {
    const dur = beat.endTargetSec - beat.startTargetSec;
    if (bucket.length && acc + dur > maxSegmentSec) flush();
    bucket.push(beat);
    acc += dur;
  }
  flush();
  return plans;
}

/** Retry continues at the first segment that is not already validated or rendered. */
export function nextRetryableSegment(plans: SegmentPlan[]): SegmentPlan | undefined {
  return plans.find((p) => p.status === "pending" || p.status === "failed");
}
