// Final independent audit of PR #200 — real Next routes, real PG + PostgREST, real workers; only providers simulated. USD 0.
// Runs after scripts/harness/e2e/podcast/start.sh (same env as podcast-e2e.cjs). Prints PASS / FAIL / FINDING lines.
//  F1  video route: the immutable episode authorization must not be opened by a request that is then refused (402/409/400).
//  F2  Podcast 2.1 narration worker SIGKILLed while a paid TTS call is IN FLIGHT (provider got it, no answer).
//  F3  Podcast 3.0 studio worker SIGKILLed while a studio paid call is in flight → mark-failed → retry.
const path = require("node:path"), fs = require("node:fs"), { spawn, execFileSync } = require("node:child_process");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE); const { Client } = require(process.env.HARNESS_PG_MODULE);
const BASE = "http://127.0.0.1:3300", E2E = process.env.E2E_HOME, OUT = process.env.E2E_OUT, REPO = process.env.REPO;
const ELLOG = path.join(E2E, "logs/elevenlabs.jsonl"), FAILF = path.join(E2E, "run/el-fail"), DLOG = path.join(E2E, "logs/dispatch.jsonl");
const OWNER = { id: "11111111-1111-4111-8111-111111111111", email: "pilot-owner@local.test", password: "local-pass-owner-1" };
const ANA = "VozCatalogoAna01", LEO = "VozCatalogoLeo02";
fs.mkdirSync(OUT, { recursive: true });
const results = []; const log = (kind, name, detail = "") => { results.push({ kind, name, detail }); console.log(`${kind} ${name} ${detail}`); };
const ok = (name, cond, detail = "") => log(cond ? "PASS" : "FAIL", name, detail);
const finding = (name, detail = "") => log("FINDING", name, detail);
const ttsCalls = () => fs.existsSync(ELLOG) ? fs.readFileSync(ELLOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let db, browser;
const one = async (q, a = []) => (await db.query(q, a)).rows[0];
const workerEnv = (id, kind) => ({ ...process.env, ...Object.fromEntries(fs.readFileSync(path.join(E2E, "secrets/podcast-worker.env"), "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])), EPISODE_ID: id, JOB_KIND: kind, NPM_CONFIG_UPDATE_NOTIFIER: "false" });
const spawnWorker = (script, id, kind) => spawn("npx", ["tsx", script], { cwd: REPO, env: workerEnv(id, kind), detached: true, stdio: ["ignore", "pipe", "pipe"] });
const runTsx = (script, id, kind) => new Promise((res) => { const w = spawnWorker(script, id, kind); let o = ""; w.stdout.on("data", (d) => (o += d)); w.stderr.on("data", (d) => (o += d)); w.on("close", (c) => res({ code: c, out: o })); });
const killGroup = (w) => { try { process.kill(-w.pid, "SIGKILL"); } catch { try { w.kill("SIGKILL"); } catch {} } };

async function session(user) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await ctx.addInitScript(() => { try { localStorage.setItem("atomivid_onboarding_completed_v1", "1"); } catch {} });
  const p = await ctx.newPage(); p.setDefaultTimeout(60000);
  await p.goto(`${BASE}/login`); await p.fill("input[name=email]", user.email); await p.fill("input[name=password]", user.password);
  await p.locator("form button[type=submit]").last().click(); await p.waitForURL(/\/dashboard/);
  return { ctx, p };
}
async function createEpisode(p, o) {
  await p.goto(`${BASE}/dashboard/podcast`);
  const classic = p.getByText("Formulario clásico (grabación propia, guion A/B)"); if (await classic.count()) await classic.click();
  await p.getByLabel("Título", { exact: true }).fill(o.title);
  if (o.conversation) await p.getByLabel("Conversación (2 participantes)").check();
  await p.locator("textarea").fill(o.script);
  await p.locator("select:not([aria-label=\"Voz B\"])").filter({ has: p.locator(`option[value="${o.voiceA}"]`) }).first().selectOption(o.voiceA);
  if (o.conversation) { await p.getByLabel("Nombre A").fill("A"); await p.getByLabel("Nombre B").fill("B"); await p.getByLabel("Rol B").fill("Pregunta"); await p.getByLabel("Voz B").selectOption(o.voiceB); }
  await p.getByRole("button", { name: /Crear episodio/ }).click();
  await p.waitForURL(/\/dashboard\/podcast\/[0-9a-f-]{36}$/);
  return p.url().split("/").pop();
}
const api = async (p, method, url, body) => { const r = await p.request.fetch(`${BASE}${url}`, { method, data: body ?? undefined, headers: { "content-type": "application/json" } }); let j = {}; try { j = await r.json(); } catch {} return { st: r.status(), body: j }; };
const authRow = (id) => one("select cap_usd::float cap, authorization_ref ref from public.pi_spend_authorizations where project_id=$1", [`podcast-${id}`]);

async function f1(s) {
  console.log("== F1 video route: authorization opened by a request that is then refused");
  const id = await createEpisode(s.p, { title: "Auditoría F1 orden de la ruta de video", script: "Uno. Este episodio de auditoría tiene un guion corto para producir el video.\n\nDos. Nada de esto llama a un proveedor real.", voiceA: ANA });
  const n0 = ttsCalls().length, ep = await one("select estimated_usd::float est from public.podcast_episodes where id=$1", [id]);
  const tiny = Math.max(0.01, Math.round(ep.est * 100 / 4) / 100);
  const r1 = await api(s.p, "POST", `/api/podcast/${id}/video`, { budgetUsd: tiny, runBudgetUsd: tiny });
  ok("F1 insufficient total budget → refused (402/409), nothing dispatched or synthesized", [402, 409].includes(r1.st) && ttsCalls().length === n0, `${r1.st} «${String(r1.body.error ?? "").slice(0, 90)}» est=${ep.est} budget=${tiny}`);
  const a1 = await authRow(id);
  if (a1) finding("F1 (P1) the refused request already OPENED the immutable episode authorization", `cap=${a1.cap} ref=${a1.ref}`);
  else ok("F1 a refused request leaves no authorization behind", true);
  const enough = Math.ceil(ep.est * 3 * 100) / 100 + 1;
  const r2 = await api(s.p, "POST", `/api/podcast/${id}/video`, { budgetUsd: enough, runBudgetUsd: enough });
  const a2 = await authRow(id);
  if (r2.st === 202) ok("F1 the owner raises the budget → production accepted (202)", true, `cap=${a2?.cap}`);
  else finding("F1 (P1) after raising the total budget the episode can NEVER be produced: the cap fixed by the refused request is immutable", `${r2.st} «${String(r2.body.error ?? "").slice(0, 140)}» cap=${a2?.cap} budget=${enough}`);
  ok("F1 0 paid TTS calls across the whole sequence", ttsCalls().length === n0, `${ttsCalls().length - n0}`);
  await s.p.goto(`${BASE}/dashboard/podcast/${id}`); await s.p.screenshot({ path: path.join(OUT, "f1-episodio.png"), fullPage: true });
}

async function f2(s) {
  console.log("== F2 Podcast 2.1 narration worker killed with a paid TTS call in flight");
  const turns = Array.from({ length: 34 }, (_, i) => `${i % 2 ? "B" : "A"}: Turno ${i + 1} de la auditoría de interrupción. ${"Texto de relleno para que la narración vaya al worker en segundo plano. ".repeat(4)}`);
  const id = await createEpisode(s.p, { title: "Auditoría F2 worker matado en vuelo", conversation: true, script: turns.join("\n\n"), voiceA: LEO, voiceB: ANA });
  await api(s.p, "POST", `/api/podcast/${id}/video`, { cancel: true }).catch(() => null);
  const ep = await one("select estimated_usd::float est from public.podcast_episodes where id=$1", [id]);
  await db.query("update public.podcast_episodes set budget_usd=$2 where id=$1", [id, Math.ceil(ep.est * 4 * 100) / 100 + 1]);
  const d0 = fs.existsSync(DLOG) ? fs.statSync(DLOG).size : 0;
  const g = await api(s.p, "POST", `/api/podcast/${id}/generate`);
  ok("F2 long narration is queued for the background worker", [200, 202].includes(g.st), `${g.st} ${JSON.stringify(g.body).slice(0, 100)}`);
  const n0 = ttsCalls().length;
  const w = spawnWorker("scripts/podcast-video-worker.ts", id, "narration"); let wout = ""; w.stdout.on("data", (d) => (wout += d)); w.stderr.on("data", (d) => (wout += d));
  // let 3 calls complete, then make the NEXT call hang (the mock logs it = the provider received it) and kill the worker
  for (let i = 0; i < 600 && ttsCalls().length < n0 + 3; i++) await sleep(250);
  fs.writeFileSync(FAILF, "hang");
  for (let i = 0; i < 600 && fs.existsSync(FAILF); i++) await sleep(100);
  await sleep(800); killGroup(w); await sleep(1500);
  fs.appendFileSync(path.join(OUT, `f2-worker-${id}.log`), wout);
  const killedAt = ttsCalls().length - n0;
  const rows = (await db.query("select status, count(*)::int n from public.pi_paid_operations where project_id=$1 group by 1 order by 1", [`podcast-${id}`])).rows;
  const open = rows.filter((r) => ["SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED"].includes(r.status)).reduce((n, r) => n + r.n, 0);
  ok("F2 the in-flight call stays open in the ledger (SUBMITTED/uncertain), the paid ones COMMITTED", open >= 1 && rows.some((r) => r.status === "COMMITTED"), JSON.stringify(rows));
  // the GitHub workflow's mark-failed step for narration is a no-op (JOB_KIND=narration returns early) → only the stale heartbeat
  const g2 = await api(s.p, "POST", `/api/podcast/${id}/generate`);
  ok("F2 retry while a paid call is uncertain → 409 with the uncertain-charge message, no new TTS", g2.st === 409 && /incierto|concili/i.test(String(g2.body.error ?? "")) && ttsCalls().length - n0 === killedAt, `${g2.st} «${String(g2.body.error ?? "").slice(0, 100)}» calls=${ttsCalls().length - n0}/${killedAt}`);
  const v2 = await api(s.p, "POST", `/api/podcast/${id}/video`, { budgetUsd: 50 });
  ok("F2 video production is also refused while uncertain (409), no new TTS", v2.st === 409 && ttsCalls().length - n0 === killedAt, `${v2.st} «${String(v2.body.error ?? "").slice(0, 100)}»`);
  await s.p.goto(`${BASE}/dashboard/podcast/${id}`); await s.p.waitForTimeout(1500);
  const text = await s.p.locator("body").innerText(); await s.p.screenshot({ path: path.join(OUT, "f2-episodio-incierto.png"), fullPage: true });
  ok("F2 the episode page tells the owner (uncertain / reconcile / interrupted) — not a silent spinner", /incierto|concili|interrump|revis/i.test(text), text.replace(/\s+/g, " ").slice(0, 160));
  const row = await one("select status, error from public.podcast_episodes where id=$1", [id]);
  log("INFO", "F2 episode row after kill", JSON.stringify(row).slice(0, 200));
}

async function f3(s) {
  console.log("== F3 Podcast 3.0 studio worker killed with a studio paid call in flight");
  const { rows: [spec] } = await db.query("select 1");
  void spec;
  const fixtures = execFileSync("npx", ["tsx", "-e", 'import { DIALOGO } from "./scripts/podcast-3-0/fixtures"; process.stdout.write(JSON.stringify(DIALOGO))'], { cwd: REPO }).toString();
  const sp = JSON.parse(fixtures);
  const SID = "3c000000-0000-4000-8000-0000000000f3";
  await db.query("delete from public.podcast_studio_episodes where id=$1", [SID]);
  await db.query("insert into public.podcast_studio_episodes(id,user_id,title,mode,spec,status,estimated_usd,authorized_usd,authorized_at) values ($1,$2,'Auditoría F3 estudio',$3,$4,'authorized',0.5,5,now())", [SID, OWNER.id, sp.mode, sp]);
  const w = spawnWorker("scripts/podcast-video-worker.ts", SID, "studio"); let wout = ""; w.stdout.on("data", (d) => (wout += d)); w.stderr.on("data", (d) => (wout += d));
  let caught = null;
  for (let i = 0; i < 2400; i++) {
    const r = await one("select count(*) filter (where state='reserved')::int reserved, count(*) filter (where state='settled')::int settled from public.podcast_studio_operations where episode_id=$1", [SID]);
    if (r.reserved > 0 && r.settled >= 1) { killGroup(w); caught = r; break; }
    await sleep(15);
  }
  await sleep(1500); fs.appendFileSync(path.join(OUT, "f3-worker.log"), wout);
  if (!caught) { console.log(wout.slice(-3000)); ok("F3 caught the worker with a reservation in flight", false, "timing: no reserved row observed"); return; }
  const before = (await db.query("select key, state from public.podcast_studio_operations where episode_id=$1 order by created_at", [SID])).rows;
  ok("F3 killed mid-call: one row left 'reserved', the finished ones 'settled'", before.some((r) => r.state === "reserved") && before.some((r) => r.state === "settled"), JSON.stringify(before.map((r) => r.state)));
  const ep1 = await one("select status from public.podcast_studio_episodes where id=$1", [SID]);
  const g1 = await api(s.p, "GET", `/api/podcast/v3/${SID}`);
  ok("F3 without mark-failed the API shows 'generating' (no link, no false 'ready')", ep1.status === "generating" && g1.st === 200 && g1.body.video_url === null, `${ep1.status} ${g1.st}`);
  const a1 = await api(s.p, "POST", `/api/podcast/v3/${SID}`, { confirm: true, authorizedUsd: 5 });
  // With the F3 fix the API restarts a «generating» run only after the job timeout (4 h); this one is seconds old, so the
  // runner could still be alive → 409 is the correct answer (the 4 h path is covered by cierre.test.ts).
  if (a1.st === 409 && process.env.AUDIT_F3_FIXED === "1") ok("F3 a recent 'generating' run (runner may be alive) is not restarted from the API (409)", true);
  else if (a1.st === 409) finding("F3 (P2) a stale 'generating' studio episode (runner lost, mark-failed never ran) cannot be retried from the API (409 'Ya se está generando') although the run guard treats it as stale after 45 min", `${a1.st} «${String(a1.body.error ?? "").slice(0, 80)}»`);
  // what the workflow's "Mark failed if the step died" step does (JOB_KIND=studio)
  const mf = await runTsx("scripts/podcast-video-mark-failed.ts", SID, "studio");
  const after = (await db.query("select key, state from public.podcast_studio_operations where episode_id=$1 order by created_at", [SID])).rows;
  const ep2 = await one("select status, error from public.podcast_studio_episodes where id=$1", [SID]);
  ok("F3 mark-failed: episode 'failed' with a clear message, 'reserved' → 'uncertain' (never 'released')", ep2.status === "failed" && /STUDIO_MARKED_FAILED 1/.test(mf.out) && !after.some((r) => r.state === "reserved" || r.state === "released") && after.some((r) => r.state === "uncertain"), `${ep2.status} «${ep2.error}» ${JSON.stringify(after.map((r) => r.state))}`);
  const a2 = await api(s.p, "POST", `/api/podcast/v3/${SID}`, { confirm: true, authorizedUsd: 5 });
  ok("F3 owner presses Reintentar → authorized + dispatched", a2.st === 200, `${a2.st} ${JSON.stringify(a2.body).slice(0, 100)}`);
  const settledBefore = after.filter((r) => r.state === "settled").map((r) => r.key);
  const rr = await runTsx("scripts/podcast-video-worker.ts", SID, "studio");
  fs.appendFileSync(path.join(OUT, "f3-worker-retry.log"), rr.out);
  const final = (await db.query("select key, state from public.podcast_studio_operations where episode_id=$1 order by created_at", [SID])).rows;
  const ep3 = await one("select status, error from public.podcast_studio_episodes where id=$1", [SID]);
  const uncertainKey = after.find((r) => r.state === "uncertain").key;
  ok("F3 retry never re-calls the uncertain operation (still 'uncertain', no second row for it)", final.filter((r) => r.key === uncertainKey).length === 1 && final.find((r) => r.key === uncertainKey).state === "uncertain", JSON.stringify(final.map((r) => r.state)));
  ok("F3 what was paid before the cut is reused, not paid again (settled keys unchanged)", settledBefore.every((k) => final.some((r) => r.key === k && r.state === "settled")), `${settledBefore.length} settled`);
  ok("F3 retry stops with the uncertain-charge error visible to the owner (failed + message)", ep3.status === "failed" && /incierto|conciliar/i.test(ep3.error ?? ""), `${ep3.status} «${ep3.error}»`);
  const g3 = await api(s.p, "GET", `/api/podcast/v3/${SID}`);
  ok("F3 GET shows failed + error, no download link", g3.st === 200 && g3.body.episode?.status === "failed" && g3.body.video_url === null, `${g3.st}`);
}

(async () => {
  db = new Client({ connectionString: process.env.HARNESS_PG_URL }); await db.connect();
  browser = await chromium.launch(process.env.E2E_CHROME ? { executablePath: process.env.E2E_CHROME } : {}); const s = await session(OWNER);
  const only = (process.env.AUDIT_CASES || "f1,f2,f3").split(",");
  for (const [k, fn] of [["f1", f1], ["f2", f2], ["f3", f3]]) if (only.includes(k)) { try { await fn(s); } catch (e) { ok(`${k} completed without exception`, false, String(e).slice(0, 300)); } }
  await browser.close(); await db.end();
  const n = (k) => results.filter((r) => r.kind === k).length;
  fs.writeFileSync(path.join(OUT, "audit-summary.json"), JSON.stringify(results, null, 2));
  console.log(`RESULT ${n("PASS")} PASS / ${n("FAIL")} FAIL / ${n("FINDING")} FINDING`);
  process.exit(n("FAIL") ? 1 : 0);
})();
