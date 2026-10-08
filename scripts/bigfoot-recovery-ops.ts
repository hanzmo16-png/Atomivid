/**
 * Bigfoot recovery operations (job 03738404), authorized by the owner on 2026-10-08.
 * One mode per invocation (BIGFOOT_OPS_MODE); prints structure only (no emails, keys, prompts or script text).
 *   verify-rpc   : production checks of the recovery-budget migration; functional refusal test inside BEGIN/ROLLBACK
 *   inspect      : job, owner, REAL project_id (recomputed and matched), ledger, checkpoint, uncertain operations
 *   open-budget  : opens the USD 2.10 budget once and verifies its baseline is exactly the five COMMITTED operations
 *   recover      : the same fenced retry the "Reintentar" button performs (retryScriptJob with the owner id)
 *   status       : job state, ledger, budget usage, checkpoint hash
 *   close-budget : closes the budget (one-way); committed results stay reusable
 * The provider work itself only ever happens on the deployed app (scripts/documentary-script-worker.ts → Vercel).
 */
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { connectResolved } from "./lib/supabase-db";
import { documentarySupplyScope } from "../src/lib/supply/anthropic";
import { EDITORIAL_VERSION } from "../src/lib/video/long-form/editorial";
import { RESEARCH_VERSION } from "../src/lib/video/long-form/research";
import { retryScriptJob } from "../src/lib/video/long-form/script-jobs";
import { stableHash } from "../src/lib/production-intelligence/canonical";

const JOB_ID = "03738404-02ce-440a-a588-cb51ae4a0e9f";
const CAP_USD = "2.10";
const AUTHORIZATION = "owner authorization 2026-10-08: Bigfoot recovery, max USD 2.10 new spend, no extra rounds";
const EXPECTED_PROJECT_HASH = "012ff073f3";
const UNCERTAIN = ["SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED"];
const h10 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);
const log = (tag: string, v: unknown) => console.log(tag, JSON.stringify(v));

function service() {
  return createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
}

async function loadJob() {
  const db = service();
  const { data, error } = await db.from("documentary_script_jobs").select("*").eq("id", JOB_ID).maybeSingle();
  if (error || !data) throw Error(`job read failed ${error?.code ?? "missing"}`);
  return { db, job: data as Record<string, any> };
}

function projectOf(job: Record<string, any>) {
  const fields = job.input.fields;
  return documentarySupplyScope(job.user_id, { ...fields, editorialVersion: EDITORIAL_VERSION, researchVersion: RESEARCH_VERSION, creativeHistory: job.input.creativeHistory,
    ...(job.input.referenceContract ? { referenceContract: job.input.referenceContract } : {}) }, false).projectId;
}

async function ledger(db: ReturnType<typeof service>, projectId: string) {
  const { data, error } = await db.from("pi_paid_operations").select("idempotency_key,shot_id,status,reserved_usd,committed_usd,result_ref,created_at,provider").eq("project_id", projectId).order("created_at", { ascending: true });
  if (error) throw Error("ledger read failed");
  return data ?? [];
}

async function inspect() {
  const { db, job } = await loadJob();
  if (!/bigfoot|pie grande|sasquatch|big foot/i.test(job.topic)) throw Error("not the Bigfoot job");
  const projectId = projectOf(job);
  const ops = await ledger(db, projectId);
  const { data: owner } = await db.auth.admin.getUserById(job.user_id);
  const cp = job.editorial_checkpoint as { pass?: number; review?: unknown; status?: string } | null;
  const summary = {
    job: { status: job.status, stage: job.stage, failureKind: job.failure_kind, errorCode: job.error_code, errorMessage: String(job.error_message ?? "").slice(0, 300), retries: job.retry_count, rounds: job.editorial_rounds, running: !!job.run_token },
    owner: { confirmed: !!owner?.user?.email_confirmed_at, ownerMatchesProject: projectId.startsWith(`documentary:${job.user_id}:`) },
    project: { hash: h10(projectId), matchesExpected: h10(projectId) === EXPECTED_PROJECT_HASH, operations: ops.length },
    ledger: ops.map((o) => ({ key: h10(o.idempotency_key), status: o.status, reserved: o.reserved_usd, committed: o.committed_usd })),
    committed: ops.filter((o) => o.status === "COMMITTED").length,
    uncertain: ops.filter((o) => UNCERTAIN.includes(o.status)).length,
    editorial: job.editorial_checkpoint?.review ? {firstDelivered:job.editorial_checkpoint.review.firstAnswer?.delivered,endingResolved:job.editorial_checkpoint.review.ending?.resolvesPromise,sectionFunctions:job.editorial_checkpoint.review.sections?.map((x:any)=>x.function),findings:job.editorial_checkpoint.review.findings?.map((x:any)=>({kind:x.kind,severity:x.severity}))}:null,
    checkpoint: cp ? { status: cp.status, pass: cp.pass, reviewed: !!cp.review, hash: stableHash(cp, 16) } : null,
  };
  log("INSPECT", summary);
  return { db, job, projectId, ops, summary };
}

async function verifyRpc() {
  const { job, projectId } = await inspect();
  const { client } = await connectResolved();
  try {
    const q = async (sql: string, args: unknown[] = []) => (await client.query(sql, args)).rows;
    const [state] = await q(`select to_regprocedure('public.pi_submit_with_supply_core(text,numeric)') is not null as core,
      to_regclass('public.pi_recovery_budgets') is not null as tbl,
      has_function_privilege('service_role','public.pi_submit_with_supply(text,numeric)','execute') as wrapper_exec,
      has_function_privilege('service_role','public.pi_submit_with_supply_core(text,numeric)','execute') as core_exec,
      has_function_privilege('service_role','public.pi_open_recovery_budget(uuid,text,numeric,text)','execute') as open_exec,
      has_function_privilege('anon','public.pi_submit_with_supply(text,numeric)','execute') as anon_exec,
      has_function_privilege('authenticated','public.pi_submit_with_supply(text,numeric)','execute') as auth_exec,
      (select count(*) from public.pi_recovery_budgets)::int as budgets,
      (select prosecdef from pg_proc where oid = 'public.pi_submit_with_supply(text,numeric)'::regprocedure) as wrapper_definer,
      exists(select 1 from public._migrations_applied where name='20261008120000_documentary_recovery_budget.sql') as registered`);
    log("RPC_STATE", state);
    // Functional refusal on a FAKE project of the same owner, fully rolled back (no provider is reachable from SQL).
    await client.query("begin");
    try {
      const fakeJob = "00000000-0000-4000-8000-00000000b16f";
      const fakeProject = `documentary:${job.user_id}:rollback-verification`;
      await client.query(`insert into public.documentary_script_jobs(id,user_id,input_hash,topic,status,stage) values ($1,$2,'rollback-verification','rollback verification','failed','x')`, [fakeJob, job.user_id]);
      const opened = (await client.query(`select public.pi_open_recovery_budget($1,$2,0.05,'rollback verification') r`, [fakeJob, fakeProject])).rows[0].r;
      await client.query(`insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status)
        values ('rollback-verification-1',$1,'script:documentary:rv1','anthropic','claude-sonnet-5','generate_script','initial',0.06,'RESERVED')`, [fakeProject]);
      const refused = (await client.query(`select public.pi_submit_with_supply('rollback-verification-1',null) r`)).rows[0].r;
      const after = (await client.query(`select status from public.pi_paid_operations where idempotency_key='rollback-verification-1'`)).rows[0].status;
      let raised = "no";
      try { await client.query("savepoint s"); await client.query(`update public.pi_recovery_budgets set cap_usd=99 where project_id=$1`, [fakeProject]); }
      catch (e) { raised = e instanceof Error ? e.message.slice(0, 60) : "error"; await client.query("rollback to savepoint s"); }
      log("RPC_FUNCTIONAL", { opened: opened.opened, refusedReason: refused.reason, statusAfterRefusal: after, capRaiseBlocked: raised });
    } finally {
      await client.query("rollback");
    }
    const [left] = await q(`select count(*)::int n from public.pi_recovery_budgets where project_id like '%rollback-verification'`);
    log("RPC_ROLLBACK_CLEAN", { leftoverBudgets: left.n, realProjectHashUnchanged: h10(projectId) === EXPECTED_PROJECT_HASH });
  } finally {
    await client.end();
  }
}

