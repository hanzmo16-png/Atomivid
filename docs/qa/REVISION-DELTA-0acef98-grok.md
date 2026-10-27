# Revisión del delta `67fcd7e..0acef98` (PR #228) — Grok

Auditoría independiente, solo lectura del delta, más un arreglo mínimo de contención de ruta. Presupuesto USD 0. No se fusionó, no se desplegó, no se migró ninguna base remota, no se tocaron feature flags, secretos ni ramas `claude/*`. Proveedores simulados.

## SHAs

| Papel | SHA | Qué es |
| --- | --- | --- |
| Base ya auditada (fuera de alcance, salvo como padre del diff) | `67fcd7e44af755338cc8afaf52abb49e470a65ad` | Cierre previo del estudio |
| Delta pedido | `0acef98aa8da6f510fa0901121a9c34a8bb061ce` | Corrección de Claude: el guard ya no acepta `failed`; «sin arranque» = ningún inicio posterior a `authorized_at` |
| Incluido en ese delta | `b1656c23eadae846e3cc1f39aec3065956cc83a3` | Merge solo del código de #229 @ `7e67dd15e210f11598938e3b0d60d10c52b3eff2` (reproducir/descargar y re-despacho) |
| HEAD real de `claude/candidato-podcast-studio` al revisar | `69e44aae6c8d4bac5f54ba16ee80c6d1e5b1e3ca` | El worker identifica al dueño por id o por SHA-256 del correo confirmado y falla cerrado |

El veredicto principal es sobre `0acef98`. La sección final dice si `0acef98..69e44aa` cambia alguno.

## Qué se ejecutó y qué solo se leyó

Ejecutado (proveedores simulados o lógica pura; Postgres 16.15 local, socket unix, `listen_addresses` vacío, directorio temporal, apagado al terminar):

