/** Official ElevenLabs speech-to-speech through the existing ledger. Never retries a POST. */
import {guardPaidCall,type LedgerStore} from './gate';
import {paidResultPath,sha256Hex,type PaidResultStore,UNSTORED_REF} from './result-store';
import {ProviderRejectedError} from './errors';

export type VoiceConversionInput={projectId:string;shotId:string;voiceId:string;modelId:'eleven_multilingual_sts_v2';audio:Buffer;seconds:number;maximumSeconds:number;usdPerMinute:number;maximumUsd:number;voiceSettings:{stability:number;similarity_boost:number;style:number;use_speaker_boost:boolean};seed:number};
export type VoiceConversionReceipt={audioPath:string;sha256:string;bytes:number;inputSha256:string;inputSeconds:number;voiceId:string;modelId:string;requestId:string|null;providerCreditCost:number|null;costBasis:'published_api_source_audio_rate';meteredUsd:number;mimeType:'audio/mpeg';reviewApproved:false};
export async function gatedVoiceConversion(deps:{ledger:LedgerStore;results:PaidResultStore;apiKey:string;fetchImpl?:typeof fetch;beforePost:()=>Promise<void>},input:VoiceConversionInput){
 const f=deps.fetchImpl??fetch;
 if(!input.voiceId.trim()||!deps.apiKey.trim()||input.modelId!=='eleven_multilingual_sts_v2'||!input.audio.length||!Number.isFinite(input.seconds)||input.seconds<=0||input.seconds>input.maximumSeconds||input.maximumSeconds>10||!Number.isFinite(input.usdPerMinute)||input.usdPerMinute<=0||!Number.isFinite(input.maximumUsd)||input.maximumUsd<=0)throw new Error('VFX_VOICE_CONVERSION_CONTRACT_INVALID');
 const cost=Number((input.seconds*input.usdPerMinute/60).toFixed(8));if(cost>input.maximumUsd)throw new Error('VFX_VOICE_BUDGET_EXCEEDED');
 const fingerprint={voiceId:input.voiceId,modelId:input.modelId,inputSha256:sha256Hex(input.audio),inputSeconds:input.seconds,voiceSettings:input.voiceSettings,seed:input.seed,outputFormat:'mp3_44100_128'};
 const load=async(ref:string)=>{if(ref.startsWith(UNSTORED_REF))return null;const meta=await deps.results.getJson<VoiceConversionReceipt>(ref);if(!meta)return null;const audio=await deps.results.getBytes(meta.audioPath);return audio&&audio.length===meta.bytes&&sha256Hex(audio)===meta.sha256?{audio,meta}:null;};
 return guardPaidCall(deps.ledger,{projectId:input.projectId,shotId:input.shotId,provider:'elevenlabs',model:input.modelId,method:'speech_to_speech',attemptKind:'trial',reservedUsd:cost,inputFingerprint:fingerprint},{maxRejectedRetries:0,load,call:async({key})=>{
  await deps.beforePost();
  const form=new FormData();form.set('audio',new Blob([new Uint8Array(input.audio)],{type:'audio/wav'}),'original-phrase.wav');form.set('model_id',input.modelId);form.set('voice_settings',JSON.stringify(input.voiceSettings));form.set('seed',String(input.seed));
  const response=await f('https://api.elevenlabs.io/v1/speech-to-speech/'+encodeURIComponent(input.voiceId)+'?output_format=mp3_44100_128',{method:'POST',headers:{'xi-api-key':deps.apiKey},body:form,signal:AbortSignal.timeout(180000)});
  if(!response.ok)throw new ProviderRejectedError('ELEVENLABS_CONVERSION_HTTP_'+response.status,'rejected_final');
  const audio=Buffer.from(await response.arrayBuffer());if(!audio.length||audio.length>10*1024*1024)throw new Error('VFX_VOICE_RESPONSE_INVALID');
  const header=response.headers.get('character-cost');const creditCost=header!==null&&Number.isFinite(Number(header))?Number(header):null;
  const meta:VoiceConversionReceipt={audioPath:paidResultPath(input.projectId,key,'mp3'),sha256:sha256Hex(audio),bytes:audio.length,inputSha256:fingerprint.inputSha256,inputSeconds:input.seconds,voiceId:input.voiceId,modelId:input.modelId,requestId:response.headers.get('request-id'),providerCreditCost:creditCost,costBasis:'published_api_source_audio_rate',meteredUsd:cost,mimeType:'audio/mpeg',reviewApproved:false};
  const ref=paidResultPath(input.projectId,key,'json');let resultRef=ref;
  try{await deps.results.putBytes(meta.audioPath,audio,meta.mimeType);await deps.results.putJson(ref,meta);}catch{resultRef=UNSTORED_REF+'VOICE_CONVERSION_STORAGE_FAILED';}
  return {result:{audio,meta},costUsd:cost,resultRef};
 }});
}
