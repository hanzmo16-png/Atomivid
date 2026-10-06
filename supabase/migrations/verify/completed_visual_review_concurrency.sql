begin;
do $test$
declare vid uuid:=gen_random_uuid(); k text:='concurrency-test-'||gen_random_uuid(); before_state jsonb; after_state jsonb;
begin
 before_state:=public.pi_supply_state('openai');
 assert before_state->>'level'<>'UNKNOWN','fresh balance required for test';
 insert into public.video_requests(id,user_id,topic,style,duration_seconds,status)
 select vid,user_id,'ROLLBACK concurrency fixture','Educativo',30,'completed' from public.video_requests where id='918f4d6a-c5fe-4b6c-a8bd-127490ebc794';
 insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status)
 values(k,vid::text,'review','openai','fixture','visual_relevance_review','initial',0.001,'RECONCILIATION_REQUIRED');
 after_state:=public.pi_supply_state('openai');
 assert (after_state->>'activeCalls')::int=(before_state->>'activeCalls')::int,'completed synchronous review occupies slot';
 assert (after_state->>'held')::numeric=(before_state->>'held')::numeric+0.001,'uncertain cost was released';
 insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status) values(k||'-submitted',vid::text,'submitted','openai','fixture','visual_relevance_review','initial',0.001,'SUBMITTED');
 assert (public.pi_supply_state('openai')->>'activeCalls')::int=(before_state->>'activeCalls')::int+1,'submitted call must occupy slot';
 insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status,provider_job_id) values(k||'-async',vid::text,'async','openai','fixture','visual_relevance_review','initial',0.001,'RECONCILIATION_REQUIRED','fixture-async');
 assert (public.pi_supply_state('openai')->>'activeCalls')::int=(before_state->>'activeCalls')::int+2,'async uncertainty must occupy slot';
 insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status) values(k||'-other',vid::text,'image','openai','fixture','generate_image','initial',0.001,'RECONCILIATION_REQUIRED');
 assert (public.pi_supply_state('openai')->>'activeCalls')::int=(before_state->>'activeCalls')::int+3,'other uncertain methods stay blocked';
end
$test$;
rollback;
select 'PASS: completed synchronous review releases only concurrency; money held; submitted, async and other uncertain operations still occupy slots; fixtures rolled back' as result;