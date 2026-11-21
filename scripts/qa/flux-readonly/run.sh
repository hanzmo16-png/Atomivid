#!/usr/bin/env bash
# FLUX (20261113150000_flux_image_source): estado REAL en producción en SOLO LECTURA + ensayo en PostgreSQL DESECHABLE.
# 1) Producción: cada consulta va dentro de BEGIN TRANSACTION READ ONLY … ROLLBACK (se prueba que una escritura se rechaza).
#    pg_dump --schema-only (sin datos) también es de solo lectura. El volcado nunca sale del runner.
# 2) Réplica desechable con ESE esquema: aplicar → verificar → re-aplicar (idempotente) → rollback → verificar →
#    re-aplicar; y el rollback se NIEGA si existe un video FLUX. Además el verificador funcional del repo (stub).
# Nada se escribe en producción. Salida: líneas PASS/FAIL/INFO; código 1 si hay algún FAIL.
set -uo pipefail
R=$(git rev-parse --show-toplevel); T=$(mktemp -d); FAILS=0
pass(){ echo "PASS $*"; }; fail(){ echo "FAIL $*"; FAILS=$((FAILS+1)); }
PGBIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
MIG="$R/supabase/migrations/20261113150000_flux_image_source.sql"; RB="$R/supabase/rollbacks/20261113150000_flux_image_source.rollback.sql"
echo "INFO migración sha256 $(sha256sum "$MIG" | cut -c1-16) · rollback sha256 $(sha256sum "$RB" | cut -c1-16)"

# ---------- 1. Producción, solo lectura ----------
if URL=$(cd "$R" && npx tsx -e 'import { resolveConnection } from "./scripts/lib/supabase-db"; const c = resolveConnection(); if (!c) { process.exit(3) } process.stdout.write(c.connectionString)' 2>/dev/null); then
  PW=$(node -e 'const u=new URL(process.argv[1]); process.stdout.write(decodeURIComponent(u.password))' "$URL"); echo "::add-mask::$PW"; echo "::add-mask::$URL"
  RO(){ { printf 'begin transaction read only;\n'; cat; printf '\nrollback;\n'; } | "$PGBIN/psql" "$URL" -X -qAt -F ' | ' 2>"$T/err"; }
  ro=$(printf 'show transaction_read_only;' | RO | grep -E '^(on|off)$'); [ "$ro" = on ] && pass "producción: transacción READ ONLY respetada" || { fail "producción: la transacción no es de solo lectura ($ro); se detiene"; exit 1; }
  w=$(printf 'create temp table _probe(x int);' | RO 2>&1; cat "$T/err"); echo "$w" | grep -q "read-only transaction" && pass "producción: un intento de escritura es rechazado" || { fail "producción: escritura no rechazada; se detiene"; exit 1; }
  RO > "$T/prod.txt" <<'SQL'
select 'constraint', pg_get_constraintdef(oid) from pg_constraint where conname = 'video_requests_reel_image_source_valid';
select 'registry_schema_migrations', count(*) from supabase_migrations.schema_migrations where version = '20261113150000';
select 'registry_applied', case when to_regclass('public._migrations_applied') is null then -1 else (xpath('/row/c/text()', query_to_xml('select count(*) c from public._migrations_applied where name like ''20261113150000%''', false, true, '')))[1]::text::int end;
select 'policy_flux', coalesce((select enabled::text || '/' || daily_cap_usd || '/' || monthly_cap_usd from public.pi_supply_policies where provider = 'flux'), 'ausente');
select 'account_flux', coalesce((select secret_reference_name || '/' || status from public.pi_provider_accounts where provider = 'flux'), 'ausente');
select 'sources', coalesce(reel_image_source, 'null'), count(*) from public.video_requests group by 2 order by 2;
SQL
  sed 's/^/PROD /' "$T/prod.txt"
  if grep -q "^constraint | .*'flux'" "$T/prod.txt"; then echo "ESTADO_PRODUCCION migración FLUX APLICADA (el CHECK admite 'flux')"; else echo "ESTADO_PRODUCCION migración FLUX NO APLICADA (el CHECK no admite 'flux')"; fi
  grep -q "^sources | flux" "$T/prod.txt" && fail "producción: ya hay videos con reel_image_source=flux" || pass "producción: ningún video usa FLUX"
  "$PGBIN/pg_dump" "$URL" --schema-only --no-owner --no-privileges --no-comments -n public -f "$T/public.sql" 2>"$T/dump.err" || { fail "pg_dump: $(sed "s/$PW/***/g" "$T/dump.err" | head -3)"; exit 1; }
  echo "INFO esquema de producción volcado: $(wc -l < "$T/public.sql") líneas (solo en el runner)"
