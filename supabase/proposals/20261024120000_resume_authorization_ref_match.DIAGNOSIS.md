# Diagnóstico (solo lectura) — SQL de PR #198 en producción sin registro en el historial de migraciones

Proyecto Supabase `msyxczcdjhbednmfzxqq`. Consultas SELECT únicamente (catálogo `pg_proc`/`pg_trigger`/`pg_class`,
`supabase_migrations.schema_migrations`, filas de control). Fecha: 2026-10-24 (UTC-5). Ninguna escritura.

## Hallazgos

1. **Historial**: `supabase_migrations.schema_migrations` tiene 39 filas; la última es `20261023025940 podcast_v2_production`.
   No hay ninguna fila `20261024*` (PR #198) y tampoco las de `20261008120000_documentary_recovery_budget` ni
   `20261008131541_documentary_recovery_resume`, aunque sus objetos existen (`pi_recovery_budgets`,
   `pi_recovery_resume_authorizations`, `pi_open_recovery_budget`, `pi_resume_recovery_budget`). Además las versiones del
   repo y de producción divergen en otras (p. ej. repo `20261014183400_finished_podcast_image_slot` vs prod `20261014183236`).
   ⇒ la SQL se aplicó fuera de `supabase db push`/`apply_migration` (SQL editor o `execute_sql`), que no inserta en el historial.
2. **Objetos de PR #198 presentes en producción**: `pi_spend_authorizations` (1 fila), `pi_spend_authorization_guard` + trigger,
   `pi_open_spend_authorization`, `pi_spend_authorization_usage`, `pi_submit_with_supply` (+ `_pre_authz`),
   `pi_recovery_resume_authorization`, `pi_documentary_resume_requires_budget` + trigger habilitado en `documentary_script_jobs`.
   Todas: owner `postgres`, `search_path=""`, EXECUTE anon=false / authenticated=false.
3. **El bypass T10c existe en producción**: el cuerpo de `pi_documentary_resume_requires_budget` NO contiene
   `r.authorization_ref = b.authorization_ref` (une solo por `project_id`). `prosecdef=false`.
4. **Hallazgo adicional (fail-closed involuntario)**: `pi_recovery_resume_authorizations` tiene ACL `{postgres=arwdDxtm/postgres}`
   (cerrada incluso a `service_role`) y el trigger es *invoker*. Por lo tanto, cuando la app (service_role) intenta un
   requeue de un job agotado, el trigger falla con `permission denied for table pi_recovery_resume_authorizations`
   (reproducido en PostgreSQL efímero, línea `INFO` de R11). Hoy nada se reanuda por esa vía, ni siquiera un A/A válido.
   La propuesta convierte el trigger en `SECURITY DEFINER` (owner postgres, EXECUTE revocado a todos los roles cliente).
5. **Job `e8048599-cf92-…`**: `failed`, `retry_count=3`; presupuesto `ACTIVE` cap 0.60; **0** autorizaciones durables para su
   proyecto. La única fila durable global (2026-10-08, job `03738404…`, ya `completed`, presupuesto `CLOSED`) usa una ref
   distinta a la del presupuesto (patrón A/B del flujo antiguo `pi_resume_recovery_budget`). Con la propuesta, un resume
   futuro debe registrar la autorización durable con la MISMA `authorization_ref` del presupuesto. Esto no afecta a jobs completados.

## Plan de reconciliación (NO ejecutado; requiere aprobación de Hans)

1. Congelar: no aplicar nada más en prod hasta reconciliar. Exportar `pg_get_functiondef` de los objetos listados y comparar md5
   contra los archivos del repo (md5 de prod registrados: trigger `26a24f8f…`, RPC `244d8bee…`, submit `53f37112…`).
2. Convertir las propuestas en migraciones con versión ≥ `20261024000000` en `supabase/migrations/` (en un PR aparte),
   todas idempotentes (`create or replace`, `if not exists`), en este orden: `20261024000000_spend_authorizations`,
   `20261024120000_resume_authorization_ref_match`.
3. Registrar en el historial lo que YA está aplicado sin re-ejecutarlo: `supabase migration repair --status applied 20261024000000`
   (y lo mismo para `20261008120000`, `20261008131541` y demás versiones sin fila), tras confirmar que el md5 coincide.
4. Aplicar `20261024120000` por la vía normal (`supabase db push` / workflow `apply-supabase-migration.yml`) para que quede
   registrado; verificar después con los mismos SELECT (prosecdef, proconfig, proacl, has_function_privilege, `exact_ref=true`).
5. Para divergencias de versión (repo vs prod), decidir caso por caso: renombrar el archivo del repo a la versión de prod o
   `migration repair --status reverted` + `applied`. Nunca re-ejecutar SQL ya aplicada sin md5 idéntico.
6. Rollback: `20261024120000_resume_authorization_ref_match.rollback.sql` (restaura el cuerpo de PR #198; reabre el bypass).
