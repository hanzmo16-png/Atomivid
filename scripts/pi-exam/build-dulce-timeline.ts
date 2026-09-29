/**
 * Builds the DULCE Part I timeline fixture for V1.1 rhythm (separate from the V1 fixtures builder,
 * whose output stays unchanged). Reads only order, seconds, origin and asset id from the storyboard:
 * the human production method of NEW shots is NEVER read (it is the answer being examined).
 * Fixed slots: V1 recut footage = live; V1 stills, graphics (G*) and NEW assets without a contract = static.
 * Usage: npx tsx scripts/pi-exam/build-dulce-timeline.ts
 */
import fs from "node:fs";
import crypto from "node:crypto";

const SRC = "content/long-form/dulce-part1/storyboard.json";
const raw = fs.readFileSync(SRC);
const sb = JSON.parse(raw.toString()) as { shots: { id: string; src: string; sec: number; origin: "V1" | "NEW"; productionMethod: string }[] };
const contracts = new Set((JSON.parse(fs.readFileSync("src/lib/production-intelligence/fixtures/dulce-mix-contracts.json", "utf8")).contracts as { shotId: string }[]).map((c) => c.shotId));

const slots = sb.shots.map((s) => {
  if (s.origin === "V1") return { slotId: s.id, shotId: null, seconds: s.sec, fixed: s.productionMethod === "v1_recut" ? ("live" as const) : ("static" as const), note: `V1 ${s.productionMethod} ${s.src}` };
  if (contracts.has(s.src)) return { slotId: s.id, shotId: s.src, seconds: s.sec };
  return { slotId: s.id, shotId: null, seconds: s.sec, fixed: "static" as const, note: `NEW ${s.src} without a mix contract (graphic or unlisted still)` };
});
const out = {
  dataset: "pi-dulce-timeline",
  version: 1,
  source: SRC,
  sourceSha256: crypto.createHash("sha256").update(raw).digest("hex"),
  fieldsRead: ["id", "src", "sec", "origin", "productionMethod (V1 slots only: v1_recut vs ken_burns)"],
  contractsNotOnTimeline: [...contracts].filter((id) => !sb.shots.some((s) => s.src === id)),
  totalSeconds: Math.round(slots.reduce((t, s) => t + s.seconds, 0) * 100) / 100,
  slots,
};
fs.writeFileSync("src/lib/production-intelligence/fixtures/dulce-timeline.json", JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify({ slots: slots.length, fixed: slots.filter((s) => "fixed" in s).length, contractsNotOnTimeline: out.contractsNotOnTimeline, totalSeconds: out.totalSeconds }));
