-- A completed video's synchronous review cannot still be an active HTTP call.
-- Keep its uncertain cost reserved and its retry prohibition intact.
do $migration$
declare
 definition text := pg_get_functiondef('public.pi_supply_state_without_jobs(text)'::regprocedure);
 old_count text := $old$select count(*) into active_calls from public.pi_paid_operations where provider=p_provider
 and method <> 'capacity_hold' and status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED');$old$;
 new_count text := $new$select count(*) into active_calls from public.pi_paid_operations o where provider=p_provider
 and method <> 'capacity_hold' and status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED')
 and not (o.status='RECONCILIATION_REQUIRED' and o.provider='openai'
   and o.method='visual_relevance_review' and o.provider_job_id is null
   and exists(select 1 from public.video_requests v where v.id::text=o.project_id and v.status='completed'));$new$;
begin
 if (length(definition)-length(replace(definition,old_count,''))) <> length(old_count) then
  raise exception 'Expected exactly one active-call counter; no change applied';
 end if;
 execute replace(definition,old_count,new_count);
end
$migration$;
