import test from "node:test";
import assert from "node:assert/strict";
import { defaultCatalog } from "../catalog";
import {
  ISSUE_320_REQUIRED_MISSIONS,
  campaign320Coverage,
  campaign320Ready,
} from "./campaign-320";

test("issue #320: una cobertura parcial nunca se presenta como campaña real completa", () => {
  const workerInventory = new Set(["audio-real-es", "audio-real-en", "youtube-real"]);
  const rows = campaign320Coverage(defaultCatalog(), workerInventory);

  assert.equal(rows.length, 4);
  assert.equal(campaign320Ready(rows), false);
  assert.deepEqual(
    rows.filter((row) => row.readyForRealRun).map((row) => row.id),
    ["youtube-real", "audio-real-es"],
  );
  assert.deepEqual(
    rows.filter((row) => !row.readyForRealRun).map((row) => row.id),
    ["reels-real", "video-podcast-real"],
  );
});

test("issue #320: solo las cuatro misiones catalogadas e implementadas abren el gate", () => {
  const catalog = defaultCatalog();
  catalog.missions.push(
    {
      id: "reels-real",
      product: "reels",
      title: "Reels REAL",
      instructions: "Generar y validar un Reel vertical real de treinta segundos.",
      expected: "MP4 vertical real validado",
      publishForbidden: false,
    },
    {
      id: "video-podcast-real",
      product: "video-podcast",
      title: "Podcast audiovisual REAL",
      instructions: "Generar y validar un episodio audiovisual real con dos voces.",
      expected: "MP4 audiovisual real validado",
      publishForbidden: false,
    },
  );
  const implemented = new Set(ISSUE_320_REQUIRED_MISSIONS.map((mission) => mission.id));
  const rows = campaign320Coverage(catalog, implemented);

  assert.equal(campaign320Ready(rows), true);
  assert.ok(rows.every((row) => /evidencia real/i.test(row.reason)));
});
