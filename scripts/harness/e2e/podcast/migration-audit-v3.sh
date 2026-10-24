#!/usr/bin/env bash
# USD 0. Auditoría reproducible de la migración PROPUESTA del estudio Podcast 3.0 (20261023120000_podcast_v3_studio)
# en una BD local desechable «migauditv3» (clon del esquema del arnés). Comprueba: aditiva (podcast_episodes intacta),
# re-ejecutable, RLS solo-lectura-del-dueño, escrituras solo con service role, CHECKs, reversión limpia y re-aplicación.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); R=$(git -C "$HERE" rev-parse --show-toplevel); E2E_HOME=${E2E_HOME:-$R/.e2e-local}
. "$E2E_HOME/paths.env"; H=$E2E_HOME/run; PORT=$PGPORT   # requiere podcast/start.sh (PG local en marcha)
PS="psql -h $H -p $PORT -U postgres -v ON_ERROR_STOP=1 -qAt"
MIG=$R/supabase/proposals/20261023120000_podcast_v3_studio.sql; RB=$R/supabase/proposals/20261023120000_podcast_v3_studio.rollback.sql
ok(){ echo "PASS $*"; }; bad(){ echo "FAIL $*"; FAILS=$((FAILS+1)); }; FAILS=0
$PS -d postgres -c "drop database if exists migauditv3"; $PS -d postgres -c "create database migauditv3"
pg_dump -h $H -p $PORT -U postgres -s atomivid | $PS -d migauditv3 >/dev/null 2>&1 || true
D="$PS -d migauditv3"
# Estado previo = esquema del arnés sin la propuesta (el arnés la aplica para el E2E).
$D -f $RB >/dev/null
[ "$($D -c "select count(*) from pg_tables where schemaname='public' and tablename in ('podcast_studio_episodes','podcast_studio_operations')")" = 0 ] && ok "estado previo sin tablas del estudio" || bad "estado previo"
U1=aaaaaaaa-0000-4000-8000-0000000000c1; U2=bbbbbbbb-0000-4000-8000-0000000000c2
$D -c "insert into auth.users(id,email) values ('$U1','c1@x'),('$U2','c2@x') on conflict do nothing"
$D -c "insert into public.podcast_episodes(id,user_id,title,source,script,voice_id,status,characters,estimated_usd) values ('22222222-0000-4000-8000-000000000001','$U1','v2 existente','tts','Hola','v1','ready',4,0.01) on conflict do nothing"
SNAP(){ $D -c "select md5(coalesce(string_agg(t::text,'|' order by id),'')) from (select * from public.podcast_episodes) t"; }
COLS(){ $D -c "select md5(string_agg(column_name||data_type,',' order by column_name)) from information_schema.columns where table_schema='public' and table_name='podcast_episodes'"; }
S0=$(SNAP); C0=$(COLS)
$D -f $MIG >/dev/null && $D -f $MIG >/dev/null && ok "migración aplica y es re-ejecutable (dos veces)" || bad "migración no re-ejecutable"
[ "$(SNAP)" = "$S0" ] && [ "$(COLS)" = "$C0" ] && ok "aditiva: podcast_episodes (filas y columnas) intacta" || bad "podcast_episodes cambió"
[ "$($D -c "select string_agg(relrowsecurity::text,',' order by relname) from pg_class where oid in ('public.podcast_studio_episodes'::regclass,'public.podcast_studio_operations'::regclass)")" = "true,true" ] && ok "RLS activado en ambas tablas" || bad "RLS"
[ "$($D -c "select string_agg(cmd,',' order by tablename) from pg_policies where tablename in ('podcast_studio_episodes','podcast_studio_operations')")" = "SELECT,SELECT" ] && ok "solo políticas de lectura (SELECT)" || bad "políticas"
SPEC='{"version":"podcast-studio/3","mode":"narracion"}'
E1=33333333-0000-4000-8000-000000000001; E2=33333333-0000-4000-8000-000000000002
$D -c "insert into public.podcast_studio_episodes(id,user_id,title,mode,spec) values ('$E1','$U1','ep1','narracion','$SPEC'),('$E2','$U2','ep2','dialogo','$SPEC')" && ok "service/postgres inserta episodios válidos" || bad "insert válido"
K=$(printf 'a%.0s' $(seq 1 64))
$D -c "insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values ('$K','$U1','$E1','elevenlabs','tts','reserved',0.01)" && ok "libro: fila válida" || bad "libro válido"
for q in "insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values ('NOHEX','$U1','$E1','x','y','reserved',0)" \
         "insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values ('$(printf 'b%.0s' $(seq 1 64))','$U1','$E1','x','y','gastado',0)" \
         "insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values ('$(printf 'c%.0s' $(seq 1 64))','$U1','$E1','x','y','reserved',-1)" \
         "insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values ('$K','$U1','$E1','x','y','reserved',0)" \
         "insert into public.podcast_studio_episodes(user_id,title,mode,spec) values ('$U1','x','karaoke','$SPEC')" \
         "insert into public.podcast_studio_episodes(user_id,title,mode,spec,status) values ('$U1','x','avatar','$SPEC','pagado')" \
         "insert into public.podcast_studio_episodes(user_id,title,mode,spec) values ('$U1','x','avatar','{\"version\":\"otra\"}')" \
         "insert into public.podcast_studio_episodes(user_id,title,mode,spec,authorized_usd) values ('$U1','x','avatar','$SPEC',-5)"; do
  if $D -c "$q" >/dev/null 2>&1; then bad "CHECK aceptó: ${q:0:90}"; else ok "CHECK rechaza: ${q:60:60}"; fi; done
