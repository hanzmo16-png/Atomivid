import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldCompositeSchema, CutMasterSchema, assertCuts, assertWorld, assertReviewedSegments, worldCompositeExecutor, assertFixedFlagApproval } from './sequence-compositor';
import type { Brief, Environment, Plan } from './index';
const file = {path:'/missing',sha256:'a'.repeat(64)};
const brief: Brief = {projectId:'test',intent:'worlds',emotion:'wow',frames:150,fps:30,width:1080,height:1920,sourceSha256:file.sha256,subjectLock:'identity_with_relight',budgetUsd:0,environments:[{id:'nyc',kind:'city',lighting:'night_practical'},{id:'beach',kind:'beach',lighting:'daylight_soft'},{id:'moon',kind:'moon',lighting:'sun_hard'}]};
const config = WorldCompositeSchema.parse({kind:'world-composite',source:file,plate:file,matte:file,room:file,look:file,environmentId:'nyc',worldKind:'city',lighting:'night_practical',root:'/missing'});
const env: Environment = {...brief.environments[0],startFrame:0,endFrame:50,materialAssetId:'plate',materialSha256:file.sha256,light:'frozen look',continuityIn:'source',continuityOut:'cut'};
const task: Plan['tasks'][number] = {stage:'integration',id:'nyc-integrate',environmentId:'nyc',executor:'world',dependsOn:[],inputAssetIds:['plate'],outputAssetId:'nyc-out',instruction:'compose',acceptance:['review']};
const master = {...task,stage:'master' as const,environmentId:undefined,inputAssetIds:['nyc-out','beach-out','moon-out']};
const cuts = CutMasterSchema.parse({kind:'cut-master',root:'/missing',segments:brief.environments.map((e,i)=>({...file,assetId:e.id+'-out',environmentId:e.id,startFrame:i*50,endFrame:(i+1)*50}))});
test('fixed background is an explicit lunar flag direction, never a default motion fallback',()=>{
  assert.equal(config.plateMotion.mode,'moving');
  assert.equal(WorldCompositeSchema.safeParse({...config,plateMotion:{mode:'fixed_lunar_flag'}}).success,false);
  assert.equal(WorldCompositeSchema.safeParse({...config,plateMotion:{mode:'fixed_lunar_flag',authorization:file}}).success,false);
  const fixed=WorldCompositeSchema.parse({...config,environmentId:'moon',worldKind:'moon',lighting:'sun_hard',plateMotion:{mode:'fixed_lunar_flag',authorization:file}});
  const review={approved:true,stage:'fixed-background-direction',projectId:brief.projectId,environmentId:'moon',materialSha256:file.sha256,sourceSha256:file.sha256,reviewerId:'d2064950-7a95-4208-8dfb-d93b470d141d',approvedAt:'2026-10-03T20:23:17Z'};
  assert.doesNotThrow(()=>assertFixedFlagApproval(fixed,brief,review));
  for(const change of [{approved:false},{materialSha256:'b'.repeat(64)},{sourceSha256:'b'.repeat(64)},{projectId:'other'},{environmentId:'beach'}])assert.throws(()=>assertFixedFlagApproval(fixed,brief,{...review,...change}));
});
test('world rejects wrong light and missing material before reading files',async()=>{
  const ex=worldCompositeExecutor(config);
  await assert.rejects(ex.run(task,brief,'test',{...env,lighting:'daylight_soft'}),/WORLD_OR_LIGHT/);
  assert.throws(()=>assertWorld(config,{...task,inputAssetIds:[]},brief,env),/MATERIAL_NOT_BOUND/);
  assert.throws(()=>assertWorld(config,task,{...brief,sourceSha256:'b'.repeat(64)},env),/SOURCE_MATERIAL/);
});
test('frozen look change alters only the configured executor recipe',()=>{
  const old=worldCompositeExecutor(config).capability.recipeVersion;
  assert.notEqual(worldCompositeExecutor({...config,look:{...file,sha256:'b'.repeat(64)}}).capability.recipeVersion,old);
  assert.equal(worldCompositeExecutor(config).capability.recipeVersion,old);
});
test('master accepts only complete ordered hard-cut coverage',()=>{
  assert.doesNotThrow(()=>assertCuts(cuts,master,brief));
  for(const segments of [cuts.segments.slice(0,2),[...cuts.segments].reverse(),cuts.segments.map((s,i)=>i===1?{...s,startFrame:51}:s),cuts.segments.map((s,i)=>i===2?{...s,endFrame:149}:s)]) {
    assert.throws(()=>assertCuts({...cuts,segments},master,brief));
  }
  assert.throws(()=>assertCuts(cuts,{...master,inputAssetIds:['unreviewed','beach-out','moon-out']},brief));
});
test('manifest forbids crossfade, blur and per-world grain options',()=>{
  assert.equal(WorldCompositeSchema.safeParse({...config,grainStrength:2}).success,false);
  assert.equal(WorldCompositeSchema.safeParse({...config,blur:0}).success,false);
  assert.equal(CutMasterSchema.safeParse({...cuts,transition:'crossfade'}).success,false);
});

test('master refuses a valid file fingerprint that differs from reviewed integration',()=>{
  const job={plan:{environments:cuts.segments.map((s,i)=>({...env,...brief.environments[i],startFrame:s.startFrame,endFrame:s.endFrame})),tasks:cuts.segments.map(s=>({...task,id:s.environmentId,environmentId:s.environmentId,outputAssetId:s.assetId}))} as Plan,results:Object.fromEntries(cuts.segments.map(s=>[s.environmentId,{assetId:s.assetId,sha256:s.sha256,checks:[]}]))};
  assert.doesNotThrow(()=>assertReviewedSegments(cuts,job));
  assert.throws(()=>assertReviewedSegments({...cuts,segments:cuts.segments.map((s,i)=>i===1?{...s,sha256:'b'.repeat(64)}:s)},job),/REVIEWED_SEGMENT_MISMATCH/);
});