async function openBudget() {
  const { job, projectId, ops, summary } = await inspect();
  if (summary.committed !== 5 || summary.uncertain !== 0 || ops.length !== 5 || !summary.project.matchesExpected || job.status !== "failed")
    throw Error("preconditions not met: expected exactly 5 COMMITTED operations, none uncertain, failed job, matching project");
  const { client } = await connectResolved();
  try {
    const r = (await client.query(`select public.pi_open_recovery_budget($1,$2,$3::numeric,$4) r`, [JOB_ID, projectId, CAP_USD, AUTHORIZATION])).rows[0].r;
    const b = (await client.query(`select cap_usd::text, baseline_keys, status, owner_id = $2::uuid as owner_ok, job_id = $3::uuid as job_ok from public.pi_recovery_budgets where project_id=$1`, [projectId, job.user_id, JOB_ID])).rows[0];
    const expected = ops.filter((o) => o.status === "COMMITTED").map((o) => o.idempotency_key).sort();
    const baseline = [...(b?.baseline_keys ?? [])].sort();
    log("OPEN_BUDGET", { result: r, cap: b?.cap_usd, status: b?.status, ownerOk: b?.owner_ok, jobOk: b?.job_ok,
      baselineCount: baseline.length, baselineIsExactlyTheFiveCommitted: JSON.stringify(baseline) === JSON.stringify(expected) });
    const u = (await client.query(`select public.pi_recovery_budget_usage($1) u`, [projectId])).rows[0].u;
    log("BUDGET_USAGE", u);
  } finally {
    await client.end();
  }
}

async function status() {
  const { db, projectId } = await inspect();
  const { data: u, error } = await db.rpc("pi_recovery_budget_usage", { p_project_id: projectId, p_exclude_key: null });
  log("BUDGET_USAGE", error ? { error: error.code } : u);
}

async function recover() {
  const { job, summary } = await inspect();
  if (summary.uncertain !== 0) throw Error("uncertain operation present: reconcile first, never resubmit");
  const { client } = await connectResolved();
  try {
    const b = (await client.query(`select status, cap_usd::text from public.pi_recovery_budgets where job_id=$1`, [JOB_ID])).rows[0];
    if (!b || b.status !== "ACTIVE" || b.cap_usd !== "2.100000") throw Error("recovery budget is not open at USD 2.10");
  } finally { await client.end(); }
  // Exactly the button's server logic: owner-scoped, fenced on updated_at, bounded by retry_count.
  const result = await retryScriptJob(job.user_id, JOB_ID, service());
  log("RETRY", { result });
  if (result !== "queued") throw Error("retry refused");
}

async function resumeBudget() {
  const { job, projectId, summary } = await inspect();
  if (!summary.project.matchesExpected || summary.uncertain !== 0 || job.status !== "failed") throw Error("resume preconditions not met");
  const { client } = await connectResolved();
  try {
    const before = (await client.query(`select public.pi_recovery_budget_usage($1) u`, [projectId])).rows[0].u;
    if (!before || Number(before.capUsd) !== 2.10 || before.baselineOperations !== 5) throw Error("original capped budget required");
    const r = (await client.query(`select public.pi_resume_recovery_budget($1,$2) r`, [JOB_ID,
      "owner authorization 2026-10-08 08:13 Cancun: consolidate V6 and continue Bigfoot within original USD2.10 cap; accumulated spend retained"])).rows[0].r;
    const after = (await client.query(`select public.pi_recovery_budget_usage($1) u`, [projectId])).rows[0].u;
    if (Number(after.capUsd) !== 2.10 || after.committedUsd !== before.committedUsd || after.baselineOperations !== 5 || after.status !== "ACTIVE") throw Error("resume invariant failed");
    log("RESUME_BUDGET", { resumed: r.resumed, usage: after, originalSpendPreserved: true });
  } finally { await client.end(); }
}

async function closeBudget() {
  const { client } = await connectResolved();
  try {
    const r = await client.query(`update public.pi_recovery_budgets set status='CLOSED', closed_at=clock_timestamp() where job_id=$1 and status='ACTIVE'`, [JOB_ID]);
    log("CLOSE_BUDGET", { closed: r.rowCount });
  } finally { await client.end(); }
  await status();
}

