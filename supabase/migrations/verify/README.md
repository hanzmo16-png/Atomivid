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
0020–0022 were applied to production from unmerged branches (0020 + 0021 on 2026-09-26 from
`claude/voices-medieval-tts`, 0022 on 2026-09-27 from `claude/tts-podcast`). They are restored here
byte-for-byte (one variant per file across all branches); hashes, sources and known production state
live in `supabase/migration-manifest.json`. None of 0023–0025 depends on them. 0023–0025 are re-runnable;
0001, 0003, 0007, 0008, 0021 and 0022 are not re-runnable as raw SQL (idempotency comes from the
`_migrations_applied` registry, which the apply script checks first).

Full local rehearsal (fresh DB, then a DB that mirrors production's registry 0001–0022 and runs the
real `scripts/apply-supabase-migration.ts` with `SUPABASE_DB_URL` pointing at the LOCAL socket only):

```bash
createdb atomivid_rehearsal
psql -d atomivid_rehearsal -f supabase/migrations/verify/00_stub_supabase_schema.sql
for f in supabase/migrations/00{0,1}*.sql supabase/migrations/002[0-2]_*.sql; do psql -v ON_ERROR_STOP=1 -d atomivid_rehearsal -f "$f"; done
# register 0001-0022 in public._migrations_applied, then:
SUPABASE_DB_URL="postgresql://$USER@/atomivid_rehearsal?host=/var/run/postgresql" npx tsx scripts/apply-supabase-migration.ts   # applies 0023-0025
SUPABASE_DB_URL="postgresql://$USER@/atomivid_rehearsal?host=/var/run/postgresql" npx tsx scripts/apply-supabase-migration.ts   # 0 applied, 25 skipped
```

```bash
psql -d atomivid_migration_test -f supabase/migrations/verify/03_production_intelligence_test.sql
```

Checks (each raises on failure): unique idempotency keys, forward-only and final paid operations,
append-only telemetry/policy history, immutable memory snapshots and project pins, a single ACTIVE
policy, secret NAMES only in the provider registry, UNKNOWN capacity never stored as GREEN, no signed
URLs as storage paths, masters never expiring, encrypted-only OAuth envelopes, no invented metrics,
and RLS: an owner sees only their channel; clients cannot read tokens, ledger or delivery records.
Supabase security/performance advisors can only run after the migrations are applied to a real project.
