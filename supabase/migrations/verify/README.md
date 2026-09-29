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

## Database security hardening (0029)

`0029_database_security_hardening.sql` closes three Security Advisor findings without touching data,
product behaviour or performance findings: `yt_video_experiment` becomes `security_invoker` and loses
every anon/authenticated privilege (backend only); `_migrations_applied` gets RLS with NO policies and
no client privileges (the runner connects as the table owner and service_role has BYPASSRLS, so both
keep working); the six trigger functions get `search_path = pg_catalog, public`. NOT applied to
production — requires a new explicit human authorization. The stub `00_…` now also creates the
`anon` and `service_role` roles (guarded) because 0029 revokes from them.

```bash
psql -d atomivid_migration_test -v ON_ERROR_STOP=1 -f supabase/migrations/0029_database_security_hardening.sql   # after 0001-0028
psql -d atomivid_migration_test -v ON_ERROR_STOP=1 -f supabase/migrations/verify/07_database_security_hardening_test.sql  # after 03-06, from the repo root (it re-applies 0029 with \i)
```

Checks (each raises on failure): the view is `security_invoker` and anon/authenticated have no privilege
on it while service_role keeps SELECT; the registry has RLS enabled, zero policies, no client privilege,
and the owner/runner can still insert, read and delete a probe row; anon and authenticated are denied on
the view and the registry; a deliberately re-granted view still shows owner B nothing (invoker semantics);
exactly six trigger functions carry the pinned `search_path` and none is SECURITY DEFINER; every trigger
still fires (and its limit logic still holds) from a session whose own `search_path` is `pg_catalog`
only; re-applying 0029 is a no-op; row counts of the six production tables are unchanged.
Runner rehearsal against a DB mirroring production's registry (0001–0022 registered, 0023–0028 objects
present but unregistered): see `docs/security/DB-HARDENING-V1.md`.

## Business telemetry foundation (0030)

`0030_business_telemetry_foundation.sql` adds three append-only, backend-only tables (`business_events`,
`business_event_rejections`, `business_attribution_touches`) with RLS enabled and NO policies, client
privileges revoked and a `bt_append_only()` trigger (pinned `search_path`). Additive and re-runnable.
NOT applied to production — requires a separate human authorization. Write path, schemas and policy:
`docs/business-telemetry/FOUNDATION-V0.md`.

```bash
psql -d atomivid_migration_test -v ON_ERROR_STOP=1 -f supabase/migrations/0030_business_telemetry_foundation.sql   # after 0001-0029
psql -d atomivid_migration_test -v ON_ERROR_STOP=1 -f supabase/migrations/verify/08_business_telemetry_test.sql   # after 07, from the repo root (re-applies 0030 with \i)
```

Checks (each raises on failure): the three tables are RLS-enabled, policy-free, client-revoked and
append-only (UPDATE/DELETE rejected); `bt_append_only` is non-definer with a pinned search_path; a
duplicate `event_id` or `idempotency_key` is refused by the database; provenance, actor type, JSON-object
metadata and rejection reasons are constrained; landing pages cannot carry query strings; a touch needs
at least one datum; anon and authenticated (even for their own user id) cannot read or write any of the
three tables; service_role reads and appends; re-applying 0030 is a no-op.
