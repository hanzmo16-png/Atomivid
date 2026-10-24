/**
 * FREE: runs the repo's own test suites at REPLAY_REF with a SANITISED environment (no secrets: PATH/HOME/CI only), so no
 * test can reach a real provider or the production DB. Prints `TEST` lines for every failing test with its first error
 * lines (CI logs/artifacts are not downloadable from the sandbox; annotations are).
 */
import { spawnSync } from "node:child_process";
const SUITES = (process.env.SUITES ?? "test:unit,test:editorial,test:rescate,test:spend").split(",");
const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CI: "1", NODE_OPTIONS: "--test-reporter=tap" };
for (const s of SUITES) {
  const r = spawnSync("npm", ["run", "-s", s], { env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const lines = `${r.stdout}\n${r.stderr}`.split("\n");
  const sum = lines.filter((l) => /^# (tests|pass|fail)/.test(l)).join(" ");
  console.log(`TEST ${s} exit=${r.status} ${sum}`);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)not ok \d+ - (.*)$/);
    if (!m) continue;
    const detail: string[] = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 60); j++) {
      if (/^\s*(not ok|ok) \d+/.test(lines[j])) break;
      if (/error:|expected:|actual:|location:|Error|AssertionError/.test(lines[j])) detail.push(lines[j].trim());
      if (/^\s*error: \|-/.test(lines[j])) detail.push(...lines.slice(j + 1, j + 4).map((x) => x.trim()));
    }
    console.log(`TEST FAIL [${s}] ${m[1].length ? "sub" : "file"}: ${m[2].slice(0, 200)} :: ${detail.join(" | ").slice(0, 1200)}`);
  }
}
