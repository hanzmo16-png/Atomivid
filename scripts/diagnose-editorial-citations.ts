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
 const db=createClient(process.env.SUPABASE_URL!.trim(),process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),{auth:{persistSession:false,autoRefreshToken:false}});
 const latest=await db.from('pi_paid_operations').select('project_id').eq('provider','anthropic').eq('status','COMMITTED').like('project_id','documentary:%').order('created_at',{ascending:false}).limit(1);
 if(latest.error||!latest.data?.[0])throw Error('read');
 if(createHash('sha256').update(latest.data[0].project_id).digest('hex')!=='4ab5689838b0540d705e68ba18772583c8c740bf91b319ea76a8306e3057d884')throw Error('Diagnostic scope changed');
 const rows=await db.from('pi_paid_operations').select('result_ref').eq('project_id',latest.data[0].project_id).eq('provider','anthropic').eq('status','COMMITTED').order('created_at',{ascending:true});
 if(rows.error)throw Error('read');
 let script:any,review:any;const docs:any[]=[];
 for(const row of rows.data??[]){
  const f=await db.storage.from('videos').download(row.result_ref);if(f.error||!f.data)throw Error('read');
  const r=JSON.parse(await f.data.text());if(r.stop_reason!=='end_turn')continue;
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
 try{const validated=validateEditorialReview(canonical,script);console.log(JSON.stringify({reviewValidation:true,blockers:editorialBlockers(validated).length}));}catch{console.log('review_validation=fail');}
}
main().catch(()=>{console.error('Read-only editorial diagnostic failed');process.exitCode=1;});
