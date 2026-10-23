#!/usr/bin/env bash
# USD 0. Auditoría reproducible migración/rollback Podcast 2.x en BD local desechable "migaudit" (mismo clúster del arnés).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); R=$(git -C "$HERE" rev-parse --show-toplevel); E2E_HOME=${E2E_HOME:-$R/.e2e-local}
. "$E2E_HOME/paths.env"; H=$E2E_HOME/run; PORT=$PGPORT   # requiere podcast/start.sh (PG local en marcha)
PS="psql -h $H -p $PORT -U postgres -v ON_ERROR_STOP=1 -qAt"
MIG=$R/supabase/proposals/20261021200000_podcast_v2_production.sql; RB=$R/supabase/proposals/20261021200000_podcast_v2_production.rollback.sql
ok(){ echo "PASS $*"; }; bad(){ echo "FAIL $*"; FAILS=$((FAILS+1)); }; FAILS=0
$PS -d postgres -c "drop database if exists migaudit" ; $PS -d postgres -c "create database migaudit"
pg_dump -h $H -p $PORT -U postgres -s atomivid | $PS -d migaudit >/dev/null 2>&1 || true
D="$PS -d migaudit"
$D -c "select 1 from public.podcast_episodes limit 0" >/dev/null && ok "esquema clonado"
# Estado v1 = esquema actual menos la propuesta
$D -f $RB >/dev/null 2>&1
[ "$($D -c "select count(*) from information_schema.columns where table_name='podcast_episodes' and column_name in ('production','production_timeline')")" = 0 ] && ok "estado v1 (sin columnas v2)" || bad "estado v1"
POL0=$($D -c "select string_agg(policyname||cmd||array_to_string(roles,',')||coalesce(qual,''),'|' order by policyname) from pg_policies where tablename='podcast_episodes'")
RLS0=$($D -c "select relrowsecurity from pg_class where oid='public.podcast_episodes'::regclass")
U1=aaaaaaaa-0000-4000-8000-000000000001; U2=bbbbbbbb-0000-4000-8000-000000000002
$D -c "insert into auth.users(id,email) values ('$U1','a@x'),('$U2','b@x') on conflict do nothing"
$D -c "insert into public.podcast_episodes(id,user_id,title,source,script,voice_id,status,audio_path,audio_sha256,characters,estimated_usd) values
 ('11111111-0000-4000-8000-000000000001','$U1','v1 tts','tts','Hola','v1',  'ready','u1/a.mp3','abc',4,0.01),
 ('11111111-0000-4000-8000-000000000002','$U2','v1 upload','upload',null,null,'draft',null,null,0,0)"
SNAP(){ $D -c "select md5(string_agg(t::text,'|' order by id)) from (select id,user_id,title,language,source,script,voice_id,voice_name,characters,estimated_usd,status,audio_path,audio_sha256,video_status,review_status,publish_status,created_at,updated_at from public.podcast_episodes where id in ('11111111-0000-4000-8000-000000000001','11111111-0000-4000-8000-000000000002')) t"; }
H0=$(SNAP)
# Aplicar (dos veces: idempotencia)
$D -f $MIG >/dev/null 2>&1 && $D -f $MIG >/dev/null 2>&1 && ok "migración aplica y es re-ejecutable" || bad "migración"
[ "$(SNAP)" = "$H0" ] && ok "filas v1 intactas tras migrar" || bad "filas v1 cambiadas"
[ "$($D -c "select count(*) from public.podcast_episodes where id::text like '11111111%' and production is null and production_timeline is null")" = 2 ] && ok "v1: columnas nuevas nulas (pasan el CHECK)" || bad "v1 nulos"
PV='{"version":"podcast-production/1","mode":"conversation","style":"standard","turns":[{"id":"t1"}]}'
$D -c "insert into public.podcast_episodes(id,user_id,title,source,script,voice_id,production,production_timeline) values ('11111111-0000-4000-8000-0000000000a2','$U1','v2','tts','A: hola','v1','$PV','[]')" && ok "fila v2 válida aceptada" || bad "fila v2 válida"
for bad_p in '{"mode":"single","style":"standard","turns":[{}]}' '[1,2]' '"str"' '{"version":"podcast-production/1","mode":"single","style":"standard"}' '{"version":"x","mode":"single","style":"standard","turns":[{}]}' '{"version":"podcast-production/1","mode":"solo","style":"standard","turns":[{}]}' '{"version":"podcast-production/1","mode":"single","style":"standard","turns":[]}' '{"version":"podcast-production/1","mode":"single","style":"standard","turns":{}}'; do
  if $D -c "insert into public.podcast_episodes(user_id,title,source,script,voice_id,production) values ('$U1','bad','tts','x','v','$bad_p')" >/dev/null 2>&1; then bad "CHECK aceptó forma inválida $bad_p"; else ok "CHECK rechaza $(echo $bad_p | cut -c1-60)"; fi; done
