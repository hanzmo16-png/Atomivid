# #207 sustituye a #200: auditoría final y plan de integración (2026-10-25)

Decisión de Hans: **opción B**, #207 sustituye a #200. Gasto: USD 0. No se fusionó, desplegó ni migró nada, y no se tocó la rama de Grok.

## 1. HEAD verificados (2026-10-25 ~01:20 UTC)

No existe `main`. La rama por defecto y de producción es `claude/atomivid-mvp-setup-0079jv` @ `762714e2ff3d19a62d2c705b7487ff9a364677e7`.

| PR | Rama | HEAD |
|---|---|---|
| #201 | grok/p0-auth-ref-trigger | `9944360b5a32130d46811ea9d57f569b1e9031f5` |
| #199 | claude/documental-cinematografico | `49594f1e989d1c6f8c21bae4e650075ea4532ed4` |
| #200 | grok/podcast-audiovisual-cierre | `1794224502c21f2dfdef6a38b74fdff34a34588a` (congelado) |
| #205 | claude/integracion-201-199-200 | `07ee87b80497ff50e6a4c60db15c42cc12d3440c` (verificación; no se fusiona) |
| #207 | claude/pr200-sobre-201-199 | `3b781dae73ba87e9c55d6f7bfc0ce97c3c4f665d` |
| #208 | claude/pr207-f1-en-ci | `d8b203d665e62602cec5cb72620f03b5630edd12` (= #207 + 1 línea) |

## 2. Contenido de #207 (verificado archivo por archivo)

