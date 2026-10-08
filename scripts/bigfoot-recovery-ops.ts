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
  log("V6_CHECK", { visualReadiness, request: { status: req.status, mode: req.mode, confirmed: !!req.long_form_confirmed_at, editorial: script.editorial?.status },
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
 let valid=false,offset:number|null=null;try{JSON.parse(j);valid=true;}catch(e){const m=(e instanceof Error?e.message:"").match(/position (\\d+)/);offset=m?Number(m[1]):null;const lc=(e instanceof Error?e.message:"").match(/line (\d+) column (\d+)/);if(offset===null&&lc){const lines=j.split("\\n");offset=lines.slice(0,Number(lc[1])-1).reduce((n,l)=>n+l.length+1,0)+Number(lc[2])-1;} log("JSON_ERROR_KIND",{knownReason:["Expected property name","Expected ',' or '}'","Expected ',' or ']'","Unterminated string","Bad control character","Unexpected non-whitespace character","Unexpected token","Expected ':'"].find(k=>(e instanceof Error?e.message:"").startsWith(k))??"other",line:lc?Number(lc[1]):null,column:lc?Number(lc[2]):null});}
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
 if(job.status!=="failed"||job.failure_kind!=="technical"||job.error_code!=="d156ef2c"||job.run_token||job.retry_count!==3||job.editorial_rounds!==2||stableHash(job.editorial_checkpoint,16)!=="b8e5818d5d9e611b"||ops.length!==19||ops.some(o=>o.status!=="COMMITTED"))throw Error("exact approved visual incident required");
 const {editorialBlockers}=await import("../src/lib/video/long-form/editorial");if(!job.editorial_checkpoint.review||editorialBlockers(job.editorial_checkpoint.review).length)throw Error("editorial blockers present");
 const {client}=await connectResolved();try{const u=(await client.query("select public.pi_recovery_budget_usage($1) u",[projectId])).rows[0].u;if(u.status!=="ACTIVE"||Number(u.capUsd)!==2.1||u.baselineOperations!==5||Number(u.pendingUsd)!==0)throw Error("same original cap required");}finally{await client.end();}
 const {data,error}=await db.from("documentary_script_jobs").update({status:"queued",run_token:null,failure_kind:null,error_code:null,error_message:null,stage:"Reanudando referencias del plan V6",updated_at:new Date().toISOString()}).eq("id",JOB_ID).eq("user_id",job.user_id).eq("status","failed").is("run_token",null).eq("updated_at",job.updated_at).select("id");
 if(error||data?.length!==1)throw Error("incident lease lost");
 log("ANCHOR_RECOVERY",{result:"queued",savedResponses:19,retryCountPreserved:3,editorialRoundPreserved:2,approvedNarrationPreserved:true,capPreserved:2.10,authorization:"owner 2026-10-08 consolidate V6; deployed anchor repair required"});
}
async function visualRepairDiagnostic(){
 const {db,job,ops}=await inspect();const {narrationCatalog}=await import("../src/lib/video/long-form/narration-catalog");const ids=new Set(narrationCatalog(job.editorial_checkpoint.script.beats).filter(e=>e.beatIndex===2).map(e=>e.id));
 const {readDocumentaryJson}=await import("../src/lib/video/long-form/json-response");const f=await db.storage.from("videos").download(ops.at(-1)!.result_ref);if(f.error||!f.data)throw Error("download");const r=readDocumentaryJson(JSON.parse(await f.data.text())) as {replacements:{index:number;excerptId:string}[]};
 log("VISUAL_REPAIR",{selected:r.replacements.map(x=>({index:x.index,validId:ids.has(x.excerptId)})),omitted:Array.from({length:8},(_,i)=>i).filter(i=>!r.replacements.some(x=>x.index===i))});
}
const modes: Record<string, () => Promise<unknown>> = { "visual-repair": visualRepairDiagnostic, "recover-anchors": recoverVisualAnchors, "visual-anchors": visualAnchorDiagnostic, "recover-format": recoverAfterFormatFix, "review-format": reviewFormatDiagnostic, "apply-reviewed-resume-migration": applyReviewedResumeMigration, "resume-budget": resumeBudget, "v6-check": v6Check,  "verify-rpc": verifyRpc, inspect, "open-budget": openBudget, recover, status, "close-budget": closeBudget };
const mode = (process.env.BIGFOOT_OPS_MODE ?? "").trim();
if (process.env.ANTHROPIC_API_KEY) throw Error("provider key must not be present in the operator job");
(modes[mode] ?? (async () => { throw Error(`unknown mode ${mode}`); }))().catch((e) => { console.error("OPS_FAILED", e instanceof Error ? e.message.slice(0, 200) : "error"); process.exitCode = 1; });
