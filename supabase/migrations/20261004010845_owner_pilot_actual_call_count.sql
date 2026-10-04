-- One-request operator grant; no client policies and no Stripe mutation.
create or replace function public.reserve_owner_pilot_operation(
  p_key text, p_request_id text, p_shot text, p_provider text, p_model text,
  p_method text, p_attempt_kind text, p_reserved_usd numeric
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare g jsonb; r public.video_requests%rowtype; n integer; used numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended('owner-pilot:' || p_request_id, 0));
  if exists (select 1 from public.pi_paid_operations where idempotency_key = p_key) then return false; end if;
  select result_ref::jsonb into g from public.pi_paid_operations
    where idempotency_key = 'owner_pilot_grant:' || p_request_id and project_id = p_request_id
      and provider = 'internal' and method = 'human_direction' and status = 'COMMITTED'
      and reserved_usd = 0 and committed_usd = 0;
  select * into r from public.video_requests where id::text = p_request_id;
  if coalesce(g is null or r.id is null or g->>'version' <> 'owner-pilot/1' or g->>'requestId' <> p_request_id
    or g->>'ownerId' <> r.user_id::text or g->>'budgetVerified' <> 'true'
    or g->>'billingBasis' <> 'prepaid_no_overage'
    or (g->>'expiresAt')::timestamptz <= now() or r.mode <> 'visual' or r.duration_seconds > 30
    or r.status <> 'processing' or r.render_attempts <> 1
    or p_provider <> 'elevenlabs' or p_model <> 'eleven_multilingual_v2' or p_model <> g->>'modelId'
    or p_method <> 'tts_with_timestamps' or p_reserved_usd is null or p_reserved_usd <> 0
    or p_reserved_usd > (g->>'maxVoiceCharacters')::numeric / 1000 * (g->>'voiceUsdPer1kChars')::numeric
    or (g->>'maxVoiceCalls')::integer <> 2 or (g->>'maxProviderUsd')::numeric <> 0
    or (g->>'voiceUsdPer1kChars')::numeric <> 0, true) then
    raise exception 'PILOT_SCOPE_BLOCKED';
  end if;
  -- Every actual reserved/uncertain call consumes the ceiling, including failures.
  -- Capacity holds are bookkeeping reservations, never provider submissions.
  select count(*), coalesce(sum(greatest(reserved_usd, coalesce(committed_usd, 0))), 0) into n, used
    from public.pi_paid_operations where project_id = p_request_id and provider <> 'internal' and method <> 'capacity_hold';
  if n >= 2 or used + p_reserved_usd > (g->>'maxProviderUsd')::numeric then raise exception 'PILOT_BUDGET_BLOCKED'; end if;
  insert into public.pi_paid_operations(idempotency_key, project_id, shot_id, provider, model, method, attempt_kind, reserved_usd, status)
    values(p_key, p_request_id, p_shot, p_provider, p_model, p_method, p_attempt_kind, p_reserved_usd, 'RESERVED');
  return true;
end;
$$;
revoke all on function public.reserve_owner_pilot_operation(text,text,text,text,text,text,text,numeric) from public, anon, authenticated;
grant execute on function public.reserve_owner_pilot_operation(text,text,text,text,text,text,text,numeric) to service_role;