AS(){ $D -c "begin; set local role $1; set local request.jwt.claim.sub='$2'; $3; commit;" 2>/dev/null | tail -1 || echo DENIED; }
# La app lee siempre con service role; el SELECT de authenticated depende de los privilegios por defecto del esquema
# (en Supabase: concedidos). En ambos casos un usuario NUNCA ve filas ajenas.
V=$(AS authenticated $U2 "select count(*) from public.podcast_studio_episodes"); { [ "$V" = 1 ] || [ "$V" = DENIED ]; } && ok "aislamiento: U2 ve solo lo suyo (resultado=$V)" || bad "aislamiento episodios ($V)"
V=$(AS authenticated $U2 "select count(*) from public.podcast_studio_operations"); { [ "$V" = 0 ] || [ "$V" = DENIED ]; } && ok "aislamiento: libro ajeno invisible (resultado=$V)" || bad "aislamiento libro ($V)"
V=$(AS anon $U1 "select count(*) from public.podcast_studio_episodes"); { [ "$V" = 0 ] || [ "$V" = DENIED ]; } && ok "anon no ve episodios (resultado=$V)" || bad "anon ve episodios ($V)"
for role in authenticated anon; do
  if $D -c "begin; set local role $role; set local request.jwt.claim.sub='$U1'; update public.podcast_studio_episodes set status='ready' where id='$E1'; commit;" >/dev/null 2>&1; then
    [ "$($D -c "select status from public.podcast_studio_episodes where id='$E1'")" = "draft" ] && ok "$role: UPDATE sin efecto" || bad "$role pudo cambiar el estado"
  else ok "$role: UPDATE denegado"; fi
  if $D -c "begin; set local role $role; insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values ('$(printf 'd%.0s' $(seq 1 64))','$U1','$E1','x','y','settled',0); commit;" >/dev/null 2>&1; then bad "$role pudo escribir en el libro"; else ok "$role: no puede escribir en el libro"; fi
done
$D -f $RB >/dev/null && ok "reversión aplica" || bad "reversión"
[ "$($D -c "select count(*) from pg_tables where schemaname='public' and tablename like 'podcast_studio_%'")" = 0 ] && [ "$(SNAP)" = "$S0" ] && ok "reversión quita solo las tablas del estudio (podcast_episodes intacta)" || bad "reversión tocó otra cosa"
$D -f $MIG >/dev/null && [ "$($D -c "select count(*) from public.podcast_studio_episodes")" = 0 ] && ok "re-aplicación tras reversión (tablas vacías: exportar antes de revertir si hubo uso real)" || bad "re-aplicación"
echo "RESUMEN fallos=$FAILS"
$PS -d postgres -c "drop database migauditv3"
exit $FAILS
