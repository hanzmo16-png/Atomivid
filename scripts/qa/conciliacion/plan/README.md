# Plan de conciliación offline (T-20261025-0112-chatgpt-03)

USD 0. Genera **un artefacto de revisión**, no una ejecución. Sin red, sin base de datos y sin SQL de salida. Los modos `--emit-sql`, `--apply`, `--sql` y `--execute` se rechazan (código 2).

```
python3 -I plan.py build      --snapshot S.json [--evidence E.json] [--now ISO] --out DIR   # plantilla DIR/plan.json + DIR/review.md
python3 -I plan.py verify     --plan DIR/plan.json --snapshot S.json [--evidence E.json]     # 0 solo si es idéntico
python3 -I plan.py map        --plan DIR/plan.json --snapshot S.json [--evidence E.json] --keys K.txt --out FUERA_DEL_REPO
python3 -I plan.py verify-map --mapped M.json --plan DIR/plan.json --snapshot S.json [--evidence E.json] --keys K.txt
```

## Plantilla (seudónimos) → plan mapeado (claves reales) → A-3

1. **`build` produce una PLANTILLA** con `key_space: "pseudonym"`, `executable: false` y `consumable_by_apply: false`.
   - Su `template_sha256` es la fórmula de la herramienta calculada sobre el **seudónimo**. **No** es el hash de la operación real.
   - La herramienta rechaza una decisión de plantilla, porque el seudónimo no es una clave del ledger ("operation not found").
2. **`map`** se ejecuta solo en un entorno autorizado, con un archivo local de claves reales (una por línea; nunca se commitea ni se sube):
   - comprueba que la plantilla coincide con su snapshot y su evidencia;
   - verifica que `k-md5(clave) == op` sea uno a uno y completo;
   - recalcula cada decisión sobre la clave real (`decision_sha256`, byte a byte el de la herramienta);
   - emite un plan **nuevo** (`atomivid.reconcile-plan-mapped/v1`, `key_space: "real"`, `a3_review_required: true`, veredicto `PENDING_A3_REVIEW`) con un plan_sha256 nuevo ligado a `template_plan_sha256` y `keys_sha256`;
   - **se niega a escribirlo dentro del repositorio**.
3. **Fallos que rechaza `map`** (cerrado, sin escribir nada):
   - una clave de más, de menos, duplicada o mal formada;
   - un seudónimo pasado como clave;
   - una plantilla alterada.
4. **El plan mapeado sigue sin ser ejecutable.** Requiere su propia revisión **A-3** y un paso de aplicación aparte, autorizado explícitamente.

**Códigos de salida:**

| Código | Significado |
|---|---|
| 0 | READY |
| 3 | NOT_READY: hay operaciones CANDIDATE, MANUAL o BLOCKED; no se aplica nada |
| 1 | entrada inválida o plan no coincidente; no se escribe nada |
| 2 | uso incorrecto o modo de aplicación pedido |

## Entrada mínima y redactada

### `atomivid.reconcile-snapshot/v1`

- **Campos del snapshot, exactamente estos:** `format`, `source`, `taken_at`, `complete`, `totals`, `operations`.
  - `source` vale `synthetic-fixture` o `redacted-readonly`.
  - `complete` tiene que ser `true`.
- **Campos de cada operación, exactamente estos:** `op`, `status`, `updated_at`, `provider`, `method`, `reserved_usd`, `committed_usd`, `has_provider_job`, `has_result_ref`, `supply_reconciled`.
- **`op` es un seudónimo de un solo sentido:** `k-` + md5 de la clave. Es la misma redacción que ya usa `ci.sh`. Se rechaza cualquier otra forma, por ejemplo una clave `op_…` o un UUID.
- **No existen campos para:**
  - proyecto o usuario;
  - prompt, URL o ruta;
  - ID de trabajo del proveedor o referencia de resultado (solo se guardan los booleanos `has_*`).
- **Formato de valores:**
  - importes: cadenas decimales de hasta 4 decimales; los números JSON se rechazan;
  - fechas: UTC con `Z`.
  - Además, se rechazan las claves JSON duplicadas.

### `atomivid.reconcile-evidence/v1`

- Cada ítem lleva `op`, `outcome`, `evidence` y, opcionalmente, `actual_usd` y `allow_over_reserved`.
- `evidence` es una referencia opaca de 3 a 200 caracteres ASCII imprimibles. Se rechaza si parece una URL, un correo, un UUID, una ruta o una clave.

