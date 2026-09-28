# Verificación local de migraciones (Postgres real, no Supabase)

Scripts usados para verificar `0011_video_modes_avatar.sql` contra un
Postgres 16 local real (no solo revisión manual) — reproducible por
cualquiera, sin necesitar una cuenta de Supabase.

```bash
createdb atomivid_migration_test
psql -d atomivid_migration_test -f supabase/migrations/verify/00_stub_supabase_schema.sql
for f in supabase/migrations/*.sql; do psql -d atomivid_migration_test -v ON_ERROR_STOP=1 -f "$f"; done
psql -d atomivid_migration_test -f supabase/migrations/verify/01_rls_and_idempotency_test.sql
dropdb atomivid_migration_test
```

`00_stub_supabase_schema.sql` crea versiones mínimas de `auth`/`storage`
(los esquemas que Supabase provee y que las migraciones de Atomivid
referencian) para que las migraciones reales apliquen sin cambios sobre
un Postgres normal.

`01_rls_and_idempotency_test.sql` confirma, con dos usuarios simulados:
que un usuario no puede ver ni insertar avatares/solicitudes de otro
(RLS), y que el índice único de `idempotency_key` rechaza duplicados
mientras sigue permitiendo múltiples `NULL`.

Esto NO reemplaza aplicar la migración en el proyecto real de Supabase —
solo confirma que el SQL es válido, idempotente y que las policies hacen
lo que dicen hacer, antes de pedir esa autorización.

## Production Intelligence / Distribution / Delivery (0023–0025)

Proposed order (NOT applied to production; needs explicit authorization):
`0023_production_intelligence.sql` → `0024_distribution_youtube.sql` → `0025_delivery_assets.sql`.
They start at 0023 because 0020–0022 exist on unmerged branches (`claude/audiovisual-profiles`
0020, `claude/medieval-horse-sample` 0021, `claude/ocean-documentary` 0022); none of the new
migrations depends on them, so either merge order works. All three are re-runnable.

```bash
psql -d atomivid_migration_test -f supabase/migrations/verify/03_production_intelligence_test.sql
```

Checks (each raises on failure): unique idempotency keys, forward-only and final paid operations,
append-only telemetry/policy history, immutable memory snapshots and project pins, a single ACTIVE
policy, secret NAMES only in the provider registry, UNKNOWN capacity never stored as GREEN, no signed
URLs as storage paths, masters never expiring, encrypted-only OAuth envelopes, no invented metrics,
and RLS: an owner sees only their channel; clients cannot read tokens, ledger or delivery records.
Supabase security/performance advisors can only run after the migrations are applied to a real project.