- **Archivos de un solo PR:** los 86 archivos (de 93) que cambian respecto a la base y que solo toca uno de los PRs son byte a byte iguales a su origen (#199 o #200). No hay ningún archivo que no venga de un PR.
- **Archivos compartidos:**
  - las 5 piezas de #201 que también están en #200 (propuesta 120000 + rollback + diagnóstico, script y workflow T10c) son idénticas en #201, #199, #200 y #207;
  - `scripts/qa/spend-authorization-db.sh` es la resolución ya hecha en #199, que conserva la línea de #201;
  - `package.json`: `test:unit` y `test:editorial` son la unión exacta de ambos lados; solo se añaden los scripts `podcast3:demo` y `test:podcast3`.
- **Dependencias:** idénticas a la base. El `package-lock.json` es el mismo blob en la base, #199, #200 y #207.
- **Migraciones:** `supabase/migrations/` no cambia; las tres propuestas siguen en `supabase/proposals/`.
- **Permisos y autorización de gasto:** las funciones afectadas en producción solo tienen `{postgres, service_role}`. Los ensayos lo cubren (run 40152372340, réplica con datos `pi_*` reales):
  - las migraciones no amplían ningún privilegio;
  - 0 filas `pi_*` cambiadas;
  - F1 validado antes de abrir la autorización;
  - SQL adversarial E1–E8 sobre `3b781da`: 29/0/0.
- **Variables de entorno nuevas:** todas opcionales y apagadas por defecto (`PODCAST_V3_ENABLED`, `PODCAST_V3_LLM`, `PODCAST_V3_PROVIDERS`, `FFPROBE_BIN`). El proveedor simulado `mock` está bloqueado con `ATOMIVID_RUNTIME=production`. No hay que configurar nada para O4, O5 ni O7.
- **Objetos de BD nuevos que usa el código:** solo `podcast_studio_*` (los crea 140000).
  - Todo uso está detrás de `PODCAST_V3_ENABLED`: la API responde 503 y el trabajador `STUDIO_DISABLED`, sin cargos.
  - El insert del estudio tolera que falte la tabla.
  - Por eso O7 antes de O8 es seguro.

## 3. CI sobre el SHA exacto

**#207 @ `3b781da`:**
- 7/7 workflows SUCCESS (run ids `40147881862`, `…871`, `…840`, `…833`, `…854`, `…864`, `…845`).
- Vercel preview Ready.
- **E2E del trabajador del Director** (`director-worker-e2e`, que solo se lanza a mano y nunca había corrido sobre este árbol): run `40152142180` ✅.

**#208 @ `d8b203d`:** 7/7 SUCCESS (`40152272431`, `…446`, `…432`, `…489`, `…426`, `…417`, `…508`).

**Local sobre `3b781da`:**

| Suite | Resultado |
|---|---|
| typecheck | OK |
| unit | 2300/0 (2305 en `d8b203d`) |
| spend | 417/0 |
| editorial | 221/0 |
| saas | 421/0 |
| podcast3 | 48/0 |
| simulator | 24/0 |
| rescate | 39/0 |
| Avatar pipeline | 28/0 |
| F1 + auditoría | 20/0 |
| F3 | 10/10 |
| Reels: `reel-retry` / `reel-retry-ui` / `reel-direction` | 5/3/5 |
| Long Form: budget envelope / script budget | 5/2 |
| `spend-authorization-open` | 9 |
| v2 integration | 7 |

Lint: 0 errores; 2 avisos nuevos en `src/lib/podcast/v3/*` (variable sin usar, expresión), sin efecto y no corregidos para no ampliar el alcance.

## 4. Hallazgos de la auditoría

1. **Corregido aparte (#208):** la prueba de regresión de F1 no la ejecutaba ningún script ni workflow que quede en la base. #208 la añade a `test:unit` (1 línea).
2. **Método de merge:** **solo «Create a merge commit»** funciona en O4, O5 y O7.
   - Si #201 y #199 se fusionan con squash, O5 da conflicto (`spend-authorization-db.sh`).
   - Con rebase, la reproducción del historial falla.
   - Con merge commit:
     - tras O4, el árbol = #201;
     - tras O5, el árbol = #199;
     - tras O7, el árbol = #207, o = `d8b203d` si se avanza.
   - **Cada estado intermedio de producción es exactamente un SHA ya verde en CI.**
3. **El trabajador de podcast no pasa por Vercel:**
   - `podcast-video.yml` tiene cron cada 15 min y secretos de ElevenLabs, HeyGen y Pexels. Al fusionar, el siguiente tick usa el código nuevo, antes de que Vercel termine de desplegar.
   - La guarda del cron solo actúa con episodios `scheduled` vencidos; hoy hay **0**.
   - Un **rollback con «Promote» de Vercel NO revierte los trabajadores de GitHub Actions**. Revertir O7 exige `git revert -m 1`.
4. **PRs que GitHub marcará como fusionados automáticamente** (su HEAD queda contenido):
   - en O4: #201;
   - en O5: #199 y #195;
   - en O7: #200, #196 y #192 (y #207).
   - **Por eso no hay que cerrar #200:** al fusionar #207 quedará «Merged» con su historial y sus revisiones intactos.
   - #189 (grok/podcast-3-0, «reemplazado por #192») no está contenido y quedará obsoleto; se puede cerrar después de O7 si Hans lo decide.
5. **Grok y ZEITGEIST:**
   - #206 solo cambia `.github/workflows/zeitgeist-lote-a.yml`: 0 archivos en común con #207. Se fusiona limpio encima del estado final.
   - Las ramas activas de Grok no se ven afectadas; `grok/podcast-audiovisual-cierre` no se modificó.
6. **Producción ahora (agregados de solo lectura):**
   - 0 episodios programados o en curso; 0 trabajos documentales en cola.
   - Ya existían antes de este cierre: 8 operaciones `RECONCILIATION_REQUIRED`, 32 `RESERVED` y 1 `SUBMITTED` en total. Las migraciones no las tocan; hay que conciliarlas antes de las pruebas reales.

## 5. Plan de integración (cada 🔐 requiere autorización explícita y separada)

| # | Operación | Depende de | Riesgo | Verificación (USD 0) | Reversión | GO/NO-GO |
|---|---|---|---|---|---|---|
| P0 | Decidir si #207 avanza a `d8b203d` (incluir la prueba F1) | — | Ninguno en ejecución; requiere una auditoría del delta de 1 línea | CI 7/7 ya verde en `d8b203d` | Volver a `3b781da` | **GO** (recomendado) |
| O1 🔐 | Conciliación A: 18 nombres en `_migrations_applied` (sha256 `577cd97b…`) | — | Escribe solo el registro | `schema-readonly`: 51/51 registradas | `A_…rollback.sql` | **GO** (confirmado de nuevo en run 40152372340) |
| O2 🔐 | Migración 120000 (`migration_file`) | O1 recomendado | Bajo: 0 trabajos afectados | Marcador `t` | Rollback 120000 + quitar del registro | **GO** |
| O3 🔐 | Migración 130000 | O2 | Bajo: 1 autorización, uso idéntico | Marcador `t` | Rollback 130000 + registro | **GO** |
| O4 🔐 | Merge **#201** @ `9944360` con merge commit | O2 (para que la BD ya cierre T10c) | Bajo; despliegue = árbol #201 | Bloque A: inicio, login, panel, `GET /api/podcast`, Long Form 200 | `git revert -m 1` (no solo Promote) | **GO** |
| O5 🔐 | Merge **#199** @ `49594f1` con merge commit | O4 | Medio (Long Form nuevo); 0 trabajos en curso | A + B: un trabajo Long Form muestra estado y presupuesto; T10c responde «requiere autorización» si la referencia no coincide | `git revert -m 1` | **GO** |
| O7 🔐 | Merge **#207** (`3b781da` o `d8b203d`) con merge commit | O5; P0 | Medio: trabajador de podcast nuevo en el siguiente tick | Ver «Requisitos de O7» | `git revert -m 1` (revierte app **y** trabajador) | **GO técnico**; no está terminado hasta cumplir sus requisitos |
| O8 🔐 | Migración 140000 | O7 | Bajo: el estudio sigue apagado | Marcador `t`; `pi_supply_state` igual | Rollback 140000 (0 operaciones `reserved`/`uncertain`) | **GO** |
| O9 🔐 | `PODCAST_V3_ENABLED` solo para Hans | O8 + conciliar las operaciones abiertas | — | Primera prueba real con tope | Apagar el flag | Fuera de alcance |

### Requisitos de O7 (sin todos ellos no se declara terminado)

1. O4 y O5 hechos **con merge commit**; el HEAD de #207 sin cambios desde su CI (7/7 en el mismo SHA).
2. `PODCAST_V3_ENABLED` **sin definir** en Vercel (Production) y en las variables del repositorio.
3. Ventana sin trabajo de podcast: 0 episodios `scheduled` vencidos, `queued` o `running` (revisar con `schema-readonly` justo antes).
4. **Verificación en producción real** tras el despliegue (Vercel «Ready» y siguiente tick del cron):
   - pedir video con presupuesto insuficiente → 402 y **0** filas nuevas en `pi_spend_authorizations` (F1);
   - `/api/podcast/v3` → 503;
   - el tick de `podcast-video.yml` termina con `go=false`;
   - Podcast 2.1 y Long Form cargan.
5. #200, #196 y #192 aparecen como «Merged». Si alguno no, investigar antes de seguir.

**Pruebas automatizadas ≠ validación en producción.** Todo lo anterior se probó con proveedores simulados y en réplicas desechables. La verificación del punto 4 es la primera evidencia real, y aún no existe.

## 6. Propuesta de menor riesgo

1. P0: avanzar #207 a `d8b203d` tras auditar el delta.
2. O1 → O2 → O3: solo base de datos, sin código.
3. O4 → O5 → O7 en una sola ventana sin trabajo en curso, con merge commit y la verificación de cada paso antes del siguiente.
4. O8.

Alternativa de una sola fusión: #207 contiene #201 y #199, así que fusionar solo #207 también es limpio. Se pierden dos puntos de verificación intermedios, por eso no se recomienda.