**Nunca se suben a Git ni a Drive snapshots reales.** Los fixtures de este directorio son sintéticos: seudónimos de nombres inventados, con la misma composición agregada que las 41 operaciones reales, que ya está publicada.

## Reglas (fail-closed)

### Entrada inválida: no se escribe nada

- operación duplicada;
- estado final (`COMMITTED` o `REFUNDED`) o desconocido;
- snapshot parcial;
- `totals` o `by_status` que no cuadran;
- importe negativo o con más de 4 decimales;
- campo extra;
- `updated_at` posterior al snapshot;
- fila abierta con `supply_reconciled`;
- evidencia de una operación ausente o repetida.

### Por operación

| Caso | Estado |
|---|---|
| < 24 h desde `updated_at` (respecto a `taken_at` y a `--now`) | BLOCKED |
| RESERVED sin datos del proveedor | READY `cancelled_before_submission` |
| RESERVED con datos del proveedor | MANUAL |
| RESERVED con evidencia de otro resultado | BLOCKED |
| SUBMITTED interno sin evidencia | CANDIDATE `not_charged`: necesita un ítem explícito para ser READY |
| SUBMITTED, PJR o RR sin evidencia | MANUAL; nunca se elige en silencio |
| `not_charged` con importe | BLOCKED |
| `charged` sin importe, o por encima de lo reservado sin `allow_over_reserved` | BLOCKED |
| `assumed_charged` con importe | BLOCKED |
| `cancelled_before_submission` en una fila que salió del proceso | BLOCKED |

### Hash

- Cada decisión READY lleva un `decision_id` determinista: `rp1-` + 24 hex, calculados a partir del sha256 del snapshot y de la operación.
- La fórmula es la de `pi_reconcile_open_operation`: sha256 de `jsonb_build_array(id, key, status, updated_at UTC µs, outcome, evidence, importe numeric(12,4), override)::text`.
  - En la plantilla se calcula con el seudónimo como `key` (`template_sha256`).
  - En el plan mapeado se calcula con la clave real (`decision_sha256`).
- `plan_sha256` cubre el plan entero.
- Cambiar una operación, una precondición, el resultado, la evidencia, el importe o el override invalida la decisión y el plan.

## Pruebas

- **`plan_test.py`:** 17 pruebas unitarias. Cubren:
  - el fixture 32/8/1;
  - la separación de los 5 resultados;
  - el replay byte a byte;
  - la fórmula del hash y la sensibilidad de cada campo;
  - la invalidación por fila, evidencia o plan alterados;
  - planes concurrentes contradictorios;
  - 17 casos estructurales y 7 de evidencia;
  - los rechazos por operación;
  - las filas frescas;
  - la ausencia de SQL y de identificadores no redactados;
  - el mapeo: el hash con seudónimo difiere del hash con clave real; los mapeos incorrectos se rechazan sin escribir nada; la plantilla o el plan mapeado alterados se rechazan; nunca se escribe dentro del repositorio.
- **`pg_check.sh`:** PostgreSQL desechable con el DDL real del ledger, las migraciones de supply y la herramienta propuesta de su propio árbol (verificada contra `docs/ops/conciliacion/SHA256SUMS`). En este árbol es `b3dd1c05…`, la de #209 @ `5ee19a6` (aprobada). El ledger tiene las claves "reales" sintéticas; la plantilla solo vio `k-md5(clave)`. Comprueba que:
  - la herramienta rechaza una decisión de plantilla ("operation not found");
  - la herramienta acepta las 41 decisiones del plan **mapeado**;
  - el hash que devuelve la herramienta coincide con `decision_sha256` en 41/41 y con `template_sha256` en 0/41;
  - `pi_reconciliation_log` guarda el mismo `decision_sha256` del plan mapeado;
  - los estados finales y el delta de `pi_supply_spend` son exactos;
  - el replay es idempotente;
  - un plan contradictorio se rechaza;
  - un CAS obsoleto se rechaza.

## Límites

- **No obtiene las claves reales.** Obtenerlas exige una lectura autorizada de producción, fuera de alcance. `map` solo verifica y usa un archivo local de claves que alguien con esa autorización aporte. La plantilla con seudónimos nunca es ejecutable.
- **No obtiene ni valida evidencia de proveedores.** La evidencia es una declaración del operador que alguien tiene que revisar.
- **No declara lista la conciliación productiva.** Aplicar cualquier decisión requiere:
  - autorización explícita del propietario;
  - la herramienta instalada (A-1);
  - evidencia autorizada (A-2);
  - un snapshot nuevo (CAS) y la aprobación del plan (A-3).
