import { test } from 'node:test';
import assert from 'node:assert/strict';
import { curationPlanShots } from './curation-plan';
import { computeProductionPlan, REAL_LONG_FORM_PROVIDER_NAMES, planShotsFromScript } from './production-plan';
import { showcaseBeats, showcaseSequences, showcaseSequencesV6, SHOWCASE_TOPIC } from './showcase-fixtures';
import { PLAN_ESTIMATE_AVAILABILITY, resolveSequences } from './sequence-intent';
import { planSequenceShots } from './sequence-direction';
import { requestedContracts } from './asset-curation';

for(const [version,sequences] of [[5,showcaseSequences],[6,showcaseSequencesV6]] as const) test(`curation v${version} uses the actual renderer's sequence contracts`,()=>{
 const plan=computeProductionPlan({beats:showcaseBeats,topic:SHOWCASE_TOPIC,strategy:'balanced',providers:REAL_LONG_FORM_PROVIDER_NAMES,sequences});assert.equal(plan.version,version);
 const shots=curationPlanShots(showcaseBeats,SHOWCASE_TOPIC,plan);
 const actual=planSequenceShots(showcaseBeats,resolveSequences(plan.sequences!,PLAN_ESTIMATE_AVAILABILITY)).shots;
 assert.deepEqual(shots,actual);
 const requested=requestedContracts(shots);assert(requested.size>0);
 assert([...requested.values()].some(x=>x.contract.kind==='IDENTITY'));
 assert([...requested.values()].some(x=>x.contract.kind==='EVIDENCE'));
});
test('confirmed legacy v4 preserves existing curation contracts',()=>{
 const plan=computeProductionPlan({beats:showcaseBeats,topic:SHOWCASE_TOPIC,strategy:'balanced',providers:REAL_LONG_FORM_PROVIDER_NAMES,version:4});
 assert.deepEqual(curationPlanShots(showcaseBeats,SHOWCASE_TOPIC,plan),planShotsFromScript(showcaseBeats,SHOWCASE_TOPIC,plan.strategy).shots);
});
