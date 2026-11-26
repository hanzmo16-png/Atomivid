// Editorial adaptation for ONE QA weather documentary. Context is not evidence of invisible physics.
// The narration, claims, references and passage anchors remain byte-for-byte unchanged.
export const replacements = Object.freeze({
 'rising air': ['clouds', 'Clouds above a landscape: contextual illustration, not a visualization of invisible air currents'],
 'orographic cloud': ['mountain clouds', 'Clouds over a mountain ridge: landscape context, not proof of an air trajectory'],
 'air path': ['sky', 'Sky above a landscape: context for the narrated explanation, not a visible air trajectory'],
 'weather front': ['storm clouds', 'Storm clouds above a landscape: context for the narrated front, not footage proving a collision of air masses'],
 'layered clouds': ['clouds', 'Clouds in the sky: contextual illustration, not proof of their internal composition'],
 'cloud evolution': ['clouds', 'Clouds moving in the sky, contextual illustration'],
 'condensation nuclei': ['dust particles', 'Dust visible in sunlight: context for airborne particles, not microscopic condensation footage'],
 'air masses': ['storm clouds', 'Storm clouds above a landscape: context, not an observed collision of air masses'],
 'cloud formation': ['clouds', 'Clouds against the sky, contextual illustration'],
 'rising cloud mass': ['clouds', 'Clouds above a landscape, contextual illustration'],
 'dissipating cloud': ['clouds', 'Clouds in the sky, contextual illustration rather than a verified dissipation sequence'],
});
export function adaptWeatherContext(original) {
 const script = structuredClone(original);
 if (!Array.isArray(script.beats) || script.beats.length !== 5) throw Error('unexpected QA script');
 let edits = 0;
 for (const beat of script.beats) for (const visual of beat.visuals ?? []) {
   const replacement = replacements[visual.subject];
   if (!replacement) continue;
   if (visual.identity || visual.evidence || visual.beatClass) throw Error('cannot replace identity/evidence/class contract');
   const [subject, description] = replacement;
   visual.subject = subject; visual.description = description;
   visual.alternates = [subject]; delete visual.action; visual.motion = false;
   edits++;
 }
 if (!edits) throw Error('no applicable QA editorial change');
 return { script, edits };
}
