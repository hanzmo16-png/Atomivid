-- T46: one canonical avatar row per owner/photo claim.
--
-- PREPARED ONLY in PR #153. Do not apply without the owner's explicit migration authorization.
-- The precondition fails closed if production already contains duplicates; those rows require a separate,
-- audited reconciliation decision and must never be deleted or merged automatically.

do $$
begin
  if exists (
    select 1
    from public.avatars
    where source_photo_path is not null
    group by user_id, source_photo_path
    having count(*) > 1
  ) then
    raise exception 'avatars has duplicate (user_id, source_photo_path) claims; reconcile before adding uniqueness';
  end if;
end
$$;

create unique index if not exists avatars_user_source_photo_claim_uidx
  on public.avatars (user_id, source_photo_path)
  where source_photo_path is not null;

comment on index public.avatars_user_source_photo_claim_uidx is
  'T46: durable authority for one avatar row per owner/photo claim; duplicate inserts must load the canonical row';
