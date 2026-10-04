-- Only the service worker can reserve a vision call; no client grants/policies.
-- Reservations survive uncertainty, so re-runs cannot enlarge the $0.10 ceiling.
create function public.reserve_reel_visual_review(p_key text, p_request_id text, p_shot text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare r public.video_requests%rowtype; n integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('reel-visual-review:' || p_request_id, 0));
  if exists(select 1 from public.pi_paid_operations where idempotency_key=p_key) then return false; end if;
  select * into r from public.video_requests where id::text=p_request_id;
  if coalesce(r.id is null or r.mode <> 'visual' or r.status <> 'processing'
    or p_key !~ '^op_[a-f0-9]{32}$' or p_shot !~ '^visual-review:scene-[0-9]+$', true) then
    raise exception 'VISUAL_REVIEW_SCOPE_BLOCKED';
  end if;
  -- Existing owner-pilot/1 grants authorize only prepaid voice calls, never vision.
  if exists(select 1 from public.pi_paid_operations where idempotency_key='owner_pilot_grant:'||p_request_id) then
    raise exception 'VISUAL_REVIEW_PILOT_NOT_AUTHORIZED';
  end if;
  select count(*) into n from public.pi_paid_operations
    where project_id=p_request_id and method='visual_relevance_review';
  if n >= 20 then raise exception 'VISUAL_REVIEW_BUDGET_BLOCKED'; end if;
  insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status)
    values(p_key,p_request_id,p_shot,'openai','gpt-4.1-mini-2025-04-14','visual_relevance_review','initial',0.005,'RESERVED');
  return true;
end;
$$;
revoke all on function public.reserve_reel_visual_review(text,text,text) from public,anon,authenticated;
grant execute on function public.reserve_reel_visual_review(text,text,text) to service_role;
