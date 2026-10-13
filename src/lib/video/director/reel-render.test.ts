import { test } from "node:test";
import assert from "node:assert/strict";
import type { GeneratedScript } from "@/lib/providers/types";
import { directReel, type ResolvedBeat } from "./reel-render";

// The 60 s Reel used in the first local UI run (only stills resolved, like the fixture/stock path). It used to block
// with MATERIAL_NOT_AUTHORISED + TIMELINE_GAP: the last sentence has topics, its planned stock image has none, so the
// image was not even a candidate and the planner asked for new AI material it may not create.
const SCRIPT: GeneratedScript = { title: "Videos cortos", segments: [
  { text: "¿Tienes buenas ideas, pero grabar y editar un video te toma toda la tarde?", visualQuery: "tired creator laptop", visualConcepts: ["tired creator at laptop", "person checking clock"], energy: "high" },
  { text: "Empieza por lo más simple: escribe tu idea en una sola frase clara, como si se la contaras a un amigo.", visualQuery: "hands writing notebook", visualConcepts: ["hands writing idea in notebook", "person typing on phone"] },
  { text: "Después piensa en el proceso: qué problema muestras, qué cambia y qué debe recordar quien te ve.", visualQuery: "planning board sticky notes", visualConcepts: ["sticky notes planning board", "whiteboard plan"] },
  { text: "Un buen video corto tiene un solo mensaje. Si intentas decir cinco cosas, nadie recuerda ninguna.", visualQuery: "person thinking window", visualConcepts: ["person thinking by window", "focused woman"] },
  { text: "Graba en luz natural, cerca de una ventana, y habla mirando a la cámara con calma.", visualQuery: "woman recording phone window light", visualConcepts: ["creator filming with phone", "natural light room"] },
  { text: "Convierte esto en una rutina: una idea cada día, diez minutos, sin esperar el momento perfecto.", visualQuery: "morning routine coffee desk", visualConcepts: ["morning coffee at desk", "daily routine calendar"] },
  { text: "La constancia vale más que la perfección. Publica, mira qué funciona y vuelve a empezar mañana.", visualQuery: "person smiling at camera", visualConcepts: ["creator smiling at camera", "person walking city"], energy: "low" },
] };

function run(beatType: ResolvedBeat["mediaType"], source: ResolvedBeat["source"]) {
  let t = 0;
  const sceneTimings = SCRIPT.segments.map(s => { const d = s.text.split(" ").length / 2.6; const r = { start: t, end: t + d }; t += d; return r; });
  const beatsBySegment = sceneTimings.map((st, i) => {
    const mid = (st.start + st.end) / 2;
    return [{ url: `https://fixture.local/s${i}a`, mediaType: beatType, source, start: st.start, end: mid }, { url: `https://fixture.local/s${i}b`, mediaType: beatType, source, start: mid, end: st.end }];
  });
  const captions = SCRIPT.segments.map((s, i) => ({ text: s.text, startSeconds: sceneTimings[i].start, endSeconds: sceneTimings[i].end }));
  return { r: directReel({ script: SCRIPT, beatsBySegment, sceneTimings, audioUrl: "https://fixture.local/a.mp3", captions, narrationGaps: [], durationSeconds: t + 0.4 }), end: t };
}

test("a Reel whose material is only planned illustrative stills renders end to end without asking for new material", () => {
  const { r, end } = run("image", "stock");
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.blockers));
  if (!r.ok) return;
  assert.ok(r.plan.shots.every(s => s.asset.status === "chosen"), "every shot uses material that exists");
  assert.equal(r.plan.estimatedMaxUsd, 0);
  assert.ok(Math.abs(r.props.scenes[r.props.scenes.length - 1].endSeconds - end) < 1e-3, "scenes reach the end of the narration");
  assert.ok(r.props.scenes.every(s => s.mediaUrl.startsWith("https://fixture.local/s")), "only resolved media is rendered");
  assert.ok(r.applied.every(a => a.applied.motion !== "real"), "a still is never presented as a real clip");
});

test("generated images stay AI recreations with their visible label; they never borrow the stock correspondence rule", () => {
  const { r } = run("image", "generated");
  if (r.ok) assert.ok(r.applied.every(a => a.applied.label === "recreacion_ia"), "every generated image carries «Recreación IA»");
  else assert.ok(r.blockers.length > 0, "or the Director refuses with explicit blockers");
});
