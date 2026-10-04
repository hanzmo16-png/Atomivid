-- Run in a transaction after setting test.owner_id to a test/authorized owner UUID.
-- Leaves no request or ledger entry behind and makes no provider call.
begin;
do $$
declare
  request_id uuid := gen_random_uuid();
  owner_id uuid := current_setting('test.owner_id')::uuid;
  request_key text := request_id::text;
  grant_json jsonb;
  accepted boolean;
begin
  insert into public.video_requests(id,user_id,topic,style,duration_seconds,mode,status,render_attempts)
    values(request_id,owner_id,'Budget regression fixture','Curiosidades',30,'visual','processing',1);
  grant_json := jsonb_build_object('version','owner-pilot/1','requestId',request_key,'ownerId',owner_id,
    'budgetVerified',true,'billingBasis','prepaid_no_overage','expiresAt',now()+interval '1 hour',
    'modelId','eleven_multilingual_v2','maxVoiceCharacters',600,'maxVoiceCalls',2,
    'maxProviderUsd',0,'voiceUsdPer1kChars',0);
  insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,committed_usd,status,result_ref)
    values('owner_pilot_grant:'||request_key,request_key,'test','internal','test','human_direction','test',0,0,'COMMITTED',grant_json::text),
      ('hold:'||request_key,request_key,'test','elevenlabs','eleven_multilingual_v2','capacity_hold','test',0,0,'COMMITTED',null);
  accepted := public.reserve_owner_pilot_operation('call1:'||request_key,request_key,'test','elevenlabs','eleven_multilingual_v2','tts_with_timestamps','test',0);
  if not accepted then raise exception 'First call was blocked by a capacity hold'; end if;
  update public.pi_paid_operations set status='RECONCILIATION_REQUIRED' where idempotency_key='call1:'||request_key;
  accepted := public.reserve_owner_pilot_operation('call2:'||request_key,request_key,'test','elevenlabs','eleven_multilingual_v2','tts_with_timestamps','test',0);
  if not accepted then raise exception 'Second bounded call was blocked'; end if;
  accepted := public.reserve_owner_pilot_operation('call2:'||request_key,request_key,'test','elevenlabs','eleven_multilingual_v2','tts_with_timestamps','test',0);
  if accepted then raise exception 'Duplicate call was admitted'; end if;
  begin
    perform public.reserve_owner_pilot_operation('call3:'||request_key,request_key,'test','elevenlabs','eleven_multilingual_v2','tts_with_timestamps','test',0);
    raise exception 'Third call was admitted despite uncertain first call';
  exception when others then
    if sqlerrm <> 'PILOT_BUDGET_BLOCKED' then raise; end if;
  end;
end $$;
rollback;
