/** Read-only diagnosis. Never log a response, user/account IDs, prompts, or object URLs. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { DocumentaryNarrativeSchema, DocumentaryNarrativePromptSchema } from '../src/lib/video/long-form/documentary-script';
async function main() {
 const db=createClient(process.env.SUPABASE_URL!.trim(),process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),{auth:{persistSession:false,autoRefreshToken:false}});
 const {data, error}=await db.from('pi_paid_operations').select('result_ref').eq('provider','anthropic').eq('status','COMMITTED').like('project_id','documentary:%').order('created_at',{ascending:false}).limit(1);
 if(error || !data?.[0]?.result_ref) throw Error('Diagnostic read unavailable');
 const {data:blob,error:storageError}=await db.storage.from('videos').download(data[0].result_ref);
 if(storageError || !blob) throw Error('Stored result unavailable');
 const response=JSON.parse(await blob.text());
 const text=response.content.filter((x:any)=>x.type==='text').map((x:any)=>x.text).join('').trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i,'$1');
 const value=JSON.parse(text);
 const result=DocumentaryNarrativeSchema.safeParse(value);
 console.log(JSON.stringify({complete:response.stop_reason==='end_turn',valid:result.success,promptContractUnchanged:createHash('sha256').update(JSON.stringify(z.toJSONSchema(DocumentaryNarrativePromptSchema,{reused:'ref'}))).digest('hex')==='173ea300e6beb8700700c2d062ec33af69193aefd292d24aeec5fdd3be8e97c9'}));
 if(!result.success) for(const issue of result.error.issues) {
   // Zod paths here come only from the fixed object schema and array indices.
   const actual=issue.path.reduce((o:any,k)=>o?.[k],value);
   console.log(JSON.stringify({path:issue.path,code:issue.code,actualType:typeof actual,length:typeof actual==='string'||Array.isArray(actual)?actual.length:undefined,...('minimum'in issue?{minimum:issue.minimum}:{}),...('maximum'in issue?{maximum:issue.maximum}:{})}));
 }
}
main().catch(()=>{console.error('Read-only format diagnostic failed');process.exitCode=1;});
