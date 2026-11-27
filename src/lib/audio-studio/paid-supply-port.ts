/** Audio's synchronous TTS journal uses the existing PI ledger and whole-job envelopes.
 * Tariff costs are estimates; no provider job IDs or billing evidence are invented. */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LedgerStore, PaidOperation } from "../production-intelligence/ledger";
import { supabaseLedgerStore } from "../paid-calls/supabase-ledger-store";
import { submitWithSupply } from "../supply/server";
import { isUuid, type AudioProject } from "./model";
import { assertBlobPath, type BlobStore } from "./store";
export const AUDIO_TARIFF_METHOD = "audio_studio_tts_tariff_estimate";
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
export interface AudioSegmentDemand { segment: string; characters: number; usd: number; provider: "elevenlabs"; model: string; key: string }
export interface AudioUsage { spentUsd: number; calls: number; characters: number }
export function audioContract(p: AudioProject) {
 const a=p.generation.authorization;
 if(!isUuid(p.ownerId)||!isUuid(p.id)||!a||a.revision!==p.revision||a.model!==p.ttsModel||!Number.isFinite(a.usd)||a.usd<=0||a.usd>p.budgetUsd||a.usd>20||!Number.isFinite(Date.parse(a.at))||!Number.isFinite(a.spentBefore)||a.spentBefore<0)throw Error("AUDIO_AUTHORIZATION_INVALID");
 const root=`audio:${p.ownerId}:${p.id}`;
 const facts={ownerId:p.ownerId,projectId:p.id,usd:a.usd,revision:a.revision,model:a.model,at:a.at,
  fingerprint:hash(JSON.stringify({script:p.script,voices:p.voices,voiceCount:p.voiceCount,language:p.language,model:p.ttsModel,spentBefore:a.spentBefore}))};
 const ref=hash(JSON.stringify(facts));return {root,facts,ref};
}
export function audioDemand(p: AudioProject, segment: string, characters: number, usd: number): AudioSegmentDemand {
 const c=audioContract(p);
 if(!/^[a-f0-9]{64}$/.test(segment)||!Number.isSafeInteger(characters)||characters<=0||!Number.isFinite(usd)||usd<=0||usd>c.facts.usd||Math.abs(usd*10000-Math.round(usd*10000))>1e-7)throw Error("AUDIO_DEMAND_INVALID");
 return {segment,characters,usd,provider:"elevenlabs",model:p.ttsModel,key:`audio_${hash(`${c.root}:${c.ref}:${segment}`)}`};
}
export interface AudioPaidSupply {
 reserve(p: AudioProject, demands: AudioSegmentDemand[]): Promise<void>;
 recover(p: AudioProject, d: AudioSegmentDemand, bytes: Buffer): Promise<boolean>;
 synth(p: AudioProject, d: AudioSegmentDemand, blob: string, store: BlobStore, produce: () => Promise<Buffer>): Promise<Buffer>;
 usage(p: AudioProject): Promise<AudioUsage | null>;
}
type Rpc = (name: string,args: Record<string,unknown>) => Promise<{data: unknown;error: unknown}>;
export function audioPaidSupply(deps: { ledger: LedgerStore; rpc: Rpc; now?: () => string }): AudioPaidSupply {
 const {ledger,rpc}=deps, now=deps.now??(()=>new Date().toISOString());
 async function settle(p: AudioProject,d: AudioSegmentDemand,bytes: Buffer) {
  const row=await ledger.get(d.key);if(!row)return false;
  if(row.projectId!==audioContract(p).root||row.shotId!==d.segment||row.reservedUsd!==d.usd||row.method!==AUDIO_TARIFF_METHOD)throw Error("AUDIO_JOURNAL_MISMATCH");
  let receipt: {sha256?:string;costBasis?:string};try{receipt=JSON.parse(row.resultRef??"");}catch{throw Error("AUDIO_RECONCILIATION_REQUIRED");}
  if(receipt.sha256!==hash(bytes)||receipt.costBasis!=="ESTIMATED_TARIFF")throw Error("AUDIO_CACHE_RESTORATION_REQUIRED");
  if(row.status==="COMMITTED")return true;
  if(row.status!=="PROVIDER_JOB_RECORDED"||!await ledger.update(d.key,"PROVIDER_JOB_RECORDED",{status:"COMMITTED",updatedAt:now()}))throw Error("AUDIO_RECONCILIATION_REQUIRED");
  return true;
 }
 return {
  async reserve(p,demands) {
   const c=audioContract(p), unique=new Map(demands.map(d=>[d.segment,d]));
   if(unique.size!==demands.length||demands.some(d=>JSON.stringify(d)!==JSON.stringify(audioDemand(p,d.segment,d.characters,d.usd)))||demands.reduce((n,d)=>n+Math.round(d.usd*10000),0)>Math.round(c.facts.usd*10000))throw Error("AUDIO_MANIFEST_INVALID");
   const result=await rpc("pi_reserve_audio_supply",{p_ref:c.ref,p_facts:c.facts,p_manifest:demands,p_legacy:{spentUsd:p.spentUsd,calls:p.generation.providerCalls,characters:p.generation.charsSynthesized}});
   if(result.error||(result.data as {reserved?:unknown})?.reserved!==true)throw Error("AUDIO_WHOLE_JOB_SUPPLY_UNAVAILABLE");
  },
  recover: settle,
  async synth(p,d,blob,store,produce) {
   if(!ledger.submit)throw Error("AUDIO_ATOMIC_SUBMIT_REQUIRED");
   const c=audioContract(p);
   assertBlobPath(blob,p.ownerId,p.id);
   if(!blob.endsWith(`/tts/${d.segment}.mp3`))throw Error("AUDIO_CACHE_PATH_INVALID");
   if(JSON.stringify(d)!==JSON.stringify(audioDemand(p,d.segment,d.characters,d.usd)))throw Error("AUDIO_DEMAND_INVALID");
   const op: PaidOperation={idempotencyKey:d.key,projectId:c.root,shotId:d.segment,provider:d.provider,model:d.model,method:AUDIO_TARIFF_METHOD,attemptKind:"initial",reservedUsd:d.usd,capacityUnits:d.characters,committedUsd:null,status:"RESERVED",providerJobId:null,resultRef:null,updatedAt:now()};
   let row=await ledger.get(d.key);
   if(!row){await ledger.insert(op);row=await ledger.get(d.key);}
   if(!row)throw Error("AUDIO_LEDGER_UNAVAILABLE");
   if(row.projectId!==op.projectId||row.shotId!==op.shotId||row.provider!==op.provider||row.model!==op.model||row.method!==op.method||row.reservedUsd!==op.reservedUsd||row.capacityUnits!==op.capacityUnits)throw Error("AUDIO_JOURNAL_MISMATCH");
   if(row.status==="COMMITTED"||row.status==="PROVIDER_JOB_RECORDED") {
    const bytes=await store.getBlob(blob);if(!bytes)throw Error("AUDIO_CACHE_RESTORATION_REQUIRED");await settle(p,d,bytes);return bytes;
   }
   if(row.status!=="RESERVED"||!await ledger.submit(row,now()))throw Error("AUDIO_RECONCILIATION_REQUIRED");
   // No retry/refund after an uncertain send. A crash leaves SUBMITTED durably fenced.
   const bytes=await produce();
   if(bytes.length===0)throw Error("AUDIO_EMPTY_RESULT");
   await store.putBlob(blob,bytes,"audio/mpeg");
   const durable=await store.getBlob(blob);
   if(!durable||hash(durable)!==hash(bytes))throw Error("AUDIO_CACHE_RESTORATION_REQUIRED");
   const resultRef=JSON.stringify({path:blob,sha256:hash(bytes),costBasis:"ESTIMATED_TARIFF"});
   if(!await ledger.update(d.key,"SUBMITTED",{status:"PROVIDER_JOB_RECORDED",committedUsd:d.usd,resultRef,updatedAt:now()}))throw Error("AUDIO_RECONCILIATION_REQUIRED");
   await settle(p,d,bytes);return bytes;
  },
  async usage(p) {
   const r=await rpc("pi_audio_supply_usage",{p_root:audioContract(p).root});
   if(r.error)throw Error("AUDIO_USAGE_UNAVAILABLE");if(r.data===null)return null;
   const d=r.data as Record<string,unknown>,spentUsd=Number(d.spentUsd),calls=Number(d.calls),characters=Number(d.characters);
   if(d.spentUsd==null||d.calls==null||d.characters==null||!Number.isFinite(spentUsd)||spentUsd<0||!Number.isSafeInteger(calls)||calls<0||!Number.isSafeInteger(characters)||characters<0)throw Error("AUDIO_USAGE_UNAVAILABLE");
   return {spentUsd,calls,characters};
  },
 };
}
export function supabaseAudioPaidSupply(service: SupabaseClient): AudioPaidSupply {
 const ledger=supabaseLedgerStore(service);
 // Mandatory even in local real mode: NODE_ENV and optional guard flags never bypass atomic admission.
 ledger.submit=op=>submitWithSupply(service,op);
 return audioPaidSupply({ledger,rpc:async(name,args)=>service.rpc(name,args)});
}