else
  if [ -n "${SCHEMA_SQL:-}" ]; then echo "INFO sin credencial de BD: lectura de producción NO_PROBADO; réplica con SCHEMA_SQL=$SCHEMA_SQL (no es producción)"; cp "$SCHEMA_SQL" "$T/public.sql"; else echo "INFO sin credencial de BD: lectura de producción NO_PROBADO; solo el stub"; : > "$T/public.sql"; fi
fi

# ---------- 2. Réplica desechable ----------
L=$T/local; "$PGBIN/initdb" -D "$L" -U postgres --auth=trust >/dev/null; "$PGBIN/pg_ctl" -D "$L" -o "-p 55991 -k $T -c listen_addresses=''" -l "$T/pg.log" -w start >/dev/null
trap '"$PGBIN/pg_ctl" -D "$L" -m fast stop >/dev/null 2>&1 || true; rm -rf "$T/public.sql"' EXIT
LQ="$PGBIN/psql -h $T -p 55991 -U postgres -X -q"
q(){ $LQ -d replica -qAt -c "$1"; }
step(){ if $LQ -d replica -v ON_ERROR_STOP=1 -f "$2" > "$T/step.log" 2>&1; then pass "$1"; else fail "$1: $(grep -m2 ERROR "$T/step.log")"; fi; }
# 2a) verificador funcional del repo sobre un stub (inserciones Reel/Long Form, Recraft intacto, política cerrada)
$LQ -d postgres -c "create database stub" >/dev/null
if (cd "$R" && $LQ -d stub -f supabase/migrations/verify/flux_image_source.sql > "$T/verify.log" 2>&1) && grep -q "ALL FLUX MIGRATION CHECKS PASSED" "$T/verify.log"; then
  pass "verificador funcional (stub): $(grep -c 'PASS' "$T/verify.log") comprobaciones, incluido Recraft sin cambios"; else fail "verificador funcional: $(grep -m2 -E 'FAIL|ERROR' "$T/verify.log")"; fi
