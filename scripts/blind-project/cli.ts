/**
 * Blind Project #001 CLI (The Iron Annals). Order is enforced by files + gates:
 *   status | select-topic <TOPIC> | seal | amend ... | shadow | evaluate [final-truth.json]
 * Nothing here calls a provider, spends, or touches YouTube. PI V1.1 runs only in `shadow`,
 * and only after `seal` succeeded on a committed baseline.
 * Usage: npx tsx scripts/blind-project/cli.ts <command>
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { sealBaseline, verifySeal, amend, verifyAmendments, sha256, type SealedBaseline, type Amendment } from "@/lib/blind-experiment/seal";
import { runShadowGated, buildShadowInput, type Protocol, type ShadowResult } from "@/lib/blind-experiment/shadow-gate";
import { checkConstitution } from "@/lib/blind-experiment/constitution";
import { evaluate, type FinalTruth } from "@/lib/blind-experiment/evaluate";

const DIR = "content/blind-projects/iron-annals-001";
const F = { protocol: `${DIR}/protocol.json`, lock: `${DIR}/PROTOCOL-LOCK.json`, state: `${DIR}/state.json`, baseline: `${DIR}/baseline/human-baseline.json`, sealed: `${DIR}/sealed/sealed-baseline.json`, amendments: `${DIR}/sealed/amendments.json`, shadow: `${DIR}/shadow/pi-v1_1-shadow.json`, result: `${DIR}/result/blind-test-result.json` };
const read = <T>(p: string): T => JSON.parse(fs.readFileSync(p, "utf8")) as T;
const write = (p: string, v: unknown) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 1) + "\n"); };
const sh = (c: string) => execSync(c).toString().trim();
const die = (m: string): never => { console.error(`[blind-project] REFUSED: ${m}`); process.exit(2); };
const now = () => new Date().toISOString();
type State = { episodeTopic: string; candidates: string[]; topicSelectedBy: string | null; topicSelectedAt: string | null; HUMAN_BASELINE_SEALED: boolean; piShadowRuns: number };

function protocol(): Protocol {
  const p = read<Protocol>(F.protocol);
  const lock = read<{ protocolSha256: string }>(F.lock);
  if (sha256(p) !== lock.protocolSha256) die("protocol.json differs from PROTOCOL-LOCK.json (pre-registered criteria cannot change)");
  return p;
}
const committedAndClean = (p: string) => sh(`git ls-files -- ${p}`) !== "" && sh(`git status --porcelain -- ${p}`) === "";

const [cmd, ...args] = process.argv.slice(2);
const state = read<State>(F.state);
switch (cmd) {
  case "status":
    console.log(JSON.stringify({ ...state, sealedFile: fs.existsSync(F.sealed), shadowFile: fs.existsSync(F.shadow), protocolSha256: sha256(protocol()) }, null, 1));
    break;
  case "select-topic": {
    // Only on the user's explicit instruction; the topic is an editorial decision, never PI's.
    const [topic, by] = args;
    if (state.episodeTopic !== "PENDING") die(`topic already selected: ${state.episodeTopic}`);
    if (!state.candidates.includes(topic)) die(`topic must be one of ${state.candidates.join(", ")}`);
    if (!by) die("select-topic <TOPIC> <authorized-by> (the user's authorization)");
    write(F.state, { ...state, episodeTopic: topic, topicSelectedBy: by, topicSelectedAt: now() });
    console.log(`EPISODE_TOPIC = ${topic}`);
    break;
  }
  case "seal": {
    const p = protocol();
    if (state.episodeTopic === "PENDING") die("EPISODE_TOPIC = PENDING");
    if (fs.existsSync(F.sealed)) die("baseline already sealed; corrections go through `amend`");
    if (!committedAndClean(F.baseline)) die(`${F.baseline} must be committed and unmodified (the commit anchors the seal)`);
    const b = read<{ episodeTopic: string; documents: Record<string, { path: string; sha256: string }> }>(F.baseline);
    if (b.episodeTopic !== state.episodeTopic) die(`baseline topic ${b.episodeTopic} != selected ${state.episodeTopic}`);
    for (const [k, d] of Object.entries(b.documents)) {
      if (!committedAndClean(d.path)) die(`${k} document ${d.path} must be committed and unmodified`);
      if (sha256(fs.readFileSync(d.path, "utf8")) !== d.sha256) die(`${k} document hash mismatch`);
    }
    const sealed = sealBaseline(read(F.baseline), { protocol: p, commitSha: sh("git rev-parse HEAD"), sealedAt: now() });
    write(F.sealed, sealed); write(F.amendments, []);
    write(F.state, { ...state, HUMAN_BASELINE_SEALED: true });
    console.log(JSON.stringify({ baselineId: sealed.baselineId, sealHash: sealed.sealHash, commitSha: sealed.commitSha, contentHashes: sealed.contentHashes, summary: sealed.summary, HUMAN_BASELINE_SEALED: true }, null, 1));
    break;
  }
  case "amend": {
    const [shotId, field, json, reason, author] = args;
    const sealed = read<SealedBaseline>(F.sealed);
    const log = amend(sealed, read<Amendment[]>(F.amendments), { shotId, field, to: JSON.parse(json), reason, author, at: now() });
    write(F.amendments, log);
    console.log(`amendment #${log.length} recorded; the sealed baseline is unchanged`);
    break;
  }
  case "shadow": {
    const p = protocol();
    if (!state.HUMAN_BASELINE_SEALED || !fs.existsSync(F.sealed)) die("HUMAN_BASELINE_SEALED != true");
    if (fs.existsSync(F.shadow)) die("shadow already ran; results are never regenerated or cherry-picked");
    const sealed = read<SealedBaseline>(F.sealed);
    verifySeal(sealed);
    const engineTreeSha256 = sh("git ls-tree -r HEAD src/lib/production-intelligence | sha256sum").slice(0, 64);
    if (sh("git status --porcelain -- src/lib/production-intelligence") !== "") die("PI engine has uncommitted changes");
    const ranAt = now();
    const shadow = runShadowGated({ sealed, protocol: p, ranAt, engineTreeSha256 });
    const constitutionViolations = checkConstitution(buildShadowInput(sealed, p, sealed.baseline.projectId, ranAt), shadow.plan, shadow.networkCalls, ranAt);
    write(F.shadow, { ...shadow, engineTreeSha256, commitSha: sh("git rev-parse HEAD"), constitutionViolations });
    write(F.state, { ...state, piShadowRuns: state.piShadowRuns + 1 });
    console.log(JSON.stringify({ networkCalls: shadow.networkCalls, deterministic: shadow.deterministic, piGenerative: shadow.plan.generativeShots, constitutionViolations }, null, 1));
    break;
  }
  case "evaluate": {
    const p = protocol();
    if (!fs.existsSync(F.sealed) || !fs.existsSync(F.shadow)) die("evaluate needs a sealed baseline AND a completed shadow run");
    const sealed = read<SealedBaseline>(F.sealed);
    const shadow = read<ShadowResult & { constitutionViolations: string[] }>(F.shadow);
    const amendments = read<Amendment[]>(F.amendments); verifyAmendments(sealed, amendments);
    const finalTruth = args[0] ? read<FinalTruth[]>(args[0]) : undefined;
    const r = evaluate({ sealed, protocol: p, shadow, constitutionViolations: shadow.constitutionViolations, amendments, finalTruth });
    write(F.result, r);
    console.log(JSON.stringify({ verdict: r.verdict, stage: r.stage, fail: r.fail, inconclusive: r.inconclusive }, null, 1));
    break;
  }
  default:
    die("commands: status | select-topic <TOPIC> <authorized-by> | seal | amend <shotId> <field> <json> <reason> <author> | shadow | evaluate [final-truth.json]");
}
