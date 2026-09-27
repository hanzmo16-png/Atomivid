/** Build exact timings from the one cached narration; no paid keys or generation. */
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createServiceClient} from '../src/lib/supabase/service';
import {loadProductionCachedBeatNarration} from '../src/lib/video/long-form/production-tts-cache';
import {getVoiceIdentity} from '../src/lib/ai/voice';
import {validateSampleManifest, type SampleManifest} from '../src/lib/video/long-form/sample-manifest';
async function main(){
  const spec=JSON.parse(await fs.readFile('docs/quality/dulce-001/montage.json','utf8'));
  const reviews=JSON.parse(await fs.readFile('docs/quality/dulce-001/reference-review.json','utf8'));
  const script=JSON.parse(await fs.readFile('content/long-form/dulce-001/script.json','utf8'));
  const service=createServiceClient();
  for(const scene of spec.scenes){
    const ref=spec.scenes.find((s:{id:string})=>s.id===scene.referenceId);
    const bucket=service.storage.from('videos');
    const originalPath=`${spec.outputPrefix}/ai/${ref.key}-still.png`;
    const {data,error}=await bucket.download(originalPath);
    if(error||!data)throw Error('Reviewed reference missing; do not regenerate');
    const bytes=Buffer.from(await data.arrayBuffer());
    const hash=createHash('sha256').update(bytes).digest('hex');
    if(reviews[ref.id]?.sha256!==hash||reviews[ref.id]?.status!=='approved')throw Error(`Reference ${ref.id} not visually approved`);
    if(scene.referenceId!==scene.id){
      // Reuse exact reviewed bytes, not a new image request; retain failed reservation untouched.
      const alias=`${spec.outputPrefix}/ai/${scene.key}-still.png`;
      const {error:writeError}=await bucket.upload(alias,bytes,{contentType:'image/png',upsert:true});
      if(writeError)throw Error('Cannot cache reviewed reference alias');
      const meta={sha256:hash,prompt:ref.prompt,reusedFrom:originalPath,costUsd:0,kind:'ai_still'};
      const {error:metaError}=await bucket.upload(alias.replace('.png','.json'),Buffer.from(JSON.stringify(meta)),{contentType:'application/json',upsert:true});
      if(metaError)throw Error('Cannot cache reference provenance');
    }
  }
  const voiceId='nPczCjzI2devNBz1zQrb';
  const n=await loadProductionCachedBeatNarration(service,'elevenlabs',script.beats[0],'en',{videoId:'dulce-001',voiceIdentity:getVoiceIdentity('en',voiceId)});
  const total=n.durationSeconds+1;
  if(total>46.8||total<20)throw Error(`Narration ${n.durationSeconds}s outside six-clip envelope; revise montage without regenerating voice`);
  const boundaries=[0];
  for(let i=1;i<6;i++){
    const target=total*i/6;
    const candidates=n.words.slice(1).map((w,k)=>(w.startSeconds+n.words[k].endSeconds)/2).filter(t=>t>boundaries[i-1]+2&&t<boundaries[i-1]+7.8);
    if(!candidates.length)throw Error('No valid speech boundary');
    boundaries.push(candidates.reduce((a,b)=>Math.abs(a-target)<Math.abs(b-target)?a:b));
  }
  boundaries.push(total);
  const m:SampleManifest={requestId:'dulce-001',script:{file:'content/long-form/dulce-001/script.json',language:'en'},voiceId,beats:['b1'],outputLabel:'dulce-pilot',tailSeconds:1,outputPrefix:spec.outputPrefix,captionStyle:'word-highlight',scenes:[],soundCues:[{id:'tension',track:'elevenlabs-tension-1',role:'music',startSeconds:0,endSeconds:total,gain:0.13,fadeInSeconds:0.8,fadeOutSeconds:1.2,loop:true}],missingSound:[]};
  for(let i=0;i<6;i++){
    const id=`d0${i+1}`,s=spec.scenes.find((s:{id:string})=>s.id===id),start=boundaries[i],end=boundaries[i+1];
    m.scenes.push({id,startSeconds:start,endSeconds:end,narration:n.words.filter(w=>(w.startSeconds+w.endSeconds)/2>=start&&(w.startSeconds+w.endSeconds)/2<end).map(w=>w.text).join(' '),source:{kind:'veo-clip',key:s.key,reference:{kind:'ai-still',prompt:s.prompt},prompt:s.animationPrompt,placeholder:{source:{kind:'graphic',spec:{kind:'text',title:'Visual pending',body:'Not a finished shot',isFixture:true,size:'large'}},provenance:'data_graphic'}},provenance:'ai_recreation',creditText:'Fictional dramatization — not archival evidence',direction:{camera:'still',transition:{type:'cut'}},review:{status:reviews[id].animationApproved?'approved':'pending',relevance:'directa',note:reviews[id].animationApproved?'Reference and generated motion inspected for identity, anatomy and continuity':'Reference inspected; animated result awaits visual review'},...(i===0?{overlay:{text:'DULCE · A fictional retelling',startSeconds:0.2,endSeconds:Math.min(4,end)}}:{})});
  }
  if(process.env.SAMPLE_MANIFEST?.endsWith('/animatic-manifest.json')){
    // A separately labelled free animatic, never represented as generated-motion output.
    const marks=['Thomas','At','Beyond'];
    const cuts=[0,...marks.map(text=>{const k=n.words.findIndex(w=>w.text===text);if(k<1)throw Error('Animatic phrase absent');return(n.words[k-1].endSeconds+n.words[k].startSeconds)/2;}),total];
    m.outputLabel='dulce-animatic';
    m.scenes=['d01','d02','d03','d04'].map((id,i)=>{
      const s=spec.scenes.find((s:{id:string})=>s.id===id),start=cuts[i],end=cuts[i+1];
      return {id,startSeconds:start,endSeconds:end,narration:n.words.filter(w=>(w.startSeconds+w.endSeconds)/2>=start&&(w.startSeconds+w.endSeconds)/2<end).map(w=>w.text).join(' '),source:{kind:'existing' as const,path:`${spec.outputPrefix}/ai/${s.key}-still.png`},provenance:'ai_recreation' as const,creditText:'AI stills · Cinematic style test',direction:{camera:'push' as const,transition:{type:'cut' as const}},review:{status:'approved' as const,relevance:'directa' as const,note:'Original AI still visually inspected; editorial camera movement only, not generated motion.'},...(i===0?{overlay:{text:'DULCE · Visual concept',startSeconds:0.2,endSeconds:Math.min(4,end)}}:{})};
    });
  }
  const issues=validateSampleManifest(m,n.words,n.durationSeconds).filter(i=>i.code!=='pending_review');if(issues.length)throw Error(JSON.stringify(issues));
  await fs.writeFile(process.env.SAMPLE_MANIFEST??'docs/quality/dulce-001/pilot-manifest.json',JSON.stringify(m,null,2));
  if(process.env.SAMPLE_OUT_DIR){await fs.mkdir(process.env.SAMPLE_OUT_DIR,{recursive:true});await fs.writeFile(`${process.env.SAMPLE_OUT_DIR}/pilot-manifest.json`,JSON.stringify(m,null,2));await fs.writeFile(`${process.env.SAMPLE_OUT_DIR}/narration-words.json`,JSON.stringify(n.words));}
  console.log(`@@DULCE_TIMING ${JSON.stringify({narrationSeconds:n.durationSeconds,total,boundaries})}`);
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Manifest failed');process.exitCode=1;});
