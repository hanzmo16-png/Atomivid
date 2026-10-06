import {isProductionRuntime} from '../src/lib/providers/production';
import {stableHash} from '../src/lib/production-intelligence/canonical';
import {documentarySupplyScope} from '../src/lib/supply/anthropic';
import {researchDocumentary,RESEARCH_VERSION} from '../src/lib/video/long-form/research';
import {generateDocumentaryScript} from '../src/lib/video/long-form/documentary-script';
import {parseSources,parseOpenQuestions} from '../src/app/dashboard/long-form/new/parse';
import {EDITORIAL_VERSION} from '../src/lib/video/long-form/editorial';
import {applyEditorialCitationRepairs} from '../src/lib/video/long-form/editorial-evidence';
import {createHash} from 'node:crypto';
import {creativeDirectionIssues} from '../src/lib/video/long-form/creative-direction';
import {editorialBlockers} from '../src/lib/video/long-form/editorial';
import {evaluateNarrationDuration,countWords} from '../src/lib/video/long-form/duration-budget';
import {canonicalizeEditorialCitations,invalidEditorialCitations} from '../src/lib/video/long-form/editorial-evidence';
/** Read-only. Only structural statistics leave the runner, never private text. */
import {createClient} from '@supabase/supabase-js';
import {DocumentaryNarrativeSchema} from '../src/lib/video/long-form/documentary-script';
import {EditorialReviewSchema,validateEditorialReview} from '../src/lib/video/long-form/editorial';
const normalized=(s:string)=>s.normalize('NFKC').replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/[–—]/g,'-').replace(/\s+/g,' ').trim();
async function main(){
 if(isProductionRuntime()||process.env.SUPPLY_GUARD_ENFORCED==='true'||process.env.ANTHROPIC_API_KEY)throw Error('Read-only offline diagnostic environment required');
 const db=createClient(process.env.SUPABASE_URL!.trim(),process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),{auth:{persistSession:false,autoRefreshToken:false}});
 const latest=await db.from('pi_paid_operations').select('project_id').eq('provider','anthropic').eq('status','COMMITTED').like('project_id','documentary:%').order('created_at',{ascending:false}).limit(1);
 if(latest.error||!latest.data?.[0])throw Error('read');
 if(createHash('sha256').update(latest.data[0].project_id).digest('hex')!=='4ab5689838b0540d705e68ba18772583c8c740bf91b319ea76a8306e3057d884')throw Error('Diagnostic scope changed');
 const rows=await db.from('pi_paid_operations').select('result_ref,shot_id').eq('project_id',latest.data[0].project_id).eq('provider','anthropic').eq('status','COMMITTED').order('created_at',{ascending:true});
 if(rows.error)throw Error('read');
 let script:any,review:any;const docs:any[]=[],responses=new Map<string,any>();
 for(const row of rows.data??[]){
  const f=await db.storage.from('videos').download(row.result_ref);if(f.error||!f.data)throw Error('read');
  const r=JSON.parse(await f.data.text());responses.set(row.shot_id.split(':').at(-1),r);if(r.stop_reason!=='end_turn')continue;
  const t=r.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('').trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i,'$1');
  let v:any;try{v=JSON.parse(t);}catch{continue;}
  docs.push(v);const s=DocumentaryNarrativeSchema.safeParse(v),e=EditorialReviewSchema.safeParse(v);
  if(s.success)script=s.data;if(e.success)review=e.data;
 }
 if(!script||!review)throw Error('matching documents unavailable');
 console.log(JSON.stringify({beats:script.beats.length,sections:review.sections.length,findings:review.findings.map((f:any)=>({kind:f.kind,severity:f.severity,evidence:f.evidence.length})),firstDelivered:review.firstAnswer.delivered,endingResolved:review.ending.resolvesPromise}));
 const citations=[...review.sections.map((e:any,i:number)=>({path:`sections.${i}`,e})),{path:'firstAnswer',e:review.firstAnswer.evidence},{path:'ending',e:review.ending.evidence},...review.findings.flatMap((f:any,i:number)=>f.evidence.map((e:any,j:number)=>({path:`findings.${i}.${j}`,e})))];
 for(const {path,e} of citations){
  const n=script.beats[e.beatIndex]?.narration??'';
  const exact=n.includes(e.quote),norm=normalized(n).includes(normalized(e.quote));
  if(!exact||e.quote.trim().split(/\s+/).length<3)console.log(JSON.stringify({path,beatIndex:e.beatIndex,words:e.quote.trim().split(/\s+/).length,exact,typographyMatch:norm,exactOtherBeats:script.beats.flatMap((b:any,i:number)=>b.narration.includes(e.quote)?[i]:[]),typographyOtherBeats:script.beats.flatMap((b:any,i:number)=>normalized(b.narration).includes(normalized(e.quote))?[i]:[]),hasEllipsis:/\.\.\.|…/.test(e.quote),quoteLength:e.quote.length,onlyPunctuation:!/[a-zA-Z]/.test(e.quote),placeholder:/^(?:n\/?a|none|absent|ausente|ninguna|no\s+cta|\[.*?\]|\(.*?\))$/i.test(e.quote.trim()),ellipsisParts:e.quote.split(/\.{3}|…/).map((p:string)=>({words:p.trim().split(/\s+/).length,found:normalized(n).includes(normalized(p))}))}));
 }
 const repairs=docs.filter(d=>Array.isArray(d.replacements));
 console.log(JSON.stringify({documents:docs.map(d=>DocumentaryNarrativeSchema.safeParse(d).success?'narrative':EditorialReviewSchema.safeParse(d).success?'review':Array.isArray(d.replacements)?'citation_repair':'other'),creativeIssueCount:creativeDirectionIssues(script.creativeDirection,script.beats,[],1).length,words:countWords(script.beats.map((b:any)=>b.narration).join(' ')),duration:evaluateNarrationDuration(countWords(script.beats.map((b:any)=>b.narration).join(' ')),420)}));
 const canonical=canonicalizeEditorialCitations(review,script.beats);
 const invalid=invalidEditorialCitations(canonical,script.beats);
 const latestRepair=repairs.at(-1);const patches=latestRepair?.replacements??[];
 console.log(JSON.stringify({repairCounts:repairs.map(r=>r.replacements.length),invalid:invalid.map(x=>({path:x.path,beatIndex:x.citation.beatIndex,words:x.citation.quote.split(/\s+/).length})),patches:patches.map((p:any)=>{const target=invalid.find(x=>x.path===p.path);const n=target?script.beats[target.citation.beatIndex]?.narration??'':'';return {knownPath:!!target,words:p.quote?.split(/\s+/).length,exact:!!target&&n.includes(p.quote),typographyMatch:!!target&&normalized(n).includes(normalized(p.quote)),exactOtherBeats:script.beats.flatMap((b:any,i:number)=>b.narration.includes(p.quote)?[i]:[])};})}));console.log(JSON.stringify({invalidBefore:invalidEditorialCitations(review,script.beats).length,invalidAfterLiteralExpansion:invalidEditorialCitations(canonical,script.beats).length}));
 let finalReview=canonical;
 try{if(invalid.length)finalReview=applyEditorialCitationRepairs(canonical,script.beats,latestRepair);const validated=validateEditorialReview(finalReview,script);console.log(JSON.stringify({savedRepairValid:true,retainedFindings:validated.findings.length,blockers:editorialBlockers(validated).length,relocatedReferences:validated.citationLocations?.length??0,repeatedBlocks:validated.sections.filter(s=>s.function==='restatement').map(s=>s.beatIndex),blockingFindings:validated.findings.filter(f=>f.severity==='blocking').length}));}catch{console.log('saved_repair_valid=false');}
 // Replay ALL SDK requests against the exact recorded parameter fingerprints.
 // Networking is replaced only after read-only downloads; no provider credential,
 // writes or paid call can occur. A cache miss is a boundary, never a fallback.
 const jobs=await db.from('documentary_script_jobs').select('user_id,input').eq('user_id',latest.data[0].project_id.split(':')[1]).eq('status','failed').order('created_at',{ascending:false});
 if(jobs.error)throw Error('read');
 const job=jobs.data?.find(j=>documentarySupplyScope(j.user_id,{...j.input.fields,editorialVersion:EDITORIAL_VERSION,researchVersion:RESEARCH_VERSION,creativeHistory:j.input.creativeHistory},false).projectId===latest.data[0].project_id);
 if(!job)throw Error('Replay input unavailable');
 const fields=job.input.fields,originalFetch=globalThis.fetch;
 let stage='research',hits=0,miss=false,approved=false;
 const stages:string[]=[];
 process.env.ANTHROPIC_API_KEY='offline-replay-no-provider-key';
 globalThis.fetch=async(_url,init)=>{
  const params=JSON.parse(String(init?.body));const response=responses.get(stableHash(params,16));
  if(!response){miss=true;throw Error('OFFLINE_CACHE_BOUNDARY');}
  hits++;return new Response(JSON.stringify(response),{status:200,headers:{'content-type':'application/json'}});
 };
 try{
  const researchPack=await researchDocumentary({topic:fields.topic,references:parseSources(fields.sources),openQuestions:parseOpenQuestions(fields.openQuestions)});
  await generateDocumentaryScript({researchPack,creativeHistory:job.input.creativeHistory,mode:'curiosity_documentary',language:fields.language,targetDurationSeconds:Number(fields.durationMinutes)*60,onStage:async label=>{stage=label;stages.push(label);},onEditorialApproved:()=>{approved=true;}});
  console.log(JSON.stringify({offlineReplay:'completed',hits,approved,stages}));
 }catch(error){console.log(JSON.stringify({offlineReplay:miss?'cache_boundary':'validation_failure',errorType:error instanceof Error?error.name:'unknown',hits,approved,stage,stages}));}
 finally{globalThis.fetch=originalFetch;delete process.env.ANTHROPIC_API_KEY;}
 try{const validated=validateEditorialReview(canonical,script);console.log(JSON.stringify({reviewValidation:true,blockers:editorialBlockers(validated).length}));}catch{console.log('review_validation=fail');}
}
main().catch(()=>{console.error('Read-only editorial diagnostic failed');process.exitCode=1;});
