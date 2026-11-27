-- Explicit approval required. Quiesce Audio workers and roll back application code first.
-- Preserve all authorizations, paid operations, reservations and receipts. No ledger reset/delete.
-- Non-Audio calls retain the byte-identical pre-Audio wrapper. New Audio submissions fail closed.
create or replace function public.pi_submit_with_supply(p_key text,p_units numeric default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
begin
 if exists(select 1 from public.pi_paid_operations where idempotency_key=p_key and project_id like 'audio:%') then
  return jsonb_build_object('submitted',false,'reason','audio contract rolled back; restore cached results only');
 end if;
 return pi_internal.submit_before_audio(p_key,p_units);
end $$;
revoke all on function public.pi_reserve_audio_supply(text,jsonb,jsonb,jsonb) from service_role;
revoke all on function public.pi_submit_with_supply(text,numeric) from public,anon,authenticated;
grant execute on function public.pi_submit_with_supply(text,numeric) to service_role;
