import {createClient} from '@supabase/supabase-js';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
async function main(){
 const e=process.env;if(!/^\d+$/.test(e.MS_AV_RUN_ID??''))throw Error('run');
 const s=createClient(e.NEXT_PUBLIC_SUPABASE_URL,e.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}),b=s.storage.from('videos');
 const privacy=await s.storage.getBucket('videos');if(privacy.error||privacy.data.public!==false)throw Error('privacy');
 const read=async p=>{const d=await b.download(p);if(d.error||!d.data)throw Error('read');return d.data;};
 const accepted=JSON.parse(await (await read(`mystery-shopper/v3/receipts/av-accepted-${e.MS_AV_RUN_ID}.json`)).text());
 const journey=JSON.parse(await (await read(`mystery-shopper/v3/receipts/av-${e.MS_AV_RUN_ID}.json`)).text());
 if(accepted.accepted!==true||accepted.episodeId!==journey.episodeId||journey.authenticated!==true||journey.humanGate!==null)throw Error('binding');
 const [q,ops]=await Promise.all([s.from('podcast_studio_episodes').select('user_id,status,result').eq('id',accepted.episodeId).single(),s.from('podcast_studio_operations').select('key,state,result').eq('episode_id',accepted.episodeId).eq('op','tts').order('created_at',{ascending:true})]);
 if(q.error||ops.error||q.data.status!=='ready'||ops.data.some(x=>x.state!=='settled'))throw Error('native');
 const shots=q.data.result.shots.filter(x=>x.kind==='avatar_a'),prefix=`${q.data.user_id}/podcast-studio/${accepted.episodeId}/paid/`;
 if(shots.length!==ops.data.length||!shots.length)throw Error('turns');
 const dir=await mkdtemp(path.join(tmpdir(),'av-voice-tail-')),turns=[];let lastBytes,lastPath;
 try{
  for(let i=0;i<ops.data.length;i++){
   const ref=ops.data[i].result;if(typeof ref!=='string'||!ref.startsWith(`storage:${prefix}`)||!/^storage:[a-z0-9/-]+\.mp3$/.test(ref))throw Error('source');
   const source=ref.slice(8),bytes=Buffer.from(await (await read(source)).arrayBuffer()),file=path.join(dir,`turn-${i}.mp3`);await writeFile(file,bytes);
   const aligned=JSON.parse(await (await read(source.replace(/\.mp3$/,'.json'))).text());if(!Array.isArray(aligned)||!aligned.length)throw Error('words');
   const probe=spawnSync('ffprobe',['-v','error','-show_entries','format=duration','-of','json',file],{encoding:'utf8'});if(probe.status!==0)throw Error('probe');
   const measuredSeconds=Number(JSON.parse(probe.stdout).format.duration);if(!Number.isFinite(measuredSeconds))throw Error('duration');
   const detect=spawnSync('ffmpeg',['-hide_banner','-i',file,'-af','silencedetect=noise=-40dB:d=0.08','-f','null','-'],{encoding:'utf8'});if(detect.status!==0)throw Error('decode');
   const silenceEvents=[...detect.stderr.matchAll(/silence_(start|end):\s*([0-9.]+)/g)].map(m=>({kind:m[1],seconds:Number(m[2])}));
   const lastWords=aligned.slice(-8);if(lastWords.some(w=>!Number.isFinite(w.start)||!Number.isFinite(w.end)))throw Error('alignment');
   const lastWord=lastWords.at(-1),shot=shots[i];
   turns.push({index:i+1,source,shotStart:shot.start,shotEnd:shot.end,measuredSeconds,lastWords,absoluteLastWordEnd:shot.start+lastWord.end,silenceEvents,fullDecode:true});
   if(i===ops.data.length-1){lastBytes=bytes;lastPath=source;}
  }
 }finally{await rm(dir,{recursive:true,force:true});}
 const signed=await b.createSignedUrl(lastPath,300);if(signed.error||!signed.data?.signedUrl)throw Error('locator');
 const url=new URL(signed.data.signedUrl),trusted=new URL(e.NEXT_PUBLIC_SUPABASE_URL);if(url.origin!==trusted.origin||url.protocol!=='https:'||url.pathname!==`/storage/v1/object/sign/videos/${lastPath}`)throw Error('locator-binding');
 const receipt={scope:'PRIVATE_AV_RAW_VOICE_TAIL_READ_ONLY',episodeId:accepted.episodeId,turns,lastTts:{canonicalPath:lastPath,bytes:lastBytes.length,sha256:createHash('sha256').update(lastBytes).digest('hex'),signedUrl:url.href,expiresAt:Date.now()+300000},silenceThresholdDb:-40,silenceMinimumSeconds:0.08,providerCalls:0,ledgerMutations:0};
 const w=await b.upload(`mystery-shopper/v3/receipts/av-voice-tail-${e.GITHUB_RUN_ID}.json`,JSON.stringify(receipt),{contentType:'application/json',upsert:false,metadata:receipt});if(w.error)throw Error('receipt');
 console.log('Raw voice alignments, silence evidence and last-TTS locator saved privately; no provider calls or generation.');
}
main().catch(()=>{console.error('Raw voice tail inspection blocked; originals preserved and private values withheld.');process.exitCode=1;});