if $D -c "insert into public.podcast_episodes(user_id,title,source,script,voice_id,production_timeline) values ('$U1','bad','tts','x','v','{}')" >/dev/null 2>&1; then bad "timeline objeto aceptado"; else ok "CHECK timeline exige array"; fi
BIG=$(python3 -c "import json;print(json.dumps({'version':'podcast-production/1','mode':'single','style':'standard','turns':[{'id':str(i),'t':'x'*800} for i in range(400)]}))")
# Por stdin: como argumento (-c) supera ARG_MAX y psql ni arranca, lo que se leía como «rechazado».
if echo "insert into public.podcast_episodes(user_id,title,source,script,voice_id,production) values ('$U1','big','tts','x','v','$BIG')" | $D >/dev/null 2>&1; then echo "INFO >256KiB sin comprimir aceptado (pg_column_size mide tamaño TOAST comprimido)"; else ok "CHECK tamaño rechaza producción grande"; fi
POL1=$($D -c "select string_agg(policyname||cmd||array_to_string(roles,',')||coalesce(qual,''),'|' order by policyname) from pg_policies where tablename='podcast_episodes'")
[ "$POL0" = "$POL1" ] && [ "$($D -c "select relrowsecurity from pg_class where oid='public.podcast_episodes'::regclass")" = "$RLS0" ] && ok "RLS y políticas sin cambios (rls=$RLS0)" || bad "RLS cambió"
# Aislamiento: authenticated como U2 no ve la producción de U1; no puede escribir
SEEN=$($D -c "begin; set local role authenticated; set local request.jwt.claim.sub='$U2'; select count(*) from public.podcast_episodes where production is not null; commit;" | tail -1)
[ "$SEEN" = 0 ] && ok "U2 no ve producción de U1 (RLS)" || bad "fuga RLS: $SEEN"
OWN=$($D -c "begin; set local role authenticated; set local request.jwt.claim.sub='$U1'; select count(*) from public.podcast_episodes where production is not null; commit;" | tail -1)
[ "$OWN" = 1 ] && ok "U1 ve su propia producción" || bad "dueño no ve: $OWN"
if $D -c "begin; set local role authenticated; set local request.jwt.claim.sub='$U1'; update public.podcast_episodes set production=null where user_id='$U1'; commit;" 2>/dev/null | grep -q .; then :; fi
LEFT=$($D -c "select count(*) from public.podcast_episodes where production is not null"); [ "$LEFT" = 1 ] && ok "authenticated no puede modificar production (sin política de escritura)" || bad "authenticated modificó production"
# Compatibilidad cruzada: código v1 (select * / insert sin columnas nuevas) sigue funcionando
$D -c "insert into public.podcast_episodes(user_id,title,source,script,voice_id) values ('$U1','v1 tras migrar','tts','x','v')" && ok "insert estilo v1 tras migrar" || bad "insert v1"
# Episodios v2 que la reversión debe dejar sin poder cobrar (borrador con video programado; listo)
$D -c "insert into public.podcast_episodes(id,user_id,title,source,script,voice_id,status,video_status,scheduled_at,budget_usd,production) values
 ('11111111-0000-4000-8000-0000000000a3','$U1','v2 programado','tts','A: hola\n\nB: adiós','v1','draft','scheduled',now(),5,'$PV'),
 ('11111111-0000-4000-8000-0000000000a4','$U1','v2 listo','tts','A: hola','v1','ready','none',null,3,'$PV')"
