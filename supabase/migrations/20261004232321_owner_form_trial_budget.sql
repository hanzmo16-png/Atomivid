-- One confirmed owner, one exact form request, one render. No client access or subscription mutation.
create or replace function public.reserve_owner_form_trial_operation(
  p_key text, p_request_id text, p_shot text, p_provider text, p_model text,
  p_method text, p_attempt_kind text, p_reserved_usd numeric
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare g jsonb; r public.video_requests%rowtype; n integer; used numeric; cap integer; hold numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended('owner-form-trial:' || p_request_id, 0));
  if exists (select 1 from public.pi_paid_operations where idempotency_key = p_key) then return false; end if;
  select result_ref::jsonb into g from public.pi_paid_operations
    where idempotency_key = 'owner_form_trial:' || p_request_id and project_id = p_request_id
      and provider = 'internal' and method = 'human_direction' and status = 'COMMITTED'
      and reserved_usd = 0 and committed_usd = 0;
  select * into r from public.video_requests where id::text = p_request_id;
  if coalesce(g is null or r.id is null or g->>'version' <> 'owner-form-trial/1'
    or g->>'requestId' <> p_request_id or g->>'ownerId' <> r.user_id::text
    or g->>'authorization' <> '2026-10-04:owner-authorized-form-test'
    or (g->>'expiresAt')::timestamptz <= now()
    or r.mode <> 'visual' or r.duration_seconds <> 30 or r.language <> 'es'
    or r.topic <> g->>'topic' or r.style <> g->>'style' or g->>'language' <> 'es'
    or (g->>'durationSeconds')::integer <> 30 or (g->>'maxRenderAttempts')::integer <> 1
    or (g->>'maxAccountedUsd')::numeric <> 1.25
    or p_reserved_usd is null or p_reserved_usd <= 0, true)
    or not exists (select 1 from auth.users where id = r.user_id and email_confirmed_at is not null)
    then raise exception 'OWNER_FORM_TRIAL_SCOPE_BLOCKED'; end if;
  if p_method = 'generate_script' then
    cap := 3; hold := 0.15;
    if coalesce(r.status not in ('pending','failed','script_ready') or r.render_attempts <> 0
      or p_provider <> 'anthropic' or p_model <> 'claude-sonnet-5' or p_model <> g->>'scriptModel'
      or p_shot !~ '^script:main-[1-3]$' or (g->>'maxScriptCalls')::integer <> cap
      or (g->>'scriptReservationUsd')::numeric <> hold, true) then raise exception 'OWNER_FORM_TRIAL_SCRIPT_BLOCKED'; end if;
  elsif p_method in ('tts_with_timestamps','generate_image','visual_relevance_review') then
    if r.status <> 'processing' or r.render_attempts <> 1 or r.script_json is null
      or not exists (select 1 from public.pi_paid_operations where idempotency_key = 'owner_form_render:' || p_request_id
        and project_id = p_request_id and provider = 'internal' and method = 'freeze_reviewed_script' and status = 'COMMITTED')
      then raise exception 'OWNER_FORM_TRIAL_RENDER_BLOCKED'; end if;
    if p_method = 'tts_with_timestamps' then
      cap := 2; hold := 0.10;
      if coalesce(p_provider <> 'elevenlabs' or p_model <> 'eleven_multilingual_v2' or p_model <> g->>'voiceModel'
        or (g->>'maxVoiceCalls')::integer <> cap or (g->>'maxVoiceCharacters')::integer <> 1000, true)
        then raise exception 'OWNER_FORM_TRIAL_VOICE_BLOCKED'; end if;
    elsif p_method = 'generate_image' then
      cap := 6; hold := 0.08;
      if coalesce(p_provider <> 'openai' or p_model <> 'gpt-image-2' or p_shot !~ '^image:scene-[0-5]$'
        or (g->>'maxImages')::integer <> cap or (g->>'maxImageReservationUsd')::numeric <> hold, true)
        then raise exception 'OWNER_FORM_TRIAL_IMAGE_BLOCKED'; end if;
    else
      cap := 20; hold := 0.005;
      if coalesce(p_provider <> 'openai' or p_model <> 'gpt-4.1-mini-2025-04-14' or p_shot !~ '^visual-review:scene-[0-5]$'
        or (g->>'maxReviews')::integer <> cap, true) then raise exception 'OWNER_FORM_TRIAL_REVIEW_BLOCKED'; end if;
    end if;
  else raise exception 'OWNER_FORM_TRIAL_METHOD_BLOCKED'; end if;
  if p_reserved_usd > hold or p_attempt_kind <> 'initial' then raise exception 'OWNER_FORM_TRIAL_RESERVATION_BLOCKED'; end if;
  -- Retain uncertain/refused reservations in the total and count; retries cannot reopen capacity.
  select count(*) into n from public.pi_paid_operations where project_id = p_request_id and method = p_method;
  select coalesce(sum(greatest(reserved_usd, coalesce(committed_usd, 0))), 0) into used
    from public.pi_paid_operations where project_id = p_request_id and provider <> 'internal' and method <> 'capacity_hold';
  if n >= cap or used + p_reserved_usd > 1.25 then raise exception 'OWNER_FORM_TRIAL_BUDGET_BLOCKED'; end if;
  insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status)
    values(p_key,p_request_id,p_shot,p_provider,p_model,p_method,p_attempt_kind,p_reserved_usd,'RESERVED');
  return true;
end;
$$;
revoke all on function public.reserve_owner_form_trial_operation(text,text,text,text,text,text,text,numeric) from public,anon,authenticated;
grant execute on function public.reserve_owner_form_trial_operation(text,text,text,text,text,text,text,numeric) to service_role;
