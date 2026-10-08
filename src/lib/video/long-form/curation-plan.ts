import { planShotsFromScript, type ProductionPlan, type ProductionPlanBeatInput } from './production-plan';
import { PLAN_ESTIMATE_AVAILABILITY, resolveSequences, usesSequences } from './sequence-intent';
import { planSequenceShots } from './sequence-direction';

/** Curate the exact contracts the renderer estimates, including V6 sequence slots. */
export function curationPlanShots(beats:ProductionPlanBeatInput[],topic:string,plan:ProductionPlan){
 return usesSequences(plan)
  ? planSequenceShots(beats,resolveSequences(plan.sequences!,PLAN_ESTIMATE_AVAILABILITY)).shots
  : planShotsFromScript(beats,topic,plan.strategy).shots;
}
