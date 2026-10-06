import {createHash,randomBytes,createCipheriv,publicEncrypt,constants} from 'node:crypto';
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
 let script:any,review:any; const documents:any[]=[];
 for(const row of rows.data??[]){
  const f=await db.storage.from('videos').download(row.result_ref);if(f.error||!f.data)throw Error('read');
  const r=JSON.parse(await f.data.text());if(r.stop_reason!=='end_turn')continue;
  const t=r.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('').trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i,'$1');
  let v:any;try{v=JSON.parse(t);}catch{continue;}
  documents.push(v);
  const s=DocumentaryNarrativeSchema.safeParse(v),e=EditorialReviewSchema.safeParse(v);
  if(s.success)script=s.data;if(e.success)review=e.data;
 }
 if(!script||!review)throw Error('matching documents unavailable');
 // Encrypt the private diagnostic before it leaves this runner. The ephemeral
 // private key exists only in the operator workspace; no plaintext artifact.
 const publicKey="-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuFjtnbxQjXXt37z+4wtC\nM3zy99qZmrUorCohGURywkyXVdzfLbb1+hy7vltG/bzucfBznJitBuv3GtNoDvSu\nQwtNGAWtvmr6GqVVA7Z/lb41IxgTM/3TH+AbfZlt4g+s4zpcS0siQFdtittpt5b1\nztanfQoSlC3O5jJRfidZWicIGcMIfgmRe1JsWmYQ+O+L3qwQ7cwrWQYBMzToypTj\nr07k2WDlqZW5IX+4HlRO/oOxenykfIGT4ERfmUM914o0IXHteZMrGYuihclsvrHc\nklkKAqOL//fjdsUzSA00Ulhz+KiauPVuW2G2BhaxJIV/Lirl1m7rCGVZ8FWhUprX\n7wIDAQAB\n-----END PUBLIC KEY-----\n";
 const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
 const encrypted=Buffer.concat([cipher.update(JSON.stringify({script,review,repair:documents.find(x=>Array.isArray(x?.replacements))}),'utf8'),cipher.final()]);
 console.log('PRIVATE_DIAGNOSTIC_CIPHER='+JSON.stringify({key:publicEncrypt({key:publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key).toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')}));

 console.log(JSON.stringify({beats:script.beats.length,sections:review.sections.length,findings:review.findings.map((f:any)=>({kind:f.kind,severity:f.severity,evidence:f.evidence.length})),firstDelivered:review.firstAnswer.delivered,endingResolved:review.ending.resolvesPromise}));
 const citations=[...review.sections.map((e:any,i:number)=>({path:`sections.${i}`,e})),{path:'firstAnswer',e:review.firstAnswer.evidence},{path:'ending',e:review.ending.evidence},...review.findings.flatMap((f:any,i:number)=>f.evidence.map((e:any,j:number)=>({path:`findings.${i}.${j}`,e})))];
 for(const {path,e} of citations){
  const n=script.beats[e.beatIndex]?.narration??'';
  const exact=n.includes(e.quote),norm=normalized(n).includes(normalized(e.quote));
  if(!exact||e.quote.trim().split(/\s+/).length<3)console.log(JSON.stringify({path,beatIndex:e.beatIndex,words:e.quote.trim().split(/\s+/).length,exact,typographyMatch:norm,exactOtherBeats:script.beats.flatMap((b:any,i:number)=>b.narration.includes(e.quote)?[i]:[]),typographyOtherBeats:script.beats.flatMap((b:any,i:number)=>normalized(b.narration).includes(normalized(e.quote))?[i]:[]),hasEllipsis:/\.\.\.|…/.test(e.quote),quoteLength:e.quote.length,onlyPunctuation:!/[a-zA-Z]/.test(e.quote),placeholder:/^(?:n\/?a|none|absent|ausente|ninguna|no\s+cta|\[.*?\]|\(.*?\))$/i.test(e.quote.trim()),ellipsisParts:e.quote.split(/\.{3}|…/).map((p:string)=>({words:p.trim().split(/\s+/).length,found:normalized(n).includes(normalized(p))}))}));
 }
 const canonical=canonicalizeEditorialCitations(review,script.beats);console.log(JSON.stringify({invalidBefore:invalidEditorialCitations(review,script.beats).length,invalidAfterLiteralExpansion:invalidEditorialCitations(canonical,script.beats).length}));
 try{validateEditorialReview(canonical,script);console.log('review_validation=pass');}catch{console.log('review_validation=fail');}
}
main().catch(()=>{console.error('Read-only editorial diagnostic failed');process.exitCode=1;});
