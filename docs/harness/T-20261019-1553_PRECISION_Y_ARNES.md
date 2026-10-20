# T-20261019-1553 — Precisión monetaria del ledger y rigor del arnés (Grok)

Candidato inicial: PR154 `a761b0130ef7845450d54e705bf7552dc6dad40c` (apilado sobre #151–#153). Rama: `grok/reel-money-precision-e2e-20261019`.
Estado: **borrador para auditoría**. Hay criterios obligatorios sin cumplir (pasos 3 y 4 no se ejecutaron; defecto D-RACE abierto).

## 1. Política de precisión (única, aplicada en el gate)
`src/lib/paid-calls/ledger-usd.ts`. `reserved_usd`/`committed_usd` son `numeric(12,4)` (0023). Postgres redondea half-up a 4 dp
(0.00004999 → 0.0000; 0.00005 → 0.0001) y rechaza |x| ≥ 1e8.
- NaN, ±Infinity, negativo, no numérico, desbordamiento → `LedgerAmountError` **antes** de insertar en el ledger y antes del proveedor.
- 0 se conserva (fixture, biblioteca curada, reservas que ya eran 0 por diseño, reuso pagado).
- Positivo → redondeo HACIA ARRIBA a 0.0001 USD. Es **importe contable de reserva/liquidación**, nunca el costo exacto. Nunca baja a 0.
- Puntos de aplicación: `guardPaidCall` (spec.reservedUsd y costUsd de `call`/`resume`), `commitRecordedPaidJob`, `capacity-hold`
  (reserved_usd), `configuredAvatarCreationCostUsd` (antes asumía 6 dp → causa raíz). Voz, música e imágenes pasan todas por `guardPaidCall`.
- Sin cambio de esquema; no hace falta migración. No se inventan precios (la tarifa sigue viniendo de env/estimación existente).

Causa raíz: `Math.ceil(x*1e6)/1e6` en create-avatar-ledger.ts + `Math.max(0, estimado)` sin redondeo en voz/música + escritura directa de
`costUsd` en el gate: un positivo < 0.00005 llegaba a la columna y Postgres lo guardaba como 0.0000 tras una llamada facturable.

Efecto lateral conocido: `pi_supply_job_reservations.reserved_usd/consumed_usd` son `numeric` sin escala; el ledger ahora sobreestima hasta
0.0001 por operación frente al sobre. Dirección segura (sobreestima), pero puede consumir sobre antes; ver riesgos.

## 2. Adaptador PG del arnés vs adaptador real (`supabase-ledger-store.ts`)
| Aspecto | Real (Supabase) | Arnés (`scripts/harness/pg-ledger-store.ts`) |
|---|---|---|
| numeric→number | `Number(r.reserved_usd)` (PostgREST devuelve number o string) | `Number()` sobre string de node-pg: equivalente |
| capacityUnits | se envía si definido; se lee si no null | **no se envía ni lee** (la tabla del test no tiene la columna); sin impacto en importes |
| Duplicado | 23505 → false | 23505 → false |
| Otros errores | `PaidLedgerUnavailableError` | `PaidLedgerUnavailableError` |
| CAS update | `.eq(status, expected)` + select, éxito si 1 fila | `where status=$expected returning`, éxito si rowCount 1 |
| submit | `submitWithSupply` (RPC atómica de suministro, set SUBMITTED + capacity_units + supply_job_key) | CAS RESERVED→SUBMITTED **sin** comprobación de presupuesto/capacidad (mock) |
| Trigger forward-only / no-delete | sí (0023) | **no instalado** en la tabla del test; transiciones validadas por el CAS del motor |
| Columnas posteriores (supply_pool, supply_reconciled, supply_job_key, check pi_supply_operation_finite) | sí | no |
| RLS/grants | RLS sin política de cliente; service role | superusuario local |

## 3. Procedencia de 0023
`supabase/migrations/0023_production_intelligence.sql` de `9dccd68c3b06bffab2dc91ab415de6c2a73062bd` (rama `origin/claude/production-intelligence-v1`,
28-sep-2026). El archivo recuperado es idéntico byte a byte (`diff` vacío), sha256 `0b49d9a4752d19c1b6f6f24df6c3f0c6fbdbd39136a41832f5a6189aa7fa8131`.
No está en el árbol por defecto (0020–0029 faltan). `docs/quality/bigfoot-recovery/COST_AND_PROCEDURE.md:145` afirma que 0023–0025 están
aplicadas en producción. La rama PI además tiene `0029_database_security_hardening.sql` (fija search_path de `pi_paid_operation_forward_only`).
Migraciones del árbol que alteran la tabla: `20261005143935` (capacity_units, supply_pool, supply_reconciled), `20261005150229` (supply_job_key),
`20261005152850` (check `pi_supply_operation_finite`). **No verificado contra producción**: requiere la consulta de catálogo de abajo.

### SQL de catálogo SOLO LECTURA para ChatGPT (sin secretos ni datos personales)
```sql
select column_name, data_type, numeric_precision, numeric_scale, is_nullable, column_default
from information_schema.columns where table_schema='public' and table_name in ('pi_paid_operations','pi_supply_job_reservations') order by table_name, ordinal_position;
select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid in ('public.pi_paid_operations'::regclass,'public.pi_supply_job_reservations'::regclass) order by 1;
select indexname, indexdef from pg_indexes where schemaname='public' and tablename='pi_paid_operations' order by 1;
select tgname, pg_get_triggerdef(oid) from pg_trigger where tgrelid='public.pi_paid_operations'::regclass and not tgisinternal;
select p.proname, md5(pg_get_functiondef(p.oid)) def_md5, p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and (p.proname like 'pi_%' or p.proname like '%supply%') order by 1;
select relrowsecurity, relforcerowsecurity from pg_class where oid='public.pi_paid_operations'::regclass;
select policyname, roles, cmd, qual, with_check from pg_policies where schemaname='public' and tablename='pi_paid_operations';
select grantee, privilege_type from information_schema.role_table_grants where table_schema='public' and table_name='pi_paid_operations' order by 1,2;
select version, name from supabase_migrations.schema_migrations where version like '002%' or name like '%production_intelligence%' order by 1;
-- Agregado sin datos personales: ¿hay filas facturables registradas en 0?
select provider, method, count(*) from public.pi_paid_operations where status='COMMITTED' and committed_usd=0 and method<>'capacity_hold' group by 1,2 order by 3 desc;
```

## 4. Concurrencia y respuesta perdida (PG real, conexiones independientes)
`scripts/harness/ledger-race.pg.test.ts` (ROJO a propósito, 3/3 ejecuciones): con 2, 5 y 10 clientes **siempre 1 llamada al proveedor**
(sin doble cobro), pero:
- **D-RACE (P1, consistencia/recuperabilidad):** un perdedor que llega mientras la fila del ganador está `SUBMITTED` (llamada en vuelo) ejecuta
  la rama de `executePaidOperation` "SUBMITTED sin job id → RECONCILIATION_REQUIRED" y **pisa la fila del ganador**. El ganador ya no puede
  registrar `PROVIDER_JOB_RECORDED`, lanza `ReconciliationRequiredError`; resultado: avatar pagado y no utilizable, todos los clientes bloqueados,
  sólo recuperable con reconciliación manual. Causa raíz: el motor no distingue "en vuelo ahora" de "caído tras SUBMITTED" (sin lease/edad).
  Propuesta (no aplicada; motor compartido de #151): sólo escalar a RECONCILIATION_REQUIRED si `updated_at` supera un lease (p.ej. > timeout del
  proveedor); dentro del lease, responder "en curso, reintenta" sin mutar la fila. Mitigación actual en producción: el photo claim de createAvatar
  excluye la mayoría de reenvíos, pero el ledger por sí solo no.
- Mensaje del perdedor: `ReconciliationRequiredError: concurrent submission detected` aunque no haya nada que reconciliar → bloqueo de cliente
  con mensaje engañoso (P2, UX/clasificación).
- Respuesta perdida tras aceptar: fila `RECONCILIATION_REQUIRED`, reserva 0.0001 conservada, reintento **sin** nueva llamada (comprobado).
