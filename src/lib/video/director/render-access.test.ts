import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  directorInspectionAllowed, directorPilotAccount, directorPilotReel, directorRenderAllowed, resolveDirectorRender,
} from "./render-access";

// Synthetic accounts only (reserved .test domain): no real email or UUID.
const PILOT = { email: "Piloto@Example.test", email_confirmed_at: "2026-10-01T00:00:00Z" };
const OTHER = { email: "otra@example.test", email_confirmed_at: "2026-10-01T00:00:00Z" };
const UNCONFIRMED = { email: "piloto@example.test", email_confirmed_at: null };
const ON = { CINEMATIC_DIRECTOR_RENDER_ENABLED: "1", CINEMATIC_DIRECTOR_V2_ENABLED: "1", CINEMATIC_DIRECTOR_PILOT_EMAILS: " piloto@example.test , x@example.test" };
const REEL = { mode: "visual", recorded_audio_path: null };

test("pilot account: confirmed email on the list (case/space-insensitive); empty list = nobody", () => {
  assert.equal(directorPilotAccount(PILOT, ON), true);
  assert.equal(directorPilotAccount(OTHER, ON), false, "another user's request");
  assert.equal(directorPilotAccount(UNCONFIRMED, ON), false, "unconfirmed email");
  assert.equal(directorPilotAccount(null, ON), false);
  assert.equal(directorPilotAccount(PILOT, { ...ON, CINEMATIC_DIRECTOR_PILOT_EMAILS: "" }), false, "empty list fails closed");
  assert.equal(directorPilotAccount(PILOT, { ...ON, CINEMATIC_DIRECTOR_PILOT_EMAILS: undefined }), false, "missing list fails closed");
});

test("only a visual Reel without recorded narration qualifies; avatar and Long Form never", () => {
  assert.equal(directorPilotReel(REEL), true);
  assert.equal(directorPilotReel({ mode: null }), true, "legacy rows without mode are visual Reels");
  assert.equal(directorPilotReel({ mode: "avatar" }), false);
  assert.equal(directorPilotReel({ mode: "long_form" }), false);
  assert.equal(directorPilotReel({ mode: "visual", recorded_audio_path: "u/r/audio.webm" }), false);
  assert.equal(directorRenderAllowed(PILOT, { mode: "avatar" }, ON), false);
  assert.equal(directorRenderAllowed(PILOT, { mode: "long_form" }, ON), false);
});

test("global switch off/absent keeps the classic montage even for the pilot account", () => {
  const off = { ...ON, CINEMATIC_DIRECTOR_RENDER_ENABLED: undefined };
  assert.equal(directorRenderAllowed(PILOT, REEL, off), false);
  assert.equal(directorRenderAllowed(PILOT, REEL, { ...ON, CINEMATIC_DIRECTOR_RENDER_ENABLED: "0" }), false);
  assert.equal(directorRenderAllowed(PILOT, REEL, {}), false);
  assert.equal(directorRenderAllowed(PILOT, REEL, { CINEMATIC_DIRECTOR_V2_ENABLED: "1", CINEMATIC_DIRECTOR_PILOT_EMAILS: "piloto@example.test" }), false, "inspection flag does not turn the render on");
  assert.equal(directorRenderAllowed(PILOT, REEL, ON), true, "switch + pilot + Reel");
});

test("inspection panel follows the same pilot restriction", () => {
  assert.equal(directorInspectionAllowed(PILOT, REEL, ON), true);
  assert.equal(directorInspectionAllowed(OTHER, REEL, ON), false);
  assert.equal(directorInspectionAllowed(PILOT, { mode: "long_form" }, ON), false);
  assert.equal(directorInspectionAllowed(PILOT, REEL, { ...ON, CINEMATIC_DIRECTOR_V2_ENABLED: "" }), false);
});

test("worker decision: owner looked up only when needed; lookup failure = classic montage", async () => {
  let lookups = 0;
  const load = async () => { lookups++; return PILOT; };
  assert.equal(await resolveDirectorRender(REEL, load, {}), false);
  assert.equal(await resolveDirectorRender({ mode: "avatar" }, load, ON), false);
  assert.equal(await resolveDirectorRender({ mode: "long_form" }, load, ON), false);
  assert.equal(lookups, 0, "no account lookup with the switch off or a non-Reel mode");
  assert.equal(await resolveDirectorRender(REEL, load, ON), true);
  assert.equal(lookups, 1);
  assert.equal(await resolveDirectorRender(REEL, async () => OTHER, ON), false, "another user's request");
  assert.equal(await resolveDirectorRender(REEL, async () => { throw new Error("auth down"); }, ON), false, "fails closed");
});

test("manipulated payload cannot enable it: the dispatch carries no Director field and the worker decides from the row", () => {
  const dispatch = readFileSync("src/lib/worker/github-actions.ts", "utf8");
  assert.doesNotMatch(dispatch, /director|CINEMATIC|\bref\b/i, "dispatch payload has no Director switch or ref");
  const runJob = readFileSync("src/lib/video/run-job.ts", "utf8");
  assert.match(runJob, /const directorRender = mode === "visual" && await resolveDirectorRender\(row, async \(\) => \{\n\s+const \{ data, error \} = await service\.auth\.admin\.getUserById\(row\.user_id\);/,
    "decided from the stored row and its owner account");
  assert.match(runJob, /onProgress,\n\s+directorRender,\n\s+\}\);/, "passed only to the visual Reel generator");
  const gv = readFileSync("src/lib/video/generate-video.ts", "utf8");
  assert.match(gv, /directorRender = false,/, "default off for every other caller");
});

test("render.yml: switch from a repository variable, pilot list from a secret, never for Long Form; checkout has no ref", () => {
  const yml = readFileSync(".github/workflows/render.yml", "utf8");
  assert.match(yml, /CINEMATIC_DIRECTOR_RENDER_ENABLED: \$\{\{ \(github\.event\.client_payload\.mode != 'long_form' && inputs\.mode != 'long_form'\) && vars\.CINEMATIC_DIRECTOR_RENDER_ENABLED \|\| '' \}\}/);
  assert.match(yml, /CINEMATIC_DIRECTOR_PILOT_EMAILS: \$\{\{ \(github\.event\.client_payload\.mode != 'long_form' && inputs\.mode != 'long_form'\) && secrets\.CINEMATIC_DIRECTOR_PILOT_EMAILS \|\| '' \}\}/);
  assert.doesNotMatch(yml, /client_payload\.(director|ref|branch)/i, "no payload-controlled switch or ref");
  const checkout = yml.slice(yml.indexOf("uses: actions/checkout@v4"), yml.indexOf("- name: Configurar Node.js"));
  assert.doesNotMatch(checkout, /ref:/, "the worker runs the workflow's own commit (default branch for repository_dispatch)");
});
