import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** C12: distribution (YouTube) data is never an input of Production Intelligence decisions. */
test("C12: no Production Intelligence module imports or reads distribution data", () => {
  const dir = "src/lib/production-intelligence";
  const files: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) files.push(p); } };
  walk(dir);
  assert.ok(files.length > 10);
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    assert.doesNotMatch(src, /from\s+["'][^"']*distribution[^"']*["']/, `${f} imports distribution code`);
    assert.doesNotMatch(src, /\byt_(metric_rows|channels|video_observations)\b|youtubeanalytics/i, `${f} reads distribution data`);
  }
});
