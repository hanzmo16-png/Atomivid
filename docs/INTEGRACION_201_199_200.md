# Integración #201 → #199 → #200 y procedimiento de lanzamiento de pruebas

Rama de verificación: `claude/integracion-201-199-200` (borrador, **no fusionar**). Presupuesto de esta preparación: USD 0.
Nada de esto se desplegó, fusionó ni migró. Las ramas originales de Grok (#200, #201) y la de #199 no se tocaron.

## 1. SHA

| Pieza | Rama | SHA |
|---|---|---|
| Base (producción) | `claude/atomivid-mvp-setup-0079jv` | `762714e2ff3d19a62d2c705b7487ff9a364677e7` |
| #201 seguridad económica (T10c) | `grok/p0-auth-ref-trigger` | `9944360b5a32130d46811ea9d57f569b1e9031f5` |
| #199 Long Form / rescate documental | `claude/documental-cinematografico` | `96f6055ea5e53ef755688153d6ba8af618fdf0f9` |
| #200 Podcast audiovisual | `grok/podcast-audiovisual-cierre` | `7153c354e38f2f0520498ca3c636af553ab574a3` |
| Integración | `claude/integracion-201-199-200` | ver la cabecera del PR borrador (`3d4a553fb0ec87c8b2b405b53e45ae60b7d30e39 (código; este documento va en el commit siguiente)`) |

Commits de la integración, en orden:
1. `96aaa4e` merge #201 · `43efccd` merge #199 (conflicto mecánico en `scripts/qa/spend-authorization-db.sh`) ·
   `25296eb` merge #200 (unión de `test:unit`; se conservan `podcast3:demo` y `test:podcast3`, restaurados en `28f6821`).
2. `cdba4bc` **correcciones propuestas para #200** (Grok debe portarlas a su rama, o el dueño las acepta desde aquí):
   - **F1 (P1, bloqueante):** la ruta de video abría la autorización de gasto inmutable antes de validar; una solicitud
     rechazada fijaba su tope para siempre. Ahora `validatePodcastVideoRequest` corre primero.
   - **E6 (P2):** una reserva del estudio huérfana ocupaba un cupo de concurrencia para siempre; ahora deja de ocuparlo a
     las 4 h (más que el timeout de 200 min del job) y sigue contando como posible cargo.
   - **F3 (P2):** un episodio de estudio «generating» con el runner muerto no se podía reintentar; tras el timeout del job
     la API lo cierra como mark-failed (reserved → uncertain, nunca released) y permite reintentar.
3. CI y QA: `22d77d1`, `ea922e6`, `f5c93f7`, `2e776a1`, `3d4a553`.

## 2. Pruebas ejecutadas (USD 0, sin proveedores reales)

| Módulo | Pruebas | Resultado |
|---|---|---|
| Controles económicos (#198/#201) | `spend-authorization-db.sh` (+ `resume-auth-ref-postgres.sh` con la propuesta de #201) y saldo manual | ✅ RESULT ALL PASS ×3 (job postgres, run 40133009453) |
| T10c A/B (autorización durable exacta) | R02 de #201 | ✅ `PASS R02 A/B rejected` (direct SQL y service_role); la línea PENDING de la suite previa a #201 es esperada |
| Gate de gasto (fallo cerrado, presupuesto, topes, concurrencia) | 15 regresiones D1–D3 + SQL adversarial E1–E8 | ✅ 15/15 regresiones (fallan contra 6ce9fcb) · E1–E8 29/0/0 en BD del repo y 29/0/0 sobre el esquema real |
| Podcast 2.1 / 3.0 | `test:podcast3`, cierre en BD, E2E de navegador casos 1–11, E2E de auditoría F1–F3 | ✅ `test:podcast3` 46/46 · cierre en BD n/n · navegador **183/183 PASS** (casos 1–11, iPhone 13, Pixel 7, escritorio) · auditoría **18/0/0** (F1 corregido) |
| YouTube Long Form / rescate | `test:spend`, `test:editorial`, `test:rescate`, `test:saas` + workflows del PR (fixtures, director worker) | ✅ static (spend, editorial, rescate, saas) · workflows del PR: ver el PR #205 (todas verdes salvo `resume-auth-ref-postgres`, corregido en el commit de este documento) |
| Tipos, unitarias, build | `typecheck`, `test:unit` (unión 267 archivos), `next build` | ✅ job static (typecheck, test:unit, build) |

Runs: integración [40133009453](https://github.com/hanzmo16-png/Atomivid/actions/runs/40133009453) (`3d4a553`, static ✅ postgres ✅ e2e ✅) · esquema de producción (solo lectura) [40132895580](https://github.com/hanzmo16-png/Atomivid/actions/runs/40132895580) (intento 2, ✅) · PR borrador: workflows propios del repo.

## 3. Supabase: historial y esquema real (solo lectura)

Workflow `schema-readonly-pr200` (rama `claude/schema-readonly-pr200`). Cada sentencia en producción corre dentro de
`BEGIN TRANSACTION READ ONLY … ROLLBACK` (el pooler ignora `PGOPTIONS`); la prueba de escritura se rechaza. El volcado
`--schema-only` nunca sale del runner.

**Discrepancias encontradas** (run 40132895580, intento 2, sobre `3d4a553`):

- Producción tiene **dos registros** de migraciones que no coinciden: `supabase_migrations.schema_migrations` (39
  filas: lo aplicado por el panel/MCP de Supabase) y `public._migrations_applied` (45 nombres: lo aplicado por
  `apply-supabase-migration.yml`). Ninguno está completo por sí solo.
- Contra los objetos reales del esquema (tablas, columnas, funciones, índices, políticas, triggers): las **43**
  migraciones del repo con objetos detectables están **aplicadas**; 7 no crean objetos detectables (cambian datos o
  restricciones) y figuran en alguno de los registros; **1 parcial**: `0002_generation.sql` (falta la política «Public read
  access to generated videos», coherente con el endurecimiento `database_security_hardening` aplicado después).
- **17 migraciones con fecha** están solo en `schema_migrations` (p. ej. `20261005143935_provider_supply_controls`,
  `20261020150535_reel_provider_spend_cap`): el workflow del repo las consideraría pendientes y **las volvería a ejecutar**.
  Conciliación preparada (no aplicada): `docs/ops/20261024_register_applied_migrations.sql` (solo registra nombres).
- **21** entradas de `schema_migrations` y **11** de `_migrations_applied` (`0020`–`0030`) **no tienen archivo** en el
  repo (aplicadas desde el panel o renumeradas). El esquema de producción no se puede reconstruir solo desde el repo; por
  eso E1–E8 se ejecutan también sobre una réplica del **esquema real** (`SCHEMA_SQL`).

**Estado de las propuestas (marcadores en las funciones reales, no solo existencia):**
- `20261024000000_spend_authorizations` (#198): **aplicada** en producción (sin registrar).
- `20261024120000_resume_authorization_ref_match` (#201): **no aplicada** (el trigger aún une solo por proyecto).
- `20261024130000_spend_authorization_baseline_fix`: **no aplicada**.
- `20261024140000_podcast_v3_studio` (#200): **no aplicada** (no existen `podcast_studio_*`).
- Réplica del esquema real: aplicar 120000 → 130000 → 140000, re-aplicar 140000, revertir 140000 → 130000 → 120000 y
  re-aplicar: todo PASS. E1–E8 sobre el esquema real + propuestas: **29 PASS / 0 FAIL / 0 FINDING** (run 40132895580).

**Riesgo del mecanismo de aplicación** (`apply-supabase-migration.yml`): solo reconcilia 0001–0019; una migración con
fecha que no esté en `public._migrations_applied` se **ejecuta otra vez** aunque ya esté en el esquema. Por eso: nunca
lanzarlo con «aplicar todas las pendientes»; siempre con `migration_file` explícito (ver §4).

## 4. Procedimiento de lanzamiento (requiere tu autorización en cada paso marcado 🔐)

Precondiciones (sin costo salvo P0, que escribe en producción):
- P0. 🔐 Conciliar los registros: ejecutar `docs/ops/20261024_register_applied_migrations.sql` (solo inserta 18
  nombres en `public._migrations_applied`) y volver a correr `schema-readonly-pr200`. Sin esto, no usar
  `apply-supabase-migration.yml`.
- P1. Grok porta `cdba4bc` a #200 (o autorizas tomar #200 desde esta rama). #199 no necesita reescribirse si #201 se
  fusiona antes: al fusionar #199 después, la base ya trae T10c (la integración lo prueba: R02 A/B rechazado).
- P2. CI verde en los SHA finales de #201, #199 y #200, y este PR borrador verde.
- P3. Conciliar la operación de podcast `RECONCILIATION_REQUIRED` que existe en producción (un episodio no podrá abrir
  autorización hasta conciliarla). No requiere gasto.

Orden:
1. 🔐 **Migraciones de BD compatibles hacia atrás** (el código actual funciona con y sin ellas):
   mover `20261024120000_*.sql` y `20261024130000_*.sql` de `supabase/proposals/` a `supabase/migrations/` en un commit y
   lanzar `apply-supabase-migration.yml` **una vez por archivo** con `migration_file=<nombre>`. Verificar con
   `schema-readonly-pr200` (marcadores 120000/130000 = `t`).
2. 🔐 **Merge #201** → Vercel despliega producción automáticamente. Esperar «Ready» y hacer las pruebas de §5 (bloque A).
3. 🔐 **Merge #199** → despliegue → §5 (A + B).
4. 🔐 **Merge #200** (con F1/E6/F3) → despliegue → §5 (A + C). Con `PODCAST_V3_ENABLED` todavía apagado el estudio
   responde 503 controlado; Podcast 2.1 sigue igual.
5. 🔐 **Migración 140000** (estudio) igual que en el paso 1, luego `schema-readonly-pr200` (marcador 140000 = `t`).
6. 🔐 **Activar** `PODCAST_V3_ENABLED=1` solo para tu cuenta/entorno, y empezar las pruebas reales de §7.

## 5. Pruebas obligatorias después de cada despliegue (USD 0)

- A. Inicio, login, panel e historial cargan en el Samsung y en escritorio; `GET /api/podcast` y la lista Long Form
  responden 200; el workflow `schema-readonly-pr200` termina verde (sin escrituras).
- B. Long Form: abrir un trabajo existente, ver estado y presupuesto; la recuperación muestra «requiere autorización»
  si el presupuesto no coincide (T10c) y no reencola nada.
- C. Podcast: crear un episodio sin producir; pedir video con presupuesto insuficiente → 402 y **ninguna** autorización
  nueva en `pi_spend_authorizations` (F1); subir el presupuesto → se acepta. Estudio con el interruptor apagado → 503.

## 6. Recuperación y rollback

- Código: Vercel → Deployments → el despliegue anterior → «Promote to Production» (instantáneo), o `git revert -m 1`
  del merge y push. Orden inverso: #200 → #199 → #201.
- Interruptores: apagar `PODCAST_V3_ENABLED` detiene el estudio sin tocar datos.
- BD: los rollbacks están probados en la réplica del esquema real, en orden 140000 → 130000 → 120000
  (`supabase/proposals/*.rollback.sql`). Antes de revertir 140000: no debe haber operaciones `reserved`/`uncertain`
  del estudio sin conciliar.
- Cargo incierto: nunca reintentar a ciegas; la app bloquea (409) hasta conciliar con el proveedor.

## 7. Bloqueos pendientes

- **#200 · F1 (P1)** — corregido aquí (`cdba4bc`); falta que esté en la rama de #200 (Grok) o tu autorización para
  fusionar #200 desde esta integración.
- **Registros de migraciones** — conciliación P0 sin aplicar (requiere tu autorización; escribe en producción).
- **Propuestas 120000/130000/140000** — no aplicadas en producción; probadas en la réplica del esquema real.
- **Datos de producción** — 1 operación de podcast `RECONCILIATION_REQUIRED` y 2 `RESERVED` por conciliar antes de
  pruebas reales de podcast.
- **Valeria** — el piloto ZEITGEIST necesita el `avatar_id` único del maestro (Grok, subida a HeyGen con autorización).
- **Deriva repo ↔ producción** — 32 migraciones registradas sin archivo; mitigado con las pruebas sobre el esquema real.
- Ninguno de estos bloqueos requiere gasto; todos requieren tu autorización o el trabajo de Grok.

## 8. Checklist desde tu Samsung

1. Abrir atomicvid.app con sesión iniciada; panel sin errores; la barra de navegación no se corta.
2. Long Form: crear una solicitud de 10 min con presupuesto USD 12 → ver guion → confirmar presupuesto → ver progreso
   (puedes cerrar la app) → reproducir y descargar el MP4. Recargar en cada paso: el estado no se pierde.
3. Podcast 2.1: episodio corto con tu voz → estimación → presupuesto y límite por ejecución → producir → escuchar/descargar.
4. Pedir dos veces seguidas lo mismo (doble toque): solo una producción y un solo cargo.
5. Cortar la red a mitad: al volver, el estado es «en cola/produciendo» o «interrumpido, sin doble cobro», nunca «listo» falso.
6. Revisar en Facturación/Command Center que el gasto mostrado coincide con el estimado y no supera el tope.

## 9. Presupuesto máximo estimado de la primera prueba real (no autorizado)

| Prueba | Estimado | Tope sugerido | Base |
|---|---|---|---|
| Primer podcast: piloto ZEITGEIST V3.1 (45 s, Hans + Valeria, maestro de Valeria) | ≈ USD 2,56 | **USD 4** | plan V3.1 |
| Alternativa más barata: Podcast 2.1/3.0 narración ~10 min | ≈ USD 1,1–1,7 | USD 3 | `docs/podcast-3-0/README.md` |
| Primer video YouTube Long Form ~10 min (guion + voz + imágenes Recraft) | ≈ USD 5–7 | **USD 12** | `LONG_FORM_MAX_TOTAL_USD` |
| **Total primera ronda** | ≈ USD 8–10 | **USD 16** | |
