import { clampTargetDuration } from "./duration";
import { assertOriginalHook, slopScore } from "./originality";
import { shotsForSpan } from "./shots";
import type { BeatType, LongFormBrief, LongFormScript, LongFormSource, NarrativeBeat } from "./types";

const MODE_A_BEATS: BeatType[] = [
  "hook",
  "setup",
  "discovery",
  "escalation",
  "twist",
  "payoff",
  "next_curiosity",
];

const MODE_B_BEATS: BeatType[] = [
  "hook",
  "setup",
  "discovery",
  "escalation",
  "insight",
  "payoff",
  "next_curiosity",
];

/**
 * Deterministic fixture pipeline. No paid providers.
 * Each beat expands to multiple shots. Production adapters replace this function only.
 */
export function buildFixtureScript(brief: LongFormBrief): LongFormScript {
  const duration = clampTargetDuration(brief.mode, brief.targetDurationSec);
  const types = brief.mode === "curiosity_documentary" ? MODE_A_BEATS : MODE_B_BEATS;
  const sources: LongFormSource[] = [
    {
      id: "src-1",
      title: "Primary historical or observational source (placeholder)",
      kind: "primary",
      notes: "Replace with a real citation before any paid generation.",
    },
  ];

  const hook =
    brief.mode === "curiosity_documentary"
      ? everydayContradictionHook(brief.topic)
      : behaviorHook(brief.topic);
  assertOriginalHook(hook);

  const slice = duration / types.length;
  const beats: NarrativeBeat[] = types.map((type, i) => {
    const narration = narrationFor(brief, type);
    const startTargetSec = Math.round(i * slice);
    const endTargetSec = Math.round((i + 1) * slice);
    return {
      id: `beat-${i + 1}`,
      type,
      startTargetSec,
      endTargetSec,
      purpose: purposeFor(type),
      narration,
      claims: [
        {
          id: `claim-${i + 1}`,
          text: `${brief.topic} — claim marked unverified until research stage runs.`,
          support: "unverified",
          sourceIds: ["src-1"],
        },
      ],
      sources: ["src-1"],
      emotionalTone: type === "hook" ? "tension" : type === "payoff" ? "clarity" : "curiosity",
      patternInterrupt: type === "hook" || type === "twist" || type === "insight",
      shots: shotsForSpan({
        beatId: `beat-${i + 1}`,
        beatType: type,
        startSec: startTargetSec,
        endSec: endTargetSec,
        narration,
      }),
    };
  });

  return {
    title: workingTitle(brief),
    workingTitleOptions: [workingTitle(brief), alternateTitle(brief)],
    mode: brief.mode,
    angle: angleFor(brief),
    hook,
    beats,
    sources,
    bannedOpenersUsed: false,
    slopScore: slopScore([hook, ...beats.map((b) => b.narration)].join("\n")),
  };
}

function everydayContradictionHook(topic: string): string {
  return `A person doing something ordinary around ${topic} would not notice the detail that later changes the whole picture.`;
}

function behaviorHook(topic: string): string {
  return `Silence after ${topic} often costs more respect than the explanation people rush to give.`;
}

function workingTitle(brief: LongFormBrief): string {
  if (brief.mode === "curiosity_documentary") return `The overlooked detail inside ${brief.topic}`;
  return `Why ${brief.topic} makes competent people look weaker`;
}

function alternateTitle(brief: LongFormBrief): string {
  return brief.mode === "curiosity_documentary"
    ? `What ${brief.topic} looked like from the ground`
    : `The moment ${brief.topic} stops being a personality trait`;
}

function angleFor(brief: LongFormBrief): string {
  return brief.mode === "curiosity_documentary"
    ? "Tell the lived, ground-level version first; withhold the textbook label until the twist."
    : "Start from a modern social cost, then use a stoic principle as a tool — never as costume.";
}

function purposeFor(type: BeatType): string {
  switch (type) {
    case "hook":
      return "Open on situation + surprise; no channel greeting.";
    case "setup":
      return "Place the viewer in a specific time, body, or social bind.";
    case "discovery":
      return "Add evidence the viewer could not have guessed from the hook alone.";
    case "escalation":
      return "Raise stakes or contradiction.";
    case "twist":
      return "Reframe the setup with a documented fact.";
    case "insight":
      return "Name the mechanism without fake psychology.";
    case "payoff":
      return "Pay the promise of the hook.";
    case "next_curiosity":
      return "Leave one unanswered adjacent question.";
  }
}

function narrationFor(brief: LongFormBrief, type: BeatType): string {
  const topic = brief.topic;
  switch (type) {
    case "hook":
      return brief.mode === "curiosity_documentary"
        ? everydayContradictionHook(topic)
        : behaviorHook(topic);
    case "setup":
      return `The useful unit is not the slogan about ${topic}. It is one concrete scene a viewer can inhabit.`;
    case "discovery":
      return `What looks obvious in hindsight was not labeled that way when people were inside ${topic}.`;
    case "escalation":
      return `The cost shows up in small repeated decisions, not in a single cinematic moment about ${topic}.`;
    case "twist":
      return `The archive, the number, or the contemporaneous complaint cuts against the version of ${topic} people repeat.`;
    case "insight":
      return `A practical rule is more useful than a diagnosis: notice the incentive, then choose the smaller honest move around ${topic}.`;
    case "payoff":
      return `Once the mechanism is visible, ${topic} stops being trivia and becomes a decision the viewer can test this week.`;
    case "next_curiosity":
      return `The next unanswered piece is not a sequel tease. It is the adjacent fact the script refused to fake.`;
  }
}
