import {MUSIC_MANIFEST} from '../../src/lib/providers/music/manifest';
import {searchSceneVideos} from '../../src/lib/ai/footage';
export async function prepareAssets(cfg:any,io:any){
 const {db,bucket,seal}=io,uploads=[];
 for(let i=1;i<=8;i++){
  const id=`ia${String(i).padStart(2,'0')}`,path=`${cfg.ownerId}/podcasts/${cfg.episodeId}/references/${id}.jpg`;
  const {data,error}=await bucket.createSignedUploadUrl(path);if(error||!data)throw Error('PRIVATE_UPLOAD_PREPARE_FAILED');
  uploads.push({id,...data});
 }
 seal('private-uploads.json',Buffer.from(JSON.stringify(uploads)));
 const candidates=[];
 for(const query of ['pine forest night','forest road','vintage typewriter','night sky stars','rural road night','man thinking window']){
  try{candidates.push({query,results:await searchSceneVideos(query,8,'landscape')});}catch{candidates.push({query,results:[]});}
 }
 seal('stock-candidates.json',Buffer.from(JSON.stringify(candidates)));
 seal('music-manifest.json',Buffer.from(JSON.stringify(MUSIC_MANIFEST)));
 for(const track of MUSIC_MANIFEST.filter(t=>['elevenlabs-tension-1','elevenlabs-tension-2','elevenlabs-reflective-1','elevenlabs-cinematic-2'].includes(t.id))){
  const {data}=await db.storage.from('music-library').download(track.storagePath);
  if(data)seal(`music-${track.id}.mp3`,Buffer.from(await data.arrayBuffer()));
 }
 console.log('PRIVATE_ASSETS_PREPARED',JSON.stringify({references:uploads.length,stockQueries:candidates.length}));
}
