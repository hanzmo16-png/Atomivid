# Cierre de integración ATOMIVID: #201 → #199 → #200 + Supabase (2026-10-25)

Todo lo de este documento se hizo con USD 0. **Producción solo se leyó**, siempre dentro de `BEGIN TRANSACTION READ ONLY … ROLLBACK`, y se comprobó que una escritura de prueba es rechazada. Las escrituras de los ensayos fueron sobre una réplica desechable. No hubo merge, despliegue, migración, flags ni llamadas pagadas.

## 1. SHA exactos

| Pieza | Rama | SHA | CI |
|---|---|---|---|
| Base (producción Vercel) | `claude/atomivid-mvp-setup-0079jv` | `762714e2ff3d19a62d2c705b7487ff9a364677e7` | — |
| #201 (T10c, BD + app) | `grok/p0-auth-ref-trigger` | `9944360b5a32130d46811ea9d57f569b1e9031f5` | 7 ✅ / 1 omitido |
| #199 (Long Form; contiene #201) | `claude/documental-cinematografico` | `49594f1e989d1c6f8c21bae4e650075ea4532ed4` | 8 ✅ / 1 omitido |
| #200 (Podcast con F1/E6/F3) | `grok/podcast-audiovisual-cierre` | `1794224502c21f2dfdef6a38b74fdff34a34588a` | 18 ✅ / 1 omitido (auditado) |
| Referencia integrada (#205) | `claude/integracion-201-199-200` | `07ee87b80497ff50e6a4c60db15c42cc12d3440c` | 18 ✅ / 1 omitido |
| Ensayo de cierre | `claude/cierre-supabase-ensayo` | `616f634a3b948469a28b56b064b8ecede3e3581d` | run `40146932996` ✅, **0 FAIL** |

**Simulación de merges en orden sobre la base** (local, sin push):
- #201 → `f4bb118`: limpio.
- #199 → `e4ace72`: limpio.
- #200: **conflicto en `package.json`**. Es la única dependencia nueva.
  - Se resuelve con el `package.json` de #205, que conserva los scripts de ambos lados.
  - Con esa resolución, el árbol final es **idéntico a #205** salvo sus 6 archivos de QA/documentación. Por eso la evidencia de CI de #205 vale para el resultado real y no se repitió ninguna auditoría completa.

## 2. Supabase: estado leído hoy (run 40146932996)

- **Registros:**
  - `supabase_migrations.schema_migrations`: 39 filas.
  - `public._migrations_applied`: 45 nombres.
  - Repo: 51 migraciones.
- **Contra el esquema real:**
  - 43 migraciones aplicadas;
  - 7 sin objetos detectables, registradas en algún registro;
  - 1 parcial: `0002_generation`, que ya está registrada. Le falta la política pública que retiró `database_security_hardening`, a propósito; no requiere acción.
- **Conciliación A (necesaria):** 18 nombres faltan en `_migrations_applied`, la tabla que lee la herramienta del repo.
  - Son 17 migraciones con fecha, más `20261024000000` (aplicada, marcador `t`).
  - La lista recalculada hoy es **idéntica** a `docs/ops/20261024_register_applied_migrations.sql`.
  - 0 bloqueos.
- **Conciliación B (opcional, no recomendada):** 33 versiones faltan en `schema_migrations`. Solo importarían si algún día se usa `supabase db push`, y la regla es no usarlo.
- **Deriva sin archivo en el repo** (solo documentada; no se toca):
  - 21 entradas de `schema_migrations`;
  - 11 de `_migrations_applied` (`0020`–`0030`).
- **Riesgo real del mecanismo, corregido respecto a la versión anterior:** «aplicar todas» sin conciliar **no re-ejecuta nada**. Se detiene (exit 3) en `20261005143935` por el filtro de SQL destructivo, así que la herramienta queda inutilizable, no peligrosa. Con A aplicada, «aplicar todas» = 0 aplicadas (exit 0).
- **Propuestas:** 000000 aplicada; 120000, 130000 y 140000 **no aplicadas** (marcadores `f`, sin tablas `podcast_studio_*`).
- **Privilegios en producción:** las 7 funciones afectadas solo tienen `{postgres, service_role}`; `anon`/`authenticated` = f.
- **Datos que encontrarían las migraciones** (agregados, sin datos personales):
  - **120000:** hay 2 jobs agotados. Ninguno es reanudable con la regla actual ni con la nueva, así que **0 jobs pierden reanudación**. Hay 1 presupuesto de recuperación ACTIVE.
  - **130000:**
    - 1 autorización existente; su uso queda idéntico.
    - 1 proyecto podcast sin autorización con operaciones `RESERVED`: su autorización futura las contará como uso, que es el arreglo buscado.
    - 1 proyecto bloqueado por un cargo abierto `RECONCILIATION_REQUIRED`.
  - **140000:** el ledger del estudio no existe, y `pi_supply_state` queda igual.

## 3. Ensayo en PostgreSQL efímero (run 40146932996, 0 FAIL)

Réplica construida con el esquema real (con sus ACL), las 17 tablas `pi_*` con datos reales (mismas filas que producción) y ambos registros. Pasos:

1. «Aplicar todas» antes de conciliar, sobre una copia: se detiene sin ejecutar nada (exit 3).
2. Conciliación A:
   - se aplica;
   - una segunda ejecución se rechaza (precondición);
   - las 51 migraciones del repo quedan registradas;
   - «aplicar todas» = 0 aplicadas;
   - funciones, datos y respuestas económicas quedan idénticos.
3. Con la herramienta real `scripts/apply-supabase-migration.ts`, **un archivo por ejecución** (`migration_file`): 120000 → 130000 → 140000.
   - Cada una: exit 0, «1 aplicada», marcador `t`.
   - Re-ejecutar 140000: se omite.
4. Después:
   - ningún privilegio EXECUTE se amplía, y las funciones nuevas quedan cerradas a `anon`/`authenticated`;
   - `service_role` ejecuta todas las RPC;
   - todas fijan `search_path=''`;
   - las tablas del estudio tienen RLS y no admiten escritura de clientes;
   - **0 filas `pi_*` cambiadas**;
   - `pi_supply_state` es igual al estado previo en los 12 proveedores, en el mismo instante (solo añade contadores del estudio = 0, con ruido temporal medido de 0);
   - el uso de la autorización existente no cambia;
   - el tope de USD 50 del estudio está presente.
   - E1–E8 ya dieron 29/0/0 sobre el esquema real con estas propuestas; no se repitió.
5. Recuperación:
   - rollback 140000 → 130000 → 120000 y retirada del registro: las funciones vuelven al md5 de producción, los datos quedan idénticos y `pi_supply_state` vuelve a ser la función original;
   - rollback A: `_migrations_applied` vuelve a su md5 de producción;
   - B se aplica y se revierte: `schema_migrations` vuelve a su md5.
6. Repetibilidad: tras el rollback completo, el camino A + 120000 → 130000 → 140000 vuelve a pasar (marcadores `t t t`).

**Archivos exactos** (artefacto del run; generados desde la lectura de hoy):

| Archivo | sha256 |
|---|---|
| `A_register_migrations_applied.sql` | `577cd97bb715bf14…` |
| `A_register_migrations_applied.rollback.sql` | `d171b00ce4992abc…` |
| `B_register_schema_migrations.sql` | `d52832d61970db06…` |
| `B_register_schema_migrations.rollback.sql` | `4ef917d6959989da…` |

A se niega a ejecutarse si el registro cambió desde la auditoría, y verifica las 18 filas al final.

## 4. Checklist ejecutivo

**Prueba técnica** = ensayo ya hecho, USD 0. **Despliegue real** = cada operación 🔐, solo con tu autorización.

| # | Operación (despliegue real) | Prueba técnica hecha | Verificación posterior (USD 0) | Rollback | GO/NO-GO |
|---|---|---|---|---|---|
| O1 🔐 | **Conciliación A** en producción. Inserta 18 nombres en `_migrations_applied` y no ejecuta SQL de migraciones. | §3 pasos 1–2, 5 y 6 | `schema-readonly-pr200`: las 51 registradas; «aplicar todas» seguiría en 0 | `A_…rollback.sql` (borra exactamente esas 18) | **GO** |
| O1b | Conciliación B (`schema_migrations`) | §3 paso 5 | — | `B_…rollback.sql` | **NO-GO (innecesaria)**; regla: nunca `supabase db push` |
| O2 🔐 | Migración **120000**: commit que copia el archivo a `supabase/migrations/` + `apply-supabase-migration.yml` con `migration_file=20261024120000_resume_authorization_ref_match.sql` | §3 pasos 3–4 | Marcador 120000 = `t`; impacto medido: 0 jobs pierden reanudación | `…120000….rollback.sql` + borrar su nombre del registro | **GO** (compatible con el código actual) |
| O3 🔐 | Migración **130000**, igual que O2 | §3 pasos 3–4 | Marcador 130000 = `t`; uso de la autorización existente sin cambios | `…130000….rollback.sql` + registro | **GO** |
| O4 🔐 | **Merge #201** @ `9944360` → Vercel despliega | CI 7 ✅; sim merge limpio | Bloque A: inicio, login, panel, `GET /api/podcast` y Long Form en 200; `schema-readonly` verde | Promote del despliegue anterior en Vercel, o `git revert -m 1` | **GO** |
| O5 🔐 | **Merge #199** @ `49594f1` | CI 8 ✅; sim limpio sobre O4 | A + B: un trabajo Long Form muestra estado y presupuesto; si la referencia no coincide, la recuperación dice «requiere autorización» | Ídem, orden inverso | **GO** |
| O6 | **#200**: actualizar la rama con la base tras O5, resolviendo `package.json` = el de #205. Nuevo SHA + CI. | Resolución probada (árbol = #205) | CI verde en el nuevo SHA | — | **NO-GO hasta el nuevo SHA** (lo hace Grok o tú autorizas una rama `claude/*`) |
| O7 🔐 | **Merge #200** (nuevo SHA de O6) | CI #205 18 ✅; auditoría 1794224 | A + C: pedir video con presupuesto insuficiente → 402 y **0** autorizaciones nuevas (F1); estudio con el flag apagado → 503 | Promote anterior / revert. Con el flag apagado, el estudio no actúa | **GO tras O6** |
| O8 🔐 | Migración **140000**, igual que O2 | §3 pasos 3–5 | Marcador 140000 = `t`; `pi_supply_state` igual que antes; tablas del estudio vacías | `…140000….rollback.sql` + registro. Precondición: 0 operaciones del estudio `reserved`/`uncertain` | **GO** |
| O9 🔐 | Activar `PODCAST_V3_ENABLED` solo para Hans | — | Primera prueba real con tope | Apagar el flag | Fuera de este cierre |

Orden: O1 → O2 → O3 → O4 → O5 → O6 → O7 → O8. O2 y O3 pueden ir antes de los merges porque el código actual funciona con y sin ellas. O8 va después de O7.

**Cómo ejecutar O1** (no existe un workflow para SQL ad hoc), una de dos:
- (a) Hans pega `A_register_migrations_applied.sql` (sha256 `577cd97b…`) en el SQL Editor de Supabase;
- (b) autorizas a Claude a añadir, en una rama `claude/*`, un workflow de un solo uso que verifica ese sha256 y ejecuta solo ese archivo.

**Datos pendientes, que no bloquean la integración:**
- 1 operación de podcast `RECONCILIATION_REQUIRED` y 2 `RESERVED`. Bloquean abrir autorización en ese episodio hasta conciliarlas con el proveedor.
- Nunca reintentar a ciegas.

## 5. Autorizaciones exactas que necesito de Hans (una por paso)

1. «Autorizo O1: ejecutar en producción `A_register_migrations_applied.sql` sha256 `577cd97bb715bf14…` por la vía (a) / (b).»
2. «Autorizo O2 y O3: aplicar en producción `20261024120000_resume_authorization_ref_match.sql` y luego `20261024130000_spend_authorization_baseline_fix.sql`, uno por ejecución con `migration_file`, verificando marcadores entre ambos.»
3. «Autorizo O4: merge de #201 @ `9944360b`.» Luego O5: «merge de #199 @ `49594f1e`».
4. «Autorizo O6 a Grok (o a Claude en `claude/*`): actualizar #200 con la base y resolver `package.json` como #205; sin otros cambios.» Luego O7: «merge de #200 @ <SHA nuevo con CI verde>».
5. «Autorizo O8: aplicar `20261024140000_podcast_v3_studio.sql` con `migration_file`.»

Cada autorización vale solo para su paso. Si cambia un SHA o el registro, A se niega por sí sola y se repite el ensayo (≈ 2 min, USD 0).