/** No writes: the persisted script → the SAME productPlan as Configurar/confirm-production → the worker's admission. */
async function v6Check() {
  const { db, job } = await loadJob();
  const { productPlan } = await import("../src/lib/video/long-form/product-plan");
  const { cinematicV6Enabled, assertCinematicV6Account } = await import("../src/lib/video/long-form/cinematic-v6-access");
  const { getRealLongFormProviderNames, resolveExecutablePlan } = await import("../src/lib/video/long-form/production-plan");
  const { data: req, error } = await db.from("video_requests").select("id,status,mode,topic,duration_seconds,script_json,long_form_confirmed_at").eq("id", job.request_id).maybeSingle();
  if (error || !req) { log("V6_CHECK", { scriptPersisted: false }); return; }
  const script = req.script_json as { topic?: string; beats: { id: string; type: string; purpose?: string; narration: string; visuals?: Record<string, unknown>[] }[]; editorial?: { status?: string } };
  const visuals = script.beats.flatMap((b) => b.visuals ?? []);
  const withImpact = visuals.filter((v) => [1, 2, 3].includes(v.impact as number) && typeof v.impactReason === "string" && (v.impactReason as string).trim());
  const withClass = visuals.filter((v) => typeof v.beatClass === "string");
  const { data: owner } = await db.auth.admin.getUserById(job.user_id);
  const enabled = cinematicV6Enabled(owner?.user);
  const beats = script.beats.map((b) => ({ id: b.id, type: b.type, purpose: b.purpose, narration: b.narration, visuals: b.visuals })) as never as Parameters<typeof productPlan>[0]["beats"];
  const results = (["economical", "balanced", "cinematic"] as const).map((strategy) => ({ strategy,
    ...productPlan({ beats, topic: script.topic || req.topic || "", strategy, providers: getRealLongFormProviderNames(), requestedDurationSeconds: req.duration_seconds ?? undefined, cinematicV6: enabled }) }));
  let workerAdmission = "not attempted";
  const v6 = results.find((r) => r.plan.version === 6);
  if (v6) {
    try {
      const plan = resolveExecutablePlan({ confirmedAt: new Date().toISOString(), plan: { ...v6.plan, confirmedAt: new Date().toISOString() } as never, beats: beats as never });
      await assertCinematicV6Account(plan, async () => owner?.user ?? null);
      workerAdmission = `admitted (plan v${plan.version})`;
    } catch (e) { workerAdmission = `refused: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`; }
  }
  let visualReadiness:unknown={checked:false};
  if(v6){const [{planSequenceShots},{resolveSequences,PLAN_ESTIMATE_AVAILABILITY,registryAvailability},{heroCoverage,VerifiedAssetRegistry},{requestedContracts,isAuthorizedCurator},{planReleaseBlockers},{containsFixtureOnlyMaterial}]=await Promise.all([import("../src/lib/video/long-form/sequence-direction"),import("../src/lib/video/long-form/sequence-intent"),import("../src/lib/video/long-form/verified-assets"),import("../src/lib/video/long-form/asset-curation"),import("../src/lib/video/long-form/cinematic-director"),import("../src/lib/video/long-form/fixture-only")]);
  const estimate=planSequenceShots(beats,resolveSequences(v6.plan.sequences!,PLAN_ESTIMATE_AVAILABILITY)).shots;
  const f=await db.storage.from("videos").download(req.id+"/state/curation.json");let registry=VerifiedAssetRegistry.empty();let assetState="no curated asset file";
  if(!f.error&&f.data){const raw=JSON.parse(await f.data.text());if(containsFixtureOnlyMaterial(raw))throw Error("fixture assets in real request");registry=VerifiedAssetRegistry.rehydrate(raw,{requestId:req.id,isAuthorizedCurator,requestedContracts:new Set(requestedContracts(estimate).keys())});assetState=process.env.ASSET_CURATOR_EMAILS?"curation checked":"file present; curator authority unavailable in this diagnostic";}
  const shots=planSequenceShots(beats,resolveSequences(v6.plan.sequences!,registryAvailability(registry))).shots;
  const coverage=heroCoverage(shots,registry,0.25);const blockers=planReleaseBlockers(shots).map(x=>x.code);
  visualReadiness={checked:true,assetState,verifiedAssets:registry.size,blockerCodes:[...blockers,...coverage.blockers],missingHeroIdentities:coverage.heroMissingRequiredIdentities.length,missingHeroEvidence:coverage.heroMissingRequiredEvidence.length,ready:blockers.length===0&&coverage.blockers.length===0};
  }
  log("TRANSITION_FIELDS",{scenes:script.beats.flatMap((b,beatIndex)=>(b.visuals??[]).flatMap((v,visualIndex)=>v.beatClass==="TRANSITION"?[{beatIndex,visualIndex,motion:v.motion,actionType:typeof v.action,actionLength:typeof v.action==="string"?(v.action as string).trim().length:null,hasIdentity:!!v.identity,hasEvidence:!!v.evidence}]:[]))});
  log("V6_CHECK", { curatorEnvConfigured: !!process.env.ASSET_CURATOR_EMAILS, curatorConfigHash: process.env.ASSET_CURATOR_EMAILS ? h10(process.env.ASSET_CURATOR_EMAILS.split(",").map(s=>s.trim().toLowerCase()).sort().join(",")) : null, visualReadiness, request: { status: req.status, mode: req.mode, confirmed: !!req.long_form_confirmed_at, editorial: script.editorial?.status },
    beats: script.beats.length, visuals: visuals.length, visualsWithImpact: withImpact.length, visualsWithClass: withClass.length,
    workerEnvEnabled: enabled, plans: results.map((r) => ({ strategy: r.strategy, version: r.plan.version, engine: r.engine, reason: r.reason, sequences: r.plan.sequences?.length ?? 0, estimatedUsd: r.plan.estimatedProviderCostUsd })),
    workerAdmission, configurePath: `/dashboard/long-form/configure/${job.request_id}` });
}


async function applyReviewedResumeMigration() {
  // Explicit owner-authorized operator route for this reviewed function definition.
  // Generic migration safety scanning stays unchanged. No recovery budget is reopened here.
  const { readFile } = await import("node:fs/promises");
  const name = "20261008131541_documentary_recovery_resume.sql";
  const sql = await readFile(`supabase/migrations/${name}`, "utf8");
  if (createHash("sha256").update(sql).digest("hex") !== "07dcca76b4cf7d03fe33e5003c6259cc5a6bace76f97e056929d0288e4ffcfcd") throw Error("reviewed migration hash mismatch");
  const { client } = await connectResolved();
  try {
    const before = (await client.query("select public.pi_recovery_budget_usage($1) u", [projectOf((await loadJob()).job)])).rows[0].u;
    if (Number(before?.capUsd) !== 2.10 || before.baselineOperations !== 5 || before.status !== "CLOSED" || Number(before.pendingUsd) !== 0) throw Error("migration preconditions not met");
    await client.query("begin");
    try {
      const applied = (await client.query("select 1 from public._migrations_applied where name=$1", [name])).rows.length;
      if (!applied) { await client.query(sql); await client.query("insert into public._migrations_applied(name) values($1)", [name]); }
      const perms = (await client.query("select has_function_privilege('service_role','public.pi_resume_recovery_budget(uuid,text)','execute') app_exec, has_function_privilege('anon','public.pi_resume_recovery_budget(uuid,text)','execute') anon_exec")).rows[0];
      if (perms.app_exec || perms.anon_exec) throw Error("operator function exposed");
      const after = (await client.query("select public.pi_recovery_budget_usage($1) u", [projectOf((await loadJob()).job)])).rows[0].u;
      if (JSON.stringify(before) !== JSON.stringify(after)) throw Error("migration changed budget");
      await client.query("commit");
      log("REVIEWED_MIGRATION", { name, applied: !applied, operatorOnly: true, budgetUnchanged: true, hashVerified: true });
    } catch(error) { await client.query("rollback"); throw error; }
  } finally { await client.end(); }
}

