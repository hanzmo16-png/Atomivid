import type { DocumentaryScript } from "./documentary-script";
import type { EditorialReview } from "./editorial";

export function editorialFixture(wordsPerBeat = 90): DocumentaryScript {
  const openings = ["The locked door is only a story, not physical evidence.",
    "A published account identifies the origin of this allegation.",
    "The second witness repeats the first account without independent access.",
    "That dependency changes how much weight the testimony can carry.",
    "The available evidence documents a circulating legend, not a verified facility."];
  return { title: "A legend examined", workingTitleOptions: ["A legend examined"], hook: openings[0],
    storyPlan: { centralQuestion: "What supports the allegation?", openingPromise: "Follow the evidence.",
      firstAnswer: openings[0], endingAnswer: openings[4], sections: openings.map((s, i) => ({ beatIndex: i,
        newInformation: s, consequence: "Changes the evidence assessment.", tension: i % 2 ? "reflection" : "rise" })) },
    beats: openings.map((s, i) => ({ type: i === 0 ? "hook" : i === 4 ? "payoff" : "discovery",
      purpose: s, narration: s + " " + Array.from({ length: Math.max(0, wordsPerBeat - s.split(/\s+/).length) }, (_, j) => `detail${i}_${j}`).join(" "),
      claims: [], visuals: [{ description: "researcher reading dated archive", motion: true, quote: s.split(" ").slice(0, 5).join(" "), subject: "researcher" },
        { description: "dated manuscript detail", motion: false, quote: s.split(" ").slice(-5).join(" "), subject: "manuscript" }] })) };
}
/** Explicit synthetic critic response: tests orchestration, not live model judgment. */
export function passingReview(script: DocumentaryScript): EditorialReview {
  const evidence = (i: number) => ({ beatIndex: i, quote: script.beats[i].narration.split(" ").slice(0, 7).join(" ") });
  return { sections: script.beats.map((_, i) => ({ ...evidence(i), contribution: `Aportación ${i + 1}`, function: i === 4 ? "resolution" : "new_information" })),
    firstAnswer: { delivered: true, evidence: evidence(0), explanation: "Primera respuesta concreta." },
    ending: { resolvesPromise: true, evidence: evidence(script.beats.length - 1), explanation: "Resolución fundamentada." }, findings: [] };
}
export function repeatedPromiseFixture() {
  const script = editorialFixture();
  const promises = ["Access to the lower levels remains classified and hides the real mystery.",
    "The deepest chambers are restricted, concealing the answer that matters most.",
    "No one is permitted below, where the ultimate secret still awaits."];
  [0, 2, 3].forEach((index, i) => { script.beats[index].narration = promises[i] + " " + script.beats[index].narration; });
  const review = passingReview(script);
  review.findings.push({ kind: "repeated_promise", severity: "blocking",
    evidence: [0, 2, 3].map((index, i) => ({ beatIndex: index, quote: promises[i] })),
    explanation: "Tres bloques prometen el mismo secreto sin aportar información.",
    repair: "Sustituye las reiteraciones por procedencia, contradicciones o una conclusión honesta." });
  return { script, review };
}
