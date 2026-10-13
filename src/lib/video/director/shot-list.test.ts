import { test } from "node:test";
import assert from "node:assert/strict";
import { directReel, type ResolvedBeat } from "./reel-render";
import { scriptFromShotList, shotListAdapter, shotListTimings, storyboardFromShotList, type PlannedShot } from "./shot-list";
import { bundledRecipeCatalog, recipesFor } from "./recipes";

// «Una nave entre dos mundos»: the 8 planned shots of Hans's fiction test (≈55 s, one generated clip each).
const SHOTS: PlannedShot[] = [
  ["s01", "Una nave cruza un mundo de montañas gigantes, niebla y cascadas.", 7],
  ["s02", "Maniobra entre paredes de roca y emerge sobre un océano inmenso.", 7],
  ["s03", "Desciende y se hunde en el mar: impacto, espuma y burbujas.", 7.5],
  ["s04", "Sus luces recorren la oscuridad; una sombra gigantesca pasa a lo lejos.", 7],
  ["s05", "Aparece una criatura colosal.", 7],
  ["s06", "Su mirada se posa en la nave.", 5.5],
  ["s07", "La criatura se lanza; la nave esquiva.", 6.5],
  ["s08", "En la oscuridad, algo más despierta.", 7.5],
].map(([id, text, seconds]) => ({ id: id as string, text: text as string, seconds: seconds as number, subject: "futuristic ship", action: text as string,
  environment: "fiction world", shotType: "wide", camera: "generated", lighting: "cinematic", concepts: ["futuristic ship", "cinematic fiction"] }));
const IDENTITY = { place: "montañas y océano", palette: "grafito, naranja, azul profundo", lighting: "natural → submarina", tone: "asombro y tensión",
  arc: "del aire al abismo", recurring: "la misma nave y la misma criatura" };

function direct(opts: { clipAudio?: "off" | "recipe"; labelText?: Record<string, string>; style?: "fiction" }) {
  const timings = shotListTimings(SHOTS);
  const beatsBySegment: ResolvedBeat[][] = SHOTS.map((s, i) => [{ url: `https://sim.local/${s.id}.mp4`, mediaType: "video", source: "generated", start: timings[i].start, end: timings[i].end }]);
  const end = timings[timings.length - 1].end;
  return directReel({ script: scriptFromShotList("Una nave entre dos mundos", SHOTS), storyboard: storyboardFromShotList(SHOTS, IDENTITY), beatsBySegment,
    sceneTimings: timings, audioUrl: "", captions: [], narrationGaps: [], durationSeconds: end,
    adapter: { ...shotListAdapter(SHOTS), ...(opts.style ? { style: opts.style } : {}) }, clipAudio: opts.clipAudio, labelText: opts.labelText });
}

test("shot list: ~55 s, one shot per planned shot, each with its own clip, in order, fiction recipes", () => {
  const r = direct({ style: "fiction", clipAudio: "recipe", labelText: { recreacion_ia: "Ficción creada con IA" } });
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.blockers));
  if (!r.ok) return;
  assert.equal(r.storyboardSource, "real");
  assert.equal(r.props.scenes.length, SHOTS.length);
  r.props.scenes.forEach((sc, i) => assert.equal(sc.mediaUrl, `https://sim.local/${SHOTS[i].id}.mp4`, `scene ${i} uses its own planned clip`));
  assert.ok(Math.abs(r.props.scenes[r.props.scenes.length - 1].endSeconds - 55) < 0.05, "total ≈ 55 s");
  assert.equal(r.props.scenes[0].startSeconds, 0);
  const fiction = new Set(recipesFor(bundledRecipeCatalog(), "reel", "fiction").map(x => x.id));
  assert.ok(r.applied.every(a => a.recipeId && fiction.has(a.recipeId)), "every shot uses a fiction recipe");
  assert.ok(new Set(r.applied.map(a => a.recipeId)).size >= 7, "the Director varies the recipes along the sequence");
  assert.equal(r.applied[0].recipeId, "reel-fic-establishing-scale");
  assert.equal(r.applied[r.applied.length - 1].recipeId, "reel-fic-closing-intrigue");
  assert.equal(r.applied[0].applied.transitionIn, "fade", "opens from black");
  assert.equal(r.applied[r.applied.length - 1].applied.transitionOut, "fade", "closes to black");
  assert.ok(r.applied.every(a => a.applied.motion === "real"), "generated clips play as filmed (no synthetic zoom)");
  assert.ok(r.applied.every(a => a.applied.audio === "clip"), "fiction recipes keep the clip's own sound when the render opts in");
  assert.ok(r.props.scenes.every(sc => sc.direction?.audio === "clip" && sc.direction.labelText === "Ficción creada con IA" && sc.direction.label === "recreacion_ia"));
  assert.equal(r.plan.estimatedMaxUsd, 0, "nothing new is planned: every shot uses existing material");
});

test("clip sound is configurable: off keeps every clip muted (historic) with the same plan", () => {
  const on = direct({ style: "fiction", clipAudio: "recipe" }), off = direct({ style: "fiction", clipAudio: "off" }), none = direct({ style: "fiction" });
  assert.ok(on.ok && off.ok && none.ok);
  if (!on.ok || !off.ok || !none.ok) return;
  assert.deepEqual(off.applied.map(a => a.recipeId), on.applied.map(a => a.recipeId));
  assert.ok(off.props.scenes.every(sc => sc.direction?.audio === undefined), "off: no scene asks for clip sound");
  assert.ok(none.props.scenes.every(sc => sc.direction?.audio === undefined && sc.direction?.labelText === undefined), "absent options: historic directions");
  assert.ok(none.applied.every(a => !("audio" in a.applied) && !("labelText" in a.applied)), "absent options: applied records keep the historic shape");
});

test("without the fiction style the fiction recipes are never offered (historic Reel behaviour)", () => {
  const r = direct({});
  const ids = r.plan?.shots.map(s => s.recipeId) ?? [];
  assert.ok(ids.every(id => !id?.startsWith("reel-fic-")), JSON.stringify(ids));
});