async function reviewFormatDiagnostic() {
 const { db, job } = await loadJob(); const projectId=projectOf(job);
 if(h10(projectId)!==EXPECTED_PROJECT_HASH) throw Error("scope mismatch");
 const ops=await ledger(db,projectId); const o=ops.filter(x=>x.status==="COMMITTED").at(-1);
 if(!o?.result_ref) throw Error("missing saved response");
 const f=await db.storage.from("videos").download(o.result_ref); if(f.error||!f.data) throw Error("download");
 const r=JSON.parse(await f.data.text()); const t=r.content.filter((b:any)=>b.type==="text").map((b:any)=>b.text??"").join("").trim();
 const j=t.replace(/^\x60\x60\x60(?:json)?\\s*\\n([\\s\\S]*?)\\n\x60\x60\x60$/i,"$1");
 let valid=false,offset:number|null=null;try{JSON.parse(j);valid=true;}catch(e){const m=(e instanceof Error?e.message:"").match(/position (\\d+)/);offset=m?Number(m[1]):null;const lc=(e instanceof Error?e.message:"").match(/line (\d+) column (\d+)/);if(offset===null&&lc){const lines=j.split("\\n");offset=lines.slice(0,Number(lc[1])-1).reduce((n:number,l:string)=>n+l.length+1,0)+Number(lc[2])-1;} log("JSON_ERROR_KIND",{knownReason:["Expected property name","Expected ',' or '}'","Expected ',' or ']'","Unterminated string","Bad control character","Unexpected non-whitespace character","Unexpected token","Expected ':'"].find(k=>(e instanceof Error?e.message:"").startsWith(k))??"other",line:lc?Number(lc[1]):null,column:lc?Number(lc[2]):null});}
 if(offset!==null){const {LenientReferencedReviewSchema}=await import("../src/lib/video/long-form/narration-catalog");for(const [kind,x] of [["insert-object-end",j.slice(0,offset)+"}"+j.slice(offset)],["replace-array-end",j.slice(0,offset)+"}"+j.slice(offset+1)],["delete-array-end",j.slice(0,offset)+j.slice(offset+1)]] as const){try{const v=JSON.parse(x);const p=LenientReferencedReviewSchema.safeParse(v);log("SYNTAX_CANDIDATE",{kind,validJson:true,validSchema:p.success,issues:p.success?[]:p.error.issues.map(i=>({code:i.code,path:i.path}))});}catch{log("SYNTAX_CANDIDATE",{kind,validJson:false});}}}
 const c=offset===null?"":j[offset]; const classify=(c:string)=>!c?"end":/[{}\\[\\]:,"]/.test(c)?c:/\\s/.test(c)?"whitespace":/[0-9]/.test(c)?"digit":/[A-Za-z]/.test(c)?"letter":"other";
 const {readEditorialJson}=await import("../src/lib/video/long-form/editorial-json");const {LenientReferencedReviewSchema}=await import("../src/lib/video/long-form/narration-catalog");try{readEditorialJson(r,LenientReferencedReviewSchema);log("STRICT_READER",{acceptedComplete:true});}catch{log("STRICT_READER",{acceptedComplete:false});}
 log("REVIEW_FORMAT",{key:h10(o.idempotency_key),stopReason:r.stop_reason,textLength:t.length,startsObject:j.startsWith("{"),endsObject:j.endsWith("}"),fenceWrapped:t.startsWith("\x60\x60\x60"),validJson:valid,offset,codePoint:c.codePointAt(0),syntaxWindow:offset===null?null:[...j.slice(Math.max(0,offset-35),offset+35)].map(x=>/[A-Za-z0-9]/.test(x)?"x":/\s/.test(x)?" ":x).join(""),character:classify(c),previous:offset===null?null:classify(j[offset-1]),next:offset===null?null:classify(j[offset+1]),braceBalance:[...j].reduce((n,c)=>n+(c==="{"?1:c==="}"?-1:0),0)});
}
async function recoverAfterFormatFix() {
 const {db,job,projectId,ops}=await inspect();
 if(job.status!=="failed"||job.failure_kind!=="technical"||job.error_code!=="c5a8f5bc"||job.run_token||job.retry_count!==3||job.editorial_rounds!==1||stableHash(job.editorial_checkpoint,16)!=="11c480c175465e40"||ops.length!==13||ops.some(o=>o.status!=="COMMITTED")) throw Error("exact saved format incident required");
 const {client}=await connectResolved();
 try {const usage=(await client.query("select public.pi_recovery_budget_usage($1) u",[projectId])).rows[0].u;
 if(usage.status!=="ACTIVE"||Number(usage.capUsd)!==2.1||usage.baselineOperations!==5||Number(usage.pendingUsd)!==0)throw Error("same active cap required");}finally{await client.end();}
 const o=ops.at(-1)!;const f=await db.storage.from("videos").download(o.result_ref);if(f.error||!f.data)throw Error("saved review unavailable");
 const {readEditorialJson}=await import("../src/lib/video/long-form/editorial-json");
 const {LenientReferencedReviewSchema}=await import("../src/lib/video/long-form/narration-catalog");
 const {sectionFunctionRepairTargets}=await import("../src/lib/video/long-form/editorial-function-repair");
 const value=readEditorialJson(JSON.parse(await f.data.text()),LenientReferencedReviewSchema);
 const targets=sectionFunctionRepairTargets(value,LenientReferencedReviewSchema);
 if(!targets||targets.length!==1||targets[0]!==3)throw Error("saved syntax repair mismatch");
 const {data,error}=await db.from("documentary_script_jobs").update({status:"queued",run_token:null,failure_kind:null,error_code:null,error_message:null,stage:"Reanudando tras corregir el formato guardado",updated_at:new Date().toISOString()}).eq("id",JOB_ID).eq("user_id",job.user_id).eq("status","failed").is("run_token",null).eq("updated_at",job.updated_at).select("id");
 if(error||data?.length!==1)throw Error("incident lease lost");
 log("FORMAT_RECOVERY",{result:"queued",savedResponses:13,retryCountPreserved:3,editorialRoundPreserved:1,capPreserved:2.10,originalCheckpointPreserved:true,ownerAuthorization:"2026-10-08 consolidate V6 and produce; after deployed format fix only"});
}
async function visualAnchorDiagnostic() {
 const {db,job,projectId,ops}=await inspect();if(h10(projectId)!==EXPECTED_PROJECT_HASH)throw Error("scope mismatch");
 const {narrationCatalog}=await import("../src/lib/video/long-form/narration-catalog");const catalog=narrationCatalog(job.editorial_checkpoint.script.beats);const o=ops.at(-1)!;
 const f=await db.storage.from("videos").download(o.result_ref);if(f.error||!f.data)throw Error("download");
 const {readDocumentaryJson}=await import("../src/lib/video/long-form/json-response");const raw=readDocumentaryJson(JSON.parse(await f.data.text())) as {visuals:any[]};
 const expected=catalog.filter(e=>e.beatIndex===2);
 log("VISUAL_ANCHORS",{visuals:raw.visuals.map((v,i)=>({index:i,id:/^[a-f0-9]{16}:b[0-9]+:w[0-9]+$/.test(v.excerptId)?v.excerptId:"non-catalog-shape",validId:expected.some(e=>e.id===v.excerptId),knownOtherBeat:catalog.find(e=>e.id===v.excerptId)?.beatIndex,quoteSupplied:typeof v.quote==="string",class:v.beatClass,impact:v.impact,hasReason:typeof v.impactReason==="string"})),expectedIds:expected.map(e=>e.id),referencesToApprovedDraftOnly:true});
}
async function recoverVisualAnchors() {
 const {db,job,projectId,ops}=await inspect();
 if(job.status!=="failed"||job.failure_kind!=="technical"||!((job.error_code==="d156ef2c"&&ops.length===19)||(job.error_code==="e6f2edd6"&&ops.length===20))||job.run_token||job.retry_count!==3||job.editorial_rounds!==2||stableHash(job.editorial_checkpoint,16)!=="b8e5818d5d9e611b"||ops.some(o=>o.status!=="COMMITTED"))throw Error("exact approved visual incident required");
 if(ops.length===20){const f=await db.storage.from("videos").download(ops.at(-1)!.result_ref);if(f.error||!f.data)throw Error("saved repair missing");const {readDocumentaryJson}=await import("../src/lib/video/long-form/json-response");const {narrationCatalog}=await import("../src/lib/video/long-form/narration-catalog");const ids=new Set(narrationCatalog(job.editorial_checkpoint.script.beats).filter(e=>e.beatIndex===2).map(e=>e.id));const r=readDocumentaryJson(JSON.parse(await f.data.text())) as {replacements:{index:number;excerptId:string}[]};if(JSON.stringify(r.replacements.map(x=>x.index))!=="[0,1,4,5,7]"||r.replacements.some(x=>!ids.has(x.excerptId)))throw Error("exact five backed scenes required");}
 const {editorialBlockers}=await import("../src/lib/video/long-form/editorial");if(!job.editorial_checkpoint.review||editorialBlockers(job.editorial_checkpoint.review).length)throw Error("editorial blockers present");
 const {client}=await connectResolved();try{const u=(await client.query("select public.pi_recovery_budget_usage($1) u",[projectId])).rows[0].u;if(u.status!=="ACTIVE"||Number(u.capUsd)!==2.1||u.baselineOperations!==5||Number(u.pendingUsd)!==0)throw Error("same original cap required");}finally{await client.end();}
 const {data,error}=await db.from("documentary_script_jobs").update({status:"queued",run_token:null,failure_kind:null,error_code:null,error_message:null,stage:"Reanudando referencias del plan V6",updated_at:new Date().toISOString()}).eq("id",JOB_ID).eq("user_id",job.user_id).eq("status","failed").is("run_token",null).eq("updated_at",job.updated_at).select("id");
 if(error||data?.length!==1)throw Error("incident lease lost");
 log("ANCHOR_RECOVERY",{result:"queued",savedResponses:ops.length,retryCountPreserved:3,editorialRoundPreserved:2,approvedNarrationPreserved:true,capPreserved:2.10,authorization:"owner 2026-10-08 consolidate V6; deployed anchor repair required"});
}
async function visualRepairDiagnostic(){
 const {db,job,ops}=await inspect();const {narrationCatalog}=await import("../src/lib/video/long-form/narration-catalog");const ids=new Set(narrationCatalog(job.editorial_checkpoint.script.beats).filter(e=>e.beatIndex===2).map(e=>e.id));
 const {readDocumentaryJson}=await import("../src/lib/video/long-form/json-response");const f=await db.storage.from("videos").download(ops.at(-1)!.result_ref);if(f.error||!f.data)throw Error("download");const r=readDocumentaryJson(JSON.parse(await f.data.text())) as {replacements:{index:number;excerptId:string}[]};
 log("VISUAL_REPAIR",{selected:r.replacements.map(x=>({index:x.index,validId:ids.has(x.excerptId)})),omitted:Array.from({length:8},(_,i)=>i).filter(i=>!r.replacements.some(x=>x.index===i))});
}
async function verifyBackedScenes(){
 const {db,job,ops}=await inspect();if(ops.length!==20||job.error_code!=="e6f2edd6")throw Error("exact incident required");
 const {readDocumentaryJson}=await import("../src/lib/video/long-form/json-response");const {narrationCatalog}=await import("../src/lib/video/long-form/narration-catalog");const {applyVisualAnchorRepair}=await import("../src/lib/video/long-form/visual-anchor-repair");
 const read=async(o:any)=>{const f=await db.storage.from("videos").download(o.result_ref);if(f.error||!f.data)throw Error("download");return readDocumentaryJson(JSON.parse(await f.data.text()));};
 const original=await read(ops[18]) as {visuals:any[]};const repair=await read(ops[19]);const catalog=narrationCatalog(job.editorial_checkpoint.script.beats).filter(e=>e.beatIndex===2);
 const result=applyVisualAnchorRepair(original,catalog,Array.from({length:8},(_,i)=>i),repair);const indices=[0,1,4,5,7];
 const unchanged=result.visuals.every((v,i)=>stableHash({...v,excerptId:original.visuals[indices[i]].excerptId},16)===stableHash(original.visuals[indices[i]],16));
 if(result.visuals.length!==5||!unchanged)throw Error("preservation failed");
 log("BACKED_SCENES",{kept:5,discardedUnsupported:3,allRetainedFieldsUnchanged:unchanged,approvedNarrationUnchanged:true,cachedRepairReused:true,newPaidCalls:0,productionWrites:0});
}
/** Read-only provider capacity: the same pi_supply_state the paid-call gate uses, plus the latest balance snapshot time. */
async function supplyCheck() {
  const db = service();
  const { data: policies, error } = await db.from("pi_supply_policies").select("provider,enabled,unit,unit_cost_usd,daily_cap_usd,monthly_cap_usd,max_concurrent,timezone").order("provider");
  if (error) throw Error(`policies read failed ${error.code ?? ""}`);
  const rows = [];
  for (const p of policies ?? []) {
    const { data: state, error: se } = await db.rpc("pi_supply_state", { p_provider: p.provider });
    const { data: snap } = await db.from("pi_capacity_snapshots").select("checked_at,health,status,reliability,available,unit").eq("provider", p.provider).order("checked_at", { ascending: false }).limit(1).maybeSingle();
    const st = (state ?? {}) as Record<string, unknown>;
    const level = se ? "UNKNOWN" : String(st.level ?? "UNKNOWN");
    rows.push({ provider: p.provider, enabled: p.enabled, level, verdict: level === "GREEN" || level === "YELLOW" ? "Suficiente" : level === "RED" ? "Insuficiente" : "Sin verificar",
      reason: st.reason ?? (se ? `rpc ${se.code}` : null), unit: p.unit, free: st.free ?? null, unreserved: st.unreserved ?? null, activeCalls: st.activeCalls ?? null,
      dailyCapUsd: p.daily_cap_usd, monthlyCapUsd: p.monthly_cap_usd, snapshotAt: snap?.checked_at ?? null, snapshotHealth: snap?.health ?? null, snapshotSource: snap?.reliability ?? null });
  }
  log("SUPPLY", { checkedAt: new Date().toISOString(), providers: rows });
}
async function readiness() { await supplyCheck(); await v6Check(); }

/** Read-only: exactly what the Configure pre-flight panel computes for Bigfoot (same functions, no writes, no refresh). */
async function preflightPreview() {
  const { db, job } = await loadJob();
  const { productPlan } = await import("../src/lib/video/long-form/product-plan");
  const { getRealLongFormProviderNames } = await import("../src/lib/video/long-form/production-plan");
  const { strategyPreflight, visualCheck, visualBlockMessage } = await import("../src/lib/video/long-form/production-preflight");
  const { data: req } = await db.from("video_requests").select("id,topic,duration_seconds,script_json").eq("id", job.request_id).single();
  const script = req!.script_json as { topic?: string; beats: never[] };
  const plans = Object.fromEntries((["economical", "balanced", "cinematic"] as const).map((s) => [s, productPlan({ beats: script.beats, topic: script.topic || req!.topic, strategy: s, providers: getRealLongFormProviderNames(), requestedDurationSeconds: req!.duration_seconds ?? undefined, cinematicV6: true }).plan]));
  const strategies = [];
  for (const s of ["economical", "balanced", "cinematic"] as const) strategies.push(await strategyPreflight(db, { strategy: s, plan: plans[s], scriptJson: req!.script_json }));
  const visual = await visualCheck(db, { requestId: req!.id, plan: plans.balanced, beats: script.beats, topic: script.topic || req!.topic });
  log("PREFLIGHT", { checkedAt: new Date().toISOString(), strategies: strategies.map((p) => ({ strategy: p.strategy, estimatedUsd: p.estimatedUsd, limitUsd: p.limitUsd, withinLimit: p.withinLimit, capacityReady: p.capacityReady, globalNote: p.globalNote,
    providers: p.providers.map((x) => ({ provider: x.provider, verdict: x.verdict, needUnits: x.needUnits, unit: x.unit, needUsd: Math.round(x.needUsd * 10000) / 10000, freeUnits: x.freeUnits, action: x.action })) })),
    visual, visualMessage: visual.ready ? null : visualBlockMessage(visual) });
}

/** Public repo => public logs: script content leaves the runner ONLY encrypted to this session's public key. */
function sealed(tag: string, value: unknown) {
  const { publicEncrypt, randomBytes, createCipheriv, constants } = require("node:crypto") as typeof import("node:crypto");
  const pub = require("node:fs").readFileSync("ops/session-public-key.txt", "utf8");
  const key = randomBytes(32), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  const ek = publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  console.log(`SEALED ${tag} ${[ek, iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join(".")}`);
}
/** Read-only: every visual contract the Bigfoot plan requests, HERO requirements, scenes and research sources (sealed). */
async function contractsSealed() {
  const { db, job } = await loadJob();
  const { productPlan } = await import("../src/lib/video/long-form/product-plan");
  const { getRealLongFormProviderNames } = await import("../src/lib/video/long-form/production-plan");
  const { curationPlanShots } = await import("../src/lib/video/long-form/curation-plan");
  const { requestedContracts } = await import("../src/lib/video/long-form/asset-curation");
  const { visualReleasePreflight } = await import("../src/lib/video/long-form/visual-release-preflight");
  const { data: req } = await db.from("video_requests").select("id,topic,duration_seconds,script_json").eq("id", job.request_id).single();
  const script = req!.script_json as { topic?: string; beats: { id: string; narration: string; visuals?: Record<string, unknown>[] }[]; sources?: { id: string; title?: string; locator?: string; kind?: string }[] };
  const plan = productPlan({ beats: script.beats as never, topic: script.topic || req!.topic, strategy: "balanced", providers: getRealLongFormProviderNames(), requestedDurationSeconds: req!.duration_seconds ?? undefined, cinematicV6: true }).plan;
  const shots = curationPlanShots(script.beats as never, script.topic || req!.topic, plan);
  const requested = requestedContracts(shots);
  const pre = await visualReleasePreflight({ supabase: db, requestId: req!.id, plan, beats: script.beats as never, topic: script.topic || req!.topic });
  const byId = new Map(shots.map((s) => [s.id, s]));
  const contracts = [...requested.values()].map((r) => ({ key: r.key, contract: r.contract, heroSeconds: r.heroSeconds,
    scenes: r.shotIds.map((id) => { const s = byId.get(id) as unknown as { startSec: number; endSec: number; anchoredVisual?: Record<string, unknown> }; return { id, start: Math.round(s?.startSec ?? 0), end: Math.round(s?.endSec ?? 0), visual: s?.anchoredVisual ? { description: s.anchoredVisual.description, subject: s.anchoredVisual.subject, place: s.anchoredVisual.place, era: s.anchoredVisual.era, beatClass: s.anchoredVisual.beatClass, quote: s.anchoredVisual.quote } : null }; }) }));
  log("CONTRACTS_COUNT", { contracts: contracts.length, identities: contracts.filter((c) => c.contract.kind === "IDENTITY").length, evidence: contracts.filter((c) => c.contract.kind === "EVIDENCE").length,
    heroMissingIdentities: pre.coverage?.heroMissingRequiredIdentities.length, heroMissingEvidence: pre.coverage?.heroMissingRequiredEvidence.length, plannedShots: pre.plannedShotCount, textCardRatio: pre.coverage?.estimatedTextCardRatio });
  sealed("CONTRACTS", { topic: script.topic, requestId: req!.id, contracts, heroRequired: { identities: pre.coverage?.heroMissingRequiredIdentities, evidence: pre.coverage?.heroMissingRequiredEvidence },
    missingAll: { identities: pre.coverage?.missingIdentities, evidence: pre.coverage?.missingEvidence }, coverage: pre.coverage, blockers: pre.blockers, sources: (script.sources ?? []).map((x) => ({ id: x.id, title: x.title, locator: x.locator, kind: x.kind })) });
}

/**
 * $0 real-voice check of the podcast pipeline: takes ONE narration already generated and paid
 * (an existing COMMITTED ElevenLabs result, real speech), runs it through the podcast's own-recording
 * path (byte sniff, full decode, -16 LUFS master) and stores it as an episode of the Bigfoot owner,
 * so it can be played and downloaded in the app. No provider call, no new spend. Prints numbers only.
 */
async function podcastRealVoice() {
  const db = service();
  process.env.FFMPEG_BIN ||= require("@ffmpeg-installer/ffmpeg").path;
  const { masterRecording } = await import("../src/lib/podcast/recording");
  const { measureNarrationSeconds } = await import("../src/lib/video/avatar/measure-narration");
  const { data: req } = await db.from("video_requests").select("user_id").eq("id", "5bc99f47-7759-48c7-a2a2-92a282d97f78").maybeSingle();
  if (!req) throw Error("owner not found");
  const { data: ops } = await db.from("pi_paid_operations").select("result_ref,project_id,committed_usd,updated_at").eq("provider", "elevenlabs").eq("status", "COMMITTED").like("result_ref", "%.json").order("updated_at", { ascending: false }).limit(25);
  for (const op of ops ?? []) {
    const { data: metaBlob } = await db.storage.from("videos").download(op.result_ref);
    if (!metaBlob) continue;
    const meta = JSON.parse(await metaBlob.text()) as { audioPath?: string; durationSeconds?: number; sha256?: string };
    if (!meta.audioPath || !(Number(meta.durationSeconds) >= 15 && Number(meta.durationSeconds) <= 900)) continue;
    const { data: audio } = await db.storage.from("videos").download(meta.audioPath);
    if (!audio) continue;
    const buf = Buffer.from(await audio.arrayBuffer());
    if (createHash("sha256").update(buf).digest("hex") !== meta.sha256) continue;
    const m = await masterRecording(buf, measureNarrationSeconds);
    if ("error" in m) { log("PODCAST_REAL_VOICE_SKIP", { project: h10(op.project_id), error: m.error }); continue; }
    const { data: ep, error } = await db.from("podcast_episodes").insert({ user_id: req.user_id, title: "Prueba de voz real (audio ya pagado, costo 0)", language: "es", source: "upload", status: "generating" }).select("id").single();
    if (error || !ep) throw Error(`episode insert failed ${error?.code ?? ""}`);
    const audioPath = `${req.user_id}/podcasts/${ep.id}/episode.m4a`;
    const up = await db.storage.from("videos").upload(audioPath, m.bytes, { contentType: "audio/mp4", upsert: true });
    if (up.error) throw Error("upload failed");
    await db.from("podcast_episodes").update({ status: "ready", audio_path: audioPath, audio_mime: "audio/mp4", duration_seconds: m.durationSeconds, audio_sha256: m.sha256, audio_bytes: m.bytes.length, loudness: m.loudness, cost_usd: 0 }).eq("id", ep.id);
    const signed = await db.storage.from("videos").createSignedUrl(audioPath, 60);
    log("PODCAST_REAL_VOICE", { episodeId: ep.id, sourceProject: h10(op.project_id), sourceSeconds: meta.durationSeconds, masteredSeconds: Math.round(m.durationSeconds), lufs: m.loudness.integratedLufs, truePeak: m.loudness.truePeakDbtp, bytes: m.bytes.length, signedUrlOk: !!signed.data?.signedUrl, newSpendUsd: 0 });
    return;
  }
  throw Error("no stored real narration usable");
}

/**
 * Read-only "what would it take" check with the EXISTING preflight (visualReleasePreflight): the
 * Bigfoot plan is evaluated with hypothetical approvals built in memory through the same
 * propose → curator decision → rehydrate path as the tests. Placeholder assets only; nothing is
 * proposed, approved or written. Prints contract labels and blocker codes only (no script text).
 */
async function coverageScenarios() {
  const { db, job } = await loadJob();
  const { productPlan } = await import("../src/lib/video/long-form/product-plan");
  const { getRealLongFormProviderNames } = await import("../src/lib/video/long-form/production-plan");
  const { curationPlanShots } = await import("../src/lib/video/long-form/curation-plan");
  const { requestedContracts } = await import("../src/lib/video/long-form/asset-curation");
  const { visualReleasePreflight } = await import("../src/lib/video/long-form/visual-release-preflight");
  const { curateFixture, rehydrateFixture } = await import("../src/lib/video/long-form/cinematic-simulation");
  const { data: req } = await db.from("video_requests").select("id,topic,duration_seconds,script_json").eq("id", job.request_id).single();
  const script = req!.script_json as { topic?: string; beats: unknown[] };
  const topic = script.topic || req!.topic;
  const plan = productPlan({ beats: script.beats as never, topic, strategy: "balanced", providers: getRealLongFormProviderNames(), requestedDurationSeconds: req!.duration_seconds ?? undefined, cinematicV6: true }).plan;
  const requested = requestedContracts(curationPlanShots(script.beats as never, topic, plan));
  const LABEL: Record<string, string> = { "IDENTITY:roger patterson and bob gimlin": "I1", "IDENTITY:roger patterson": "I2", "IDENTITY:bob heironimus": "I3",
    "EVIDENCE:web-2+web-5": "E1", "EVIDENCE:web-2": "E2", "EVIDENCE:web-2+web-4": "E3", "EVIDENCE:web-1": "E4", "EVIDENCE:web-5": "E5" };
  const keyOf = (label: string) => Object.entries(LABEL).find(([, l]) => l === label)?.[0];
  log("SIM_CONTRACTS", [...requested.keys()].map((k) => LABEL[k] ?? `unlabeled:${h10(k)}`));
  const placeholder = (label: string) => ({ id: `sim-${label}`, source: "licensed_archive" as const, sourceUrl: `https://simulation.invalid/${label}`, mediaUrl: `https://simulation.invalid/${label}.jpg`,
    mediaType: "image" as const, mime: "image/jpeg", width: 2400, height: 1600, rights: { kind: "LICENSED" as const, rightsReference: `simulation-${label}` }, creditText: "simulation", description: "simulation placeholder" });
  const scenarios: Record<string, string[]> = {
    S0_actual: [], S1_pelicula: ["E1", "E2", "E3"], S2_pelicula_periodico: ["E1", "E2", "E3", "E4"], S3_pelicula_foto1967: ["E1", "E2", "E3", "I1", "I2"],
    S4_todo_HERO: ["I1", "I2", "E1", "E2", "E3", "E4"], S5_todo: ["I1", "I2", "I3", "E1", "E2", "E3", "E4", "E5"],
  };
  for (const [name, labels] of Object.entries(scenarios)) {
    const approvals = labels.map((l) => ({ asset: placeholder(l), key: keyOf(l)! })).filter((a) => a.key && requested.has(a.key));
    const registry = rehydrateFixture(curateFixture(approvals, requested, req!.id), req!.id, requested);
    const pre = await visualReleasePreflight({ supabase: db, requestId: req!.id, plan, beats: script.beats as never, topic, verifiedAssets: registry });
    const codes = [...new Set(pre.blockers.map((b) => b.replace(/^HERO_COVERAGE\s+/, "").split(":")[0].trim()))];
    if (name === "S0_actual" || name === "S1_pelicula") {
      const { registryAvailability, resolveSequences } = await import("../src/lib/video/long-form/sequence-intent");
      const { planSequenceShots } = await import("../src/lib/video/long-form/sequence-direction");
      const { contractForVisual, contractKey } = await import("../src/lib/video/long-form/verified-assets");
      const shots = planSequenceShots(script.beats as never, resolveSequences(plan.sequences!, registryAvailability(registry))).shots;
      log("SIM_SHOTS", { scenario: name, shots: shots.map((sh) => { const v = (sh as { anchoredVisual?: { beatClass?: string } }).anchoredVisual; const c = contractForVisual(v as never);
        return [Math.round(sh.startSec), Math.round(sh.endSec), sh.type, v?.beatClass ?? null, c ? (LABEL[contractKey(c)] ?? "?") : null]; }) });
    }
    log("SIM", { scenario: name, approved: labels, verifiedInRegistry: registry.size, pass: pre.blockers.length === 0, codes, heroMissingIdentities: pre.coverage?.heroMissingRequiredIdentities.length,
      heroMissingEvidence: pre.coverage?.heroMissingRequiredEvidence.length, textCardRatio: pre.coverage?.estimatedTextCardRatio, plannedShots: pre.plannedShotCount });
  }
}

/**
 * Alternative B, simulated in memory only (the approved script is NOT modified): the scenes that ask
 * for the film / the 1967 identities are reclassified as PLACE (Bluff Creek setting), dropping their
 * identity/evidence contract, and the EXISTING gate is evaluated on that variant with no approvals.
 */
async function altBScenarios() {
  const { db, job } = await loadJob();
  const { productPlan } = await import("../src/lib/video/long-form/product-plan");
  const { getRealLongFormProviderNames } = await import("../src/lib/video/long-form/production-plan");
  const { contractForVisual, contractKey } = await import("../src/lib/video/long-form/verified-assets");
  const { visualReleasePreflight } = await import("../src/lib/video/long-form/visual-release-preflight");
  const { VerifiedAssetRegistry } = await import("../src/lib/video/long-form/verified-assets");
  const { data: req } = await db.from("video_requests").select("id,topic,duration_seconds,script_json").eq("id", job.request_id).single();
  const script = req!.script_json as { topic?: string; beats: { visuals?: Record<string, unknown>[] }[] };
  const topic = script.topic || req!.topic;
  const LABEL: Record<string, string> = { "IDENTITY:roger patterson and bob gimlin": "I1", "IDENTITY:roger patterson": "I2", "IDENTITY:bob heironimus": "I3",
    "EVIDENCE:web-2+web-5": "E1", "EVIDENCE:web-2": "E2", "EVIDENCE:web-2+web-4": "E3", "EVIDENCE:web-1": "E4", "EVIDENCE:web-5": "E5" };
  const variants: Record<string, string[]> = { B1_sin_pelicula_ni_identidades: ["I1", "I2", "E1", "E2", "E3"], B2_B1_mas_periodico: ["I1", "I2", "E1", "E2", "E3", "E4"] };
  for (const [name, labels] of Object.entries(variants)) {
    let changed = 0;
    const beats = script.beats.map((b) => ({ ...b, visuals: (b.visuals ?? []).map((v) => {
      const c = contractForVisual(v as never);
      if (!c || !labels.includes(LABEL[contractKey(c)] ?? "")) return v;
      changed++;
      const { identity: _i, evidence: _e, ...rest } = v as Record<string, unknown>; void _i; void _e;
      return { ...rest, beatClass: "PLACE" };
    }) }));
    const res = productPlan({ beats: beats as never, topic, strategy: "balanced", providers: getRealLongFormProviderNames(), requestedDurationSeconds: req!.duration_seconds ?? undefined, cinematicV6: true });
    const pre = await visualReleasePreflight({ supabase: db, requestId: req!.id, plan: res.plan, beats: beats as never, topic, verifiedAssets: VerifiedAssetRegistry.empty() });
    const codes = [...new Set(pre.blockers.map((b) => b.replace(/^HERO_COVERAGE\s+/, "").split(":")[0].trim()))];
    log("ALT_B", { variant: name, reclassifiedScenes: changed, engine: res.engine, planVersion: res.plan.version, pass: pre.blockers.length === 0, codes,
      heroMissingIdentities: pre.coverage?.heroMissingRequiredIdentities.length, heroMissingEvidence: pre.coverage?.heroMissingRequiredEvidence.length,
      textCardRatio: pre.coverage?.estimatedTextCardRatio, plannedShots: pre.plannedShotCount, estimatedUsd: res.plan.estimatedProviderCostUsd });
  }
}

/** Read-only DB side of HeyGen admission: policy validity, latest snapshots, supply state, and the
 * existing avatar request's readiness (no refresh, no reservation). Ids hashed; amounts sealed. */
async function heygenDbState() {
  const db = service();
  const { data: p } = await db.from("pi_supply_policies").select("*").eq("provider", "heygen").maybeSingle();
  const pol = p as Record<string, unknown> | null;
  log("HEYGEN_POLICY", pol ? { enabled: pol.enabled, unit: pol.unit, baselinePositive: Number(pol.baseline) > 0, unitCostPositive: Number(pol.unit_cost_usd) > 0,
    maxConcurrentPositive: Number(pol.max_concurrent) > 0, maxDailyCallsPositive: Number(pol.max_daily_calls) > 0, dailyCapUsd: pol.daily_cap_usd, monthlyCapUsd: pol.monthly_cap_usd,
    evidencePresent: String(pol.evidence ?? "").trim().length > 0 } : null);
  const { data: snaps } = await db.from("pi_capacity_snapshots").select("unit,reliability,health,available,checked_at").eq("provider", "heygen").order("checked_at", { ascending: false }).limit(5);
  log("HEYGEN_SNAPSHOTS", (snaps ?? []).map((x) => ({ unit: x.unit, reliability: x.reliability, health: x.health, availablePresent: x.available !== null, checkedAt: x.checked_at })));
  const { data: state } = await db.rpc("pi_supply_state", { p_provider: "heygen" });
  const st = state as Record<string, unknown> | null;
  log("HEYGEN_STATE", st ? { level: st.level, reason: st.reason } : null);
  const { data: reqs } = await db.from("video_requests").select("*").eq("mode", "avatar").order("created_at", { ascending: false }).limit(3);
  const { jobSupplyDemands } = await import("../src/lib/supply/job");
  const { ensureJobSupplyReady } = await import("../src/lib/supply/readiness");
  for (const r of (reqs ?? []) as Record<string, any>[]) {
    let demands: { provider: string; unit: string }[] = [], readiness: unknown = null;
    try {
      const d = jobSupplyDemands(r as never, "elevenlabs");
      demands = d.map((x) => ({ provider: x.provider, unit: x.unit }));
      const rd = await ensureJobSupplyReady(db, d, { refresh: false });
      readiness = { ready: rd.ready, failure: rd.failure, providers: rd.providers.map((x) => ({ provider: x.provider, level: x.level, ok: x.ok, failure: x.failure ?? null })) };
    } catch (e) { readiness = { error: e instanceof Error ? e.message.slice(0, 120) : "error" }; }
    log("AVATAR_REQUEST", { request: h10(String(r.id)), createdAt: r.created_at, status: r.status, renderAttempts: r.render_attempts, recordedAudio: !!r.recorded_audio_path,
      narrationSource: r.narration_source ?? null, supplyWait: !!r.supply_wait_started_at, demands, readiness });
  }
}

/** Signed probe of the RUNNING production deployment (presence/counts only; never a value). Waits for the route to go live. */
async function providerConfig() {
  const { randomUUID } = await import("node:crypto");
  const { PROVIDER_CONFIG_PATH, providerConfigSignature } = await import("../src/lib/ops/provider-config");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
  for (let attempt = 1; attempt <= 30; attempt++) {
    const nonce = randomUUID(), timestamp = String(Date.now());
    const res = await fetch(`https://atomivid.vercel.app${PROVIDER_CONFIG_PATH}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { "x-probe-nonce": nonce, "x-probe-time": timestamp, "x-probe-signature": providerConfigSignature(key, nonce, timestamp) } }).catch(() => null);
    if (res?.ok) {
      const report = await res.json() as { heygen?: { sealed?: unknown } };
      if (!report.heygen) { log("PROVIDER_CONFIG_WAIT", { attempt, status: "previous deployment" }); await new Promise((r) => setTimeout(r, 20_000)); continue; }
      const sealedPart = report.heygen?.sealed ?? null;
      if (report.heygen) delete report.heygen.sealed;
      log("PROVIDER_CONFIG", report);
      if (sealedPart) sealed("HEYGEN_ACCOUNT", sealedPart);
      await heygenDbState();
      return;
    }
    log("PROVIDER_CONFIG_WAIT", { attempt, status: res?.status ?? "network" });
    await new Promise((r) => setTimeout(r, 20_000));
  }
  throw Error("probe route not live");
}

const modes: Record<string, () => Promise<unknown>> = { "provider-config": providerConfig, "alt-b-scenarios": altBScenarios, "coverage-scenarios": coverageScenarios, "podcast-real-voice": podcastRealVoice, "contracts-sealed": contractsSealed, "preflight-preview": preflightPreview, "supply-check": supplyCheck, readiness, "verify-backed": verifyBackedScenes, "visual-repair": visualRepairDiagnostic, "recover-anchors": recoverVisualAnchors, "visual-anchors": visualAnchorDiagnostic, "recover-format": recoverAfterFormatFix, "review-format": reviewFormatDiagnostic, "apply-reviewed-resume-migration": applyReviewedResumeMigration, "resume-budget": resumeBudget, "v6-check": v6Check,  "verify-rpc": verifyRpc, inspect, "open-budget": openBudget, recover, status, "close-budget": closeBudget };
const mode = (process.env.BIGFOOT_OPS_MODE ?? "").trim();
if (process.env.ANTHROPIC_API_KEY) throw Error("provider key must not be present in the operator job");
(modes[mode] ?? (async () => { throw Error(`unknown mode ${mode}`); }))().catch((e) => { console.error("OPS_FAILED", e instanceof Error ? e.message.slice(0, 200) : "error"); process.exitCode = 1; });