# Rollback
$D -c "create table bk as select id,production,production_timeline from public.podcast_episodes where production is not null or production_timeline is not null"
$D -f $RB >/dev/null && $D -f $RB >/dev/null && ok "rollback aplica y es re-ejecutable" || bad "rollback"
[ "$(SNAP)" = "$H0" ] && ok "filas v1 intactas tras rollback" || bad "v1 cambiadas tras rollback"
[ "$($D -c "select count(*) from public.podcast_episodes where id='11111111-0000-4000-8000-0000000000a2'")" = 1 ] && ok "episodio v2 sobrevive al rollback como fila (sin producción)" || bad "episodio v2 perdido"
[ "$($D -c "select count(*) from public.podcast_episodes_v2_rollback_backup")" = 3 ] && ok "rollback guarda copia de producción v2" || bad "sin copia"
[ "$($D -c "select status||'/'||video_status||'/'||budget_usd||'/'||source||'/'||coalesce(script,'-') from public.podcast_episodes where id='11111111-0000-4000-8000-0000000000a3'")" = "failed/blocked/0.0000/upload/-" ] && ok "v2 programado neutralizado (fallido, video bloqueado, presupuesto 0, sin guion TTS)" || bad "v2 programado sigue generable"
[ "$($D -c "select status||'/'||budget_usd||'/'||source from public.podcast_episodes where id='11111111-0000-4000-8000-0000000000a4'")" = "ready/0.0000/upload" ] && ok "v2 listo conserva su entrega con presupuesto 0" || bad "v2 listo"
[ "$($D -c "select prev_status||'/'||prev_video_status||'/'||prev_budget_usd||'/'||prev_source||'/'||prev_script from public.podcast_episodes_v2_rollback_backup where id='11111111-0000-4000-8000-0000000000a3'")" = "draft/scheduled/5.0000/tts/A: hola\n\nB: adiós" ] && ok "estado previo guardado en la copia" || bad "estado previo perdido"
[ "$($D -c "select relrowsecurity from pg_class where oid='public.podcast_episodes_v2_rollback_backup'::regclass")" = t ] && ok "copia con RLS activa" || bad "copia sin RLS"
CB=$($D -c "begin; set local role authenticated; set local request.jwt.claim.sub='$U1'; select count(*) from public.podcast_episodes_v2_rollback_backup; commit;" 2>&1 || true) ; CB=$(echo "$CB" | tail -1); case "$CB" in 0|*denied*) ok "authenticated no lee la copia ($CB)";; *) bad "copia legible: $CB";; esac
echo "INFO antes sin copia: rollback DESTRUCTIVO para datos v2: $($D -c "select count(*) from bk") fila(s) con production/timeline se pierden si no hay copia previa"
[ "$POL0" = "$($D -c "select string_agg(policyname||cmd||array_to_string(roles,',')||coalesce(qual,''),'|' order by policyname) from pg_policies where tablename='podcast_episodes'")" ] && ok "RLS igual tras rollback" || bad "RLS tras rollback"
# Re-aplicar y restaurar desde copia
REST="update public.podcast_episodes e set production=b.production, production_timeline=b.production_timeline, source=b.prev_source, script=b.prev_script, status=b.prev_status, video_status=b.prev_video_status, budget_usd=b.prev_budget_usd, error=b.prev_error from public.podcast_episodes_v2_rollback_backup b where b.id=e.id"
$D -f $MIG >/dev/null 2>&1 && $D -c "update public.podcast_episodes e set production=b.production, production_timeline=b.production_timeline, source=b.prev_source, script=b.prev_script, status=b.prev_status, video_status=b.prev_video_status, budget_usd=b.prev_budget_usd, error=b.prev_error from public.podcast_episodes_v2_rollback_backup b where b.id=e.id" && ok "re-migrar + restaurar copia" || bad "re-migrar"
[ "$($D -c "select count(*) from public.podcast_episodes where production is not null")" = 3 ] && ok "datos v2 restaurados desde copia" || bad "restauración"
[ "$($D -c "select status||'/'||video_status||'/'||budget_usd||'/'||source from public.podcast_episodes where id='11111111-0000-4000-8000-0000000000a3'")" = "draft/scheduled/5.0000/tts" ] && ok "estado previo restaurado" || bad "estado previo no restaurado"
# Segundo ciclo: tras restaurar, el episodio avanza (listo, presupuesto 20); otra reversión debe guardar ESE estado.
$D -c "update public.podcast_episodes set status='ready', video_status='ready', budget_usd=20, error=null where id='11111111-0000-4000-8000-0000000000a3'"
$D -f $RB >/dev/null && $D -f $MIG >/dev/null 2>&1 && $D -c "$REST" >/dev/null
[ "$($D -c "select status||'/'||video_status||'/'||budget_usd from public.podcast_episodes where id='11111111-0000-4000-8000-0000000000a3'")" = "ready/ready/20.0000" ] && ok "segundo ciclo de reversión restaura el estado más reciente" || bad "segundo ciclo restaura estado viejo"
echo "RESUMEN fallos=$FAILS"
$PS -d postgres -c "drop database migaudit"
exit $FAILS
