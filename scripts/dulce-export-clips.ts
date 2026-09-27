import fs from 'node:fs/promises';
import path from 'node:path';
import {createServiceClient} from '../src/lib/supabase/service';
async function main(){
 const out=process.env.SAMPLE_OUT_DIR!;
 const state=JSON.parse(await fs.readFile(path.join(out,'prepared.json'),'utf8'));
 const service=createServiceClient();
 for(const s of state.scenes){
  if(s.mediaType!=='video'||!String(s.objectPath).startsWith('dulce-001/samples/pilot/assets/'))throw Error('Unexpected asset or missing generated clip');
  const {data,error}=await service.storage.from('videos').download(s.objectPath);if(error||!data)throw Error('Cannot recover clip');
  await fs.writeFile(path.join(out,`${s.sceneId}.mp4`),Buffer.from(await data.arrayBuffer()));
 }
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Export failed');process.exitCode=1;});
