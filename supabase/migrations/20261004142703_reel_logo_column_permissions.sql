-- A column REVOKE alone cannot override legacy table-wide grants.
-- Preserve each client role's existing privileges, excluding only the new logo column.
do $$
declare
  client_role text;
  insert_cols text;
  update_cols text;
begin
  foreach client_role in array array['anon', 'authenticated'] loop
    select string_agg(format('%I', column_name), ', ' order by ordinal_position)
      filter (where has_column_privilege(client_role, 'public.video_requests', column_name, 'INSERT')),
      string_agg(format('%I', column_name), ', ' order by ordinal_position)
      filter (where has_column_privilege(client_role, 'public.video_requests', column_name, 'UPDATE'))
      into insert_cols, update_cols
      from information_schema.columns
      where table_schema = 'public' and table_name = 'video_requests' and column_name <> 'brand_logo_path';
    execute format('revoke insert, update on public.video_requests from %I', client_role);
    execute format('revoke insert (brand_logo_path), update (brand_logo_path) on public.video_requests from %I', client_role);
    if insert_cols is not null then
      execute format('grant insert (%s) on public.video_requests to %I', insert_cols, client_role);
    end if;
    if update_cols is not null then
      execute format('grant update (%s) on public.video_requests to %I', update_cols, client_role);
    end if;
  end loop;
end $$;
