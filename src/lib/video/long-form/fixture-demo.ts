import { LONG_FORM_SPEC, type LongFormProject, type NarrativeBeat } from "./types";
import { shotsForSpan } from "./shots";
import { planSegments } from "./segments";

/** Technical demo only (~24s). Not an 8–12 min narrative sample. */
export function buildCuriosityDemoProject(id = "lf-p0-demo"): LongFormProject {
  const beats: NarrativeBeat[] = [
    beat(0, "beat-hook", "hook", 0, 8, "Open on a concrete situation.", "A lamp stays lit after the street has gone dark."),
    beat(1, "beat-setup", "setup", 8, 16, "Place the viewer.", "The useful unit is one room, one night, one leftover light."),
    beat(2, "beat-payoff", "payoff", 16, 24, "Pay the hook.", "The leftover light is not atmosphere. It is a record of a decision."),
  ];
  return {
    id,
    mode: "curiosity_documentary",
    title: "P0 fixture — leftover light (technical demo)",
    targetDurationSec: 24,
    spec: LONG_FORM_SPEC,
    beats,
    segments: planSegments(beats, 8),
  };
}

function beat(
  ordinal: number,
  id: string,
  type: NarrativeBeat["type"],
  start: number,
  end: number,
  purpose: string,
  narration: string,
): NarrativeBeat {
  return {
    id,
    type,
    startTargetSec: start,
    endTargetSec: end,
    purpose,
    narration,
    shots: shotsForSpan({
      beatId: id,
      beatType: type,
      startSec: start,
      endSec: end,
      narration,
      typeOffset: ordinal * 2,
    }),
  };
}