- `node --import tsx --test --test-concurrency=1 src/lib/podcast/v3/v3.test.ts src/app/dashboard/podcast/StudioEpisodeList.render.test.tsx` → 31/31 PASS (incluye las pruebas nuevas de descarga, de `failed` sin monto y del botón de re-despacho).
- `node --import tsx --test --test-concurrency=1 src/lib/podcast/v3/studio.test.ts src/lib/podcast/v3/cierre.test.ts` → 22/22 PASS.
- `node --import tsx --test --test-name-pattern "entrega solo el audio" src/lib/podcast/v3/render.test.ts` → 1/1 PASS en 41.7 s (`r.mp4 === null`, 0 llamadas de imagen/avatar/recreación, 3 de voz simulada).
- `PGHOST=/tmp/atomivid-revision-pg/run PGPORT=55921 DB=atomivid_cierre npx tsx scripts/qa/revision-delta-guard.ts` contra el esquema real (migraciones del repo + propuestas #198 y `20261024140000_podcast_v3_studio`) → 18/18 PASS. Repetido con el script ya en el árbol.
- `PGHOST=… PGPORT=55921 DB=atomivid_cierre OUT_DIR=/tmp/podcast-cierre-out npx tsx scripts/qa/podcast-cierre-e2e.ts` → **81/81 PASS**, exit 0. Incluye el caso nuevo del delta: episodio `failed` sin reautorizar → `DuplicateRunError` y 0 llamadas de pago, en los tres modos.
- `runStudioJob` con el cliente de servicio sustituido (sin red, sin ffmpeg en el perdedor) → 2/2 PASS.
- Comparación ejecutada del predicado viejo (`startsWith`) frente a `ownStudioAsset`, y `git show 0acef98` / `HEAD` de la línea «Volver a pedir el inicio».
- `paidOnce` sobre una fila `settled` con `result: ""` (ver observación; no es un arreglo).

Solo leído: `authorizeAction`, `episodeAction` (antes del arreglo), `supabaseRunGuard`, `studioRunErrorFailsEpisode`, `runStudioJob`, `paidOnce`, el trigger `podcast_studio_operations_cap`, `scripts/podcast-video-mark-failed.ts` (rama `JOB_KIND=studio`), `podcast-video.yml` (concurrencia y el hash), y el diff `0acef98..69e44aa`. No se abrió el navegador: el cambio de comportamiento es de la función de firma y de pruebas de nodo, no de una pantalla nueva.

## Veredicto

| Punto | En `0acef98` | En HEAD `69e44aa` (lo que fusionaría #228) | Tras este PR |
| --- | --- | --- | --- |
| 1. Reproducir / descargar | **DEFECTO, severidad baja** (contención de ruta). Otra cuenta sigue en 404. | Igual: `episodeAction` no cambió después de `0acef98` | **OK** |
| 2. Reintento sin otro cargo | API **OK**. Botón del asistente **DEFECTO, severidad media** | **OK** (el botón ya no envía monto; lo cierra `16b47781`) | **OK** |
| 3. Concurrencia del worker | **OK** | **OK** (el guard y el predicado de duplicado no cambian) | **OK** |

### 1. Reproducir y descargar

Positivo, ejecutado: dueño + `ready` + `u1/podcast-studio/<id>/episodio.mp4` (y el audio, también anidado en `paid/`) → URL firmada, y el cuerpo no incluye `spec`. La lista pinta reproductor y enlaces solo si la API devuelve URL. El E2E firmó el MP4 del dueño y el sha coincidió con el render, en los tres modos.

Negativo, ejecutado:

- Otra cuenta → 404, `sign` no se llama, el cuerpo no contiene la ruta.
- Otro episodio, ruta de otro usuario, `draft` / `authorized` / `generating` / `failed` → URL nula y `sign` no se llama.
- Solo audio de verdad: `runEpisode` devuelve `mp4: null` y no llama a imagen, avatar ni recreación. El worker (`const video = r.mp4 ? upload : null`) guarda `video_path` nulo. La lista no pinta MP4 si `videoUrl` es nulo.

Defecto en `0acef98` (y todavía en `69e44aa` antes de este PR): `signOwn` era `p.startsWith(prefijo)`. Estas rutas empiezan por el prefijo y **se firmaban**:

- `u1/podcast-studio/<id>/../../u2/secreto.mp4` → `startsWith` true, `ownStudioAsset` false
- `u1/podcast-studio/<id>/%2e%2e/secreto.mp4` → igual

Además, un episodio con `spec.output === "audio"` y un `video_path` relleno obtenía URL de MP4, porque la función no miraba el modo. El worker no escribe ese `video_path`; el hueco estaba en la puerta de descarga.

Severidad baja: `anon` y `authenticated` no pueden escribir la tabla (el E2E lo confirma: B no modifica filas de A). Quien escribe `video_path` es el service role, y el worker escribe rutas planas dentro de la carpeta. No es un bypass de otra cuenta. Sí incumple «ruta ajena → ninguna URL» y «solo audio → ningún MP4» si la fila viene incoherente. El arreglo está en `ownStudioAsset` / `episodeAction`: se rechazan `..`, `.`, segmento vacío, barra invertida, NUL y cualquier codificación porcentual; si el spec parsea como `output: "audio"`, no hay URL de video.

### 2. Reintento sin un cargo nuevo

API en `0acef98`, ejecutada (unidad y Postgres):

- `authorized` sin `run_started_at`, o con un inicio **anterior** a `authorized_at`, y `confirm: true` (aunque el cuerpo traiga `authorizedUsd: 50`) → 200, `authorize` no se llama, `authorized_usd` queda `2.0000`.
- Inicio **posterior** a `authorized_at` → 409, `authorize` no se llama.
- `failed` + `confirm: true` sin monto → 402, ni `authorize` ni `dispatch`.
- `failed` + `confirm: true` + monto → 200 y sí llama a `authorize`. Es el camino explícito de «Reintentar», no el de re-despacho.
- `ready` con monto → 409, sin `authorize`.
- Clave `settled` con resultado → la segunda pasada reutiliza, 0 llamadas nuevas (unidad y trigger real).
- Clave `uncertain` → `UncertainChargeError`, 0 llamadas.
- Reserva de USD 5 con `authorized_usd` 2 → la BD rechaza `STUDIO_CAP: authorization exceeded (used 0.7000, requested 5.0000, cap 2.0000)`, 0 filas y 0 llamadas. El libro de la app también rechaza antes si no cabe en el presupuesto.
- E2E, tres modos: `failed` sin reautorizar → `DuplicateRunError` y 0 llamadas; tras `failed → authorized` se reutiliza lo liquidado; el tercer pase completo hace 0 llamadas y el libro no cambia; el liquidado queda por debajo de lo autorizado.

Defecto de interfaz en `0acef98` (no en la API): el botón «Volver a pedir el inicio (no se cobra otra vez)» del asistente enviaba `{ confirm: true, authorizedUsd: d.budgetUsd }`. Si el episodio ya había pasado a `failed`, ese cuerpo es una reautorización: `authorize` corre y se despacha, sin el paso «Reintentar» que exige volver a marcar el costo. La lista de la cuenta nunca tuvo ese fallo: siempre envió `{ confirm: true }` y el botón solo aparece en `authorized`.

`16b47781` deja el botón del asistente en `{ confirm: true }`. Con eso, un `failed` cae en el 402 de arriba y no se reautoriza. La prueba nueva lee esa línea y falla si vuelve a aparecer `authorizedUsd`.

### 3. Concurrencia

Ejecutado sobre la tabla real (`status` text con CHECK, `run_token` uuid, `run_started_at` timestamptz), llamando a `supabaseRunGuard`, no al `pgGuard` simplificado del E2E:

- Dos conexiones, las dos leen `authorized` antes de escribir → exactamente una gana (`w1=true`, `w2=false`). El `release` del perdedor no borra el `run_token` del ganador (`aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa` se mantiene).
- Un tercer acquire sobre ese `generating` reciente pierde y no cambia el token.
- `failed` y `ready` (aunque el inicio tenga 3 h) → `false` y la fila no cambia.
- `generating` con inicio de más de 45 min → el guard lo recupera y refresca `run_started_at`.
- SQL de mark-failed (`status='generating'`) cierra un `generating` y no toca un `ready`. Después, `failed → authorized` (mismo `UPDATE` que la ruta, dueño y estados `draft|failed`) y el guard sí lo toma. Un acquire siguiente pierde.
- `runStudioJob` con fila `failed`, `ready` o `generating` (inicio de 5 h) → `STUDIO_NOT_AUTHORIZED`, 0 updates, no llega a proveedores.
- El perdedor de la carrera (el `UPDATE` del guard devuelve 0 filas) → `STUDIO_DUPLICATE`, el estado sigue `authorized`, no hay update a `failed` ni a `ready`.

El runner perdido es recuperable, y el camino de producción no lo regenera solo: el worker ni entra al guard si el estado no es `authorized` (así un re-despacho crudo no retoma un `generating` viejo ni uno vivo). Cuando el job muere, `podcast-video-mark-failed.ts` (leído) pasa `generating → failed` y las reservas a `uncertain`; el dueño reautoriza; el guard toma `authorized`. Eso coincide con «`failed` exige otra autorización». La rama de 45 min del guard sigue viva y se probó en Postgres; `runStudioJob` no la usa. No es un segundo ganador: es un no-op seguro.

El E2E, con su `pgGuard` de un solo `UPDATE … where status='authorized'`, también vio una sola ejecución y `DuplicateRunError` en la otra.

## Comandos y resultados

Unidad (desde la raíz del repo):

```text
node --import tsx --test --test-concurrency=1 \
  src/lib/podcast/v3/v3.test.ts \
  src/app/dashboard/podcast/StudioEpisodeList.render.test.tsx
# tests 31, pass 31, fail 0

node --import tsx --test --test-concurrency=1 \
  src/lib/podcast/v3/studio.test.ts src/lib/podcast/v3/cierre.test.ts
# tests 22, pass 22, fail 0

node --import tsx --test --test-name-pattern "entrega solo el audio" \
  src/lib/podcast/v3/render.test.ts
# ok 1 — modo A solo audio: entrega solo el audio — sin imágenes, sin planos, sin MP4
# duration_ms: 41694.848406
```

Predicado de `0acef98` frente al arreglo (`npx tsx -e` importando `ownStudioAsset`):

```text
episodio.mp4 dentro de la carpeta     startsWith=true   ownStudioAsset=true
.../../../u2/secreto.mp4              startsWith=true   ownStudioAsset=false
.../%2e%2e/secreto.mp4                startsWith=true   ownStudioAsset=false
carpeta de otro usuario               startsWith=false  ownStudioAsset=false
```

Botón en `0acef98` (leído con `git show` y contrastado con HEAD):

```text
0acef98  api(..., { confirm: true, authorizedUsd: d.budgetUsd })
69e44aa  api(..., { confirm: true })
```

Postgres desechable (mismo orden que `scripts/qa/podcast-cierre-db.sh`: stubs, migraciones, propuestas `20261024000000`, `20261024120000`, `20261024130000`, `20261024140000`; dos migraciones solo-locales omitidas, las que el script ya marca como conocidas). Luego:

```text
PGHOST=/tmp/atomivid-revision-pg/run PGPORT=55921 DB=atomivid_cierre \
  npx tsx scripts/qa/revision-delta-guard.ts
# RESULTADO 18/18 PASS
```

Columnas comprobadas: `authorized_at` y `run_started_at` timestamptz, `authorized_usd` numeric, `run_token` uuid, `status` text. CHECK presentes, entre ellos `podcast_studio_episodes_status_check` y `podcast_studio_episodes_authorized_max`.

E2E de cierre sobre ese mismo esquema (proveedores simulados, ffmpeg real, salida en `/tmp/podcast-cierre-out`):

```text
PGHOST=/tmp/atomivid-revision-pg/run PGPORT=55921 DB=atomivid_cierre \
  OUT_DIR=/tmp/podcast-cierre-out npx tsx scripts/qa/podcast-cierre-e2e.ts
# RESULTADO 81/81 PASS
# EXIT:0
```

Extracto de la parte B (las tres etiquetas repiten el mismo patrón): «episodio failed sin reautorizar: el worker no lo toma (0 llamadas de pago) — DuplicateRunError; 0 llamadas»; reanudación reutiliza lo liquidado; tercer reintento 0 llamadas y libro idéntico; gasto ≤ autorizado; dueño obtiene el MP4 (sha igual al render); usuario B → 404 sin firma; ruta fuera de la carpeta no se firma; dos ejecuciones simultáneas → una sola corre; tope de BD rechaza la reserva y el proveedor no se llama.

El cluster se apagó con `pg_ctl -m fast stop`. No quedó escuchando en TCP.

## O10 — ¿el delta está libre de bloqueantes para fusionar #228?

**Sobre el SHA congelado `0acef98`: no.** El botón del asistente reautoriza un episodio que acaba de fallar (severidad media). Es el mismo fallo que `16b47781` describe como F1. La contención de ruta es un defecto bajo y no abre la cuenta de otro ni un segundo cargo.

**Sobre el HEAD que #228 fusionaría (`69e44aa`): sí, para gasto, aislamiento de cuenta y concurrencia.** El botón ya envía solo `{ confirm: true }`, así que un `failed` sin monto nuevo responde 402 y no llama a `authorize`. El guard, el libro y el tope de la base se comportan como arriba. El defecto bajo de `..` seguía abierto en ese HEAD; este PR lo cierra. No es un bloqueante de O10 (no entrega URL a otra cuenta ni gasta de más), y con el arreglo el criterio de contención también se cumple.

## Después de `0acef98` (hasta `69e44aa`)

No cambia el veredicto de los puntos 1 y 3. Cambia el punto 2: `16b47781` quita `authorizedUsd` del botón de re-despacho y deja el defecto de interfaz en OK. El listado de episodios ya hechos con la generación apagada (`page.tsx`) solo muestra la lista; la URL sigue saliendo de `episodeAction`.

`a435537` enciende el piloto del dueño. `6ddf9c04` llegaba a confiar en la autorización si el generador no tenía el id del dueño. `69e44aa` sustituye eso: sin `PODCAST_V3_ENABLED=1`, el worker exige `PODCAST_V3_OWNER_USER_ID` válido o `PODCAST_V3_OWNER_EMAIL_SHA256` (64 hex) y, si el correo no está confirmado o no coincide, no genera ni cobra. La prueba de `studio.test.ts` («owner pilot in the worker») pasó, incluido «no owner identity in the generator: fail closed». Eso no afloja el guard ni el tope.

### Observación (no se cambió configuración ni secretos)

`.github/workflows/podcast-video.yml` fija en claro:

`PODCAST_V3_OWNER_EMAIL_SHA256: "8dcc0bfc5e69efb6c156c7972579693e10c2ff3c72ca363fc6d1fb79d58fdaac"`

Es el SHA-256 sin sal del correo confirmado del dueño, en un workflow público. No es un secreto (el comentario del propio commit lo dice), pero un hash determinista de un correo se puede contrastar con candidatos. No intenté invertirlo. No toqué el workflow.

### Observación de `paidOnce` (anterior al delta; no se modificó)

`cost.ts` no está en `67fcd7e..0acef98`. Con `state: "settled"` y `result: ""`, una segunda `paidOnce` **sí llama** al proveedor (`calls: 1`, `reused: false`). La condición exige un `result` truthy. El worker no usa ese hueco: liquida con la ruta del archivo, y en Postgres la clave con resultado se reutilizó (0 llamadas). Una clave `uncertain` sí bloquea. No lo traté como defecto de este delta ni lo cambié.

## Arreglo en este PR

- `src/lib/podcast/v3/api.ts`: `ownStudioAsset` y «solo audio» no firma MP4.
- `src/lib/podcast/v3/v3.test.ts`: positivos y negativos de descarga, `failed` sin monto, y el botón de re-despacho sin `authorizedUsd`.
- `scripts/qa/revision-delta-guard.ts`: el guard y el libro contra el esquema real (el comando de arriba).
