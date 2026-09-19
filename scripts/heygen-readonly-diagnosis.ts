import {createClient} from "@supabase/supabase-js";
import {createHash} from "node:crypto";
const hash=(v:string)=>createHash("sha256").update(v).digest("hex");
async function main(){
const s=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}});
const r=await s.from("video_requests").select("id,user_id,status").eq("mode","avatar");
if(r.error)throw Error("source_read_failed");
const source=r.data.find(x=>hash(x.id)==="24ad45b839f41c3c20e23d3a1b85e5d4e946fd66d1bead27865e4dbd506239b5");
if(!source)throw Error("source_missing");
const h=hash("heygen-owner-trial-v1:"+source.id);
const id=h.slice(0,8)+"-"+h.slice(8,12)+"-4"+h.slice(13,16)+"-a"+h.slice(17,20)+"-"+h.slice(20,32);
const row=await s.from("video_requests").select("status,render_attempts,avatar_generation_started_at,avatar_provider_video_job_id").eq("id",id).single();
console.log("REQUEST_CHECK",JSON.stringify({db_code:row.error?.code??null,status:row.data?.status,attempts:row.data?.render_attempts,claimed:!!row.data?.avatar_generation_started_at,provider_job_present:!!row.data?.avatar_provider_video_job_id}));
const key=process.env.HEYGEN_API_KEY??"";
console.log("KEY_STRUCTURE",JSON.stringify({present:!!key,masked_characters:/[•●*]/.test(key),outer_whitespace:key!==key.trim()}));
if(!key)return;
const res=await fetch("https://api.heygen.com/v3/users/me",{headers:{"X-Api-Key":key},redirect:"error",signal:AbortSignal.timeout(20000)});
const data=await res.json();
console.log("WALLET_READ",JSON.stringify({http:res.status,error_code:typeof data.error?.code==="string"&&/^[a-zA-Z0-9_-]+$/.test(data.error.code)?data.error.code:null,data_present:!!data.data,wallet_present:!!data.data?.wallet,amount_type:typeof data.data?.wallet?.remaining_balance,currency_usd:data.data?.wallet?.currency==="usd"}));
}
main().catch(()=>{console.error("READ_ONLY_DIAGNOSTIC_FAILED");process.exitCode=1});