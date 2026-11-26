import {createClient} from '@supabase/supabase-js';
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
 const turns=[];
 for(let i=0;i<ops.data.length;i++){
  const ref=ops.data[i].result;if(typeof ref!=='string'||!ref.startsWith(`storage:${prefix}`)||!/^storage:[a-z0-9/-]+\.mp3$/.test(ref))throw Error('source');
  const source=ref.slice(8);let aligned=null;
  try{aligned=JSON.parse(await (await read(source.replace(/\.mp3$/,'.json'))).text());}catch{/* Missing alignment is reported, never reconstructed. */}
  const lastWord=Array.isArray(aligned)&&aligned.length?aligned.at(-1):null,shot=shots[i];
  const hasValidWords=!!lastWord&&Number.isFinite(lastWord.start)&&Number.isFinite(lastWord.end)&&lastWord.end>=lastWord.start;
  turns.push({index:i+1,turnStart:shot.start,turnEnd:shot.end,lastWordEndAbsolute:hasValidWords?shot.start+lastWord.end:null,hasValidWords});
 }
 const receipt={scope:'PRIVATE_AV_WORD_ALIGNMENT_AGGREGATE_ONLY',turns,rawAudioDownloaded:false,rawAudioUrlCreated:false,providerCalls:0,ledgerMutations:0};
 const w=await b.upload(`mystery-shopper/v3/receipts/av-voice-tail-${e.GITHUB_RUN_ID}.json`,JSON.stringify(receipt),{contentType:'application/json',upsert:false,metadata:receipt});if(w.error)throw Error('receipt');
 console.log('Only aggregate word timing floats saved privately; no word text, raw audio, URL or provider call exported.');
}
main().catch(()=>{console.error('Raw voice tail inspection blocked; originals preserved and private values withheld.');process.exitCode=1;});