if [ -s "$T/public.sql" ]; then
  $LQ -d postgres -c "create database replica" >/dev/null
  $LQ -d replica -f "$R/scripts/harness/e2e/infra/stubs.sql" >/dev/null 2>&1
  $LQ -d replica -c "create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions; create extension if not exists \"uuid-ossp\" with schema extensions" >/dev/null 2>&1
  $LQ -d replica -v ON_ERROR_STOP=0 -f "$T/public.sql" > "$T/restore.log" 2>&1
  echo "INFO restauración del esquema de producción: $(grep -c ERROR "$T/restore.log") errores (por objetos de Supabase ausentes; primeros 5):"; grep ERROR "$T/restore.log" | sort | uniq -c | sort -rn | head -5
  before=$(q "select pg_get_constraintdef(oid) from pg_constraint where conname='video_requests_reel_image_source_valid'")
  [ -n "$before" ] && pass "réplica: CHECK de producción presente" || fail "réplica: falta el CHECK video_requests_reel_image_source_valid"
  pre_applied=0; echo "$before" | grep -q "'flux'" && pre_applied=1
  if [ $pre_applied = 0 ]; then step "aplicar la migración FLUX sobre el esquema de producción" "$MIG"; fi
  q "select pg_get_constraintdef(oid) from pg_constraint where conname='video_requests_reel_image_source_valid'" | grep -q "'flux'" && pass "tras aplicar: el CHECK admite flux" || fail "tras aplicar: el CHECK no admite flux"
  q "select pg_get_constraintdef(oid) from pg_constraint where conname='video_requests_reel_image_source_valid'" | grep -q "'recraft'" && pass "tras aplicar: Recraft sigue admitido" || fail "tras aplicar: se perdió recraft"
  [ "$(q "select enabled::text || daily_cap_usd || monthly_cap_usd from pi_supply_policies where provider='flux'")" = "false00" ] && pass "tras aplicar: política de suministro flux CERRADA (enabled=false, topes 0)" || fail "política flux no cerrada"
  step "re-aplicar la migración (idempotente)" "$MIG"
  [ "$(q "select count(*) from pi_supply_policies where provider='flux'")" = 1 ] && pass "re-aplicar no duplica la política" || fail "política duplicada"
  step "rollback" "$RB"
  q "select pg_get_constraintdef(oid) from pg_constraint where conname='video_requests_reel_image_source_valid'" | grep -q "'flux'" && fail "tras rollback: el CHECK aún admite flux" || pass "tras rollback: CHECK restaurado a default/recraft"
  [ "$(q "select count(*) from pi_supply_policies where provider='flux'") $(q "select count(*) from pi_provider_accounts where provider='flux'")" = "0 0" ] && pass "tras rollback: política y cuenta flux retiradas" || fail "tras rollback: quedan filas flux"
  step "rollback repetido (idempotente)" "$RB"
  step "re-aplicar tras rollback" "$MIG"
  # rollback con un video FLUX: debe NEGARSE sin tocar datos (se crea la fila desactivando triggers SOLO en la réplica)
  cols=$(q "select string_agg(quote_ident(column_name), ',') from information_schema.columns where table_schema='public' and table_name='video_requests' and is_nullable='NO' and column_default is null")
  echo "INFO columnas obligatorias sin valor por defecto en video_requests: ${cols:-ninguna}"
  if $LQ -d replica -v ON_ERROR_STOP=1 -c "set session_replication_role = replica; insert into video_requests(id, mode, reel_image_source, user_id, topic, style, duration_seconds) values ('00000000-0000-0000-0000-0000000000f9','visual','flux', gen_random_uuid(), 'rollback test', (select coalesce((select style from video_requests limit 1), 'educational')), 30)" > "$T/ins.log" 2>&1; then
    if $LQ -d replica -v ON_ERROR_STOP=1 -f "$RB" > "$T/rb.log" 2>&1; then fail "rollback con un video FLUX: NO se negó"; else grep -q "Rollback FLUX abortado" "$T/rb.log" && pass "rollback con un video FLUX: se niega con mensaje claro" || fail "rollback con video FLUX falló por otro motivo: $(grep -m1 ERROR "$T/rb.log")"; fi
    [ "$(q "select reel_image_source from video_requests where id='00000000-0000-0000-0000-0000000000f9'")" = flux ] && pass "rollback negado: el video FLUX queda intacto" || fail "rollback negado alteró el video"
    q "select pg_get_constraintdef(oid) from pg_constraint where conname='video_requests_reel_image_source_valid'" | grep -q "'flux'" && pass "rollback negado: el CHECK sigue admitiendo flux (atómico)" || fail "rollback negado dejó el CHECK a medias"
  else echo "NO_PROBADO rollback con video FLUX sobre el esquema real: no se pudo crear la fila de prueba ($(grep -m1 ERROR "$T/ins.log"))"; fi
fi
echo "RESULTADO FLUX: $FAILS FAIL"; [ $FAILS = 0 ]
