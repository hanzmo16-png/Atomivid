# T-20261019-1553 — Pasos 3 y 4 + correcciones de la auditoría QA-20261019-1337/1407 (PR #157, Grok)

Estado: **PARCIAL — no apto para fusionar.** Quedan criterios obligatorios sin cumplir: el defecto D-RETRY-CEILING y la decisión del dueño sobre D-RACE.
No me autoapruebo. USD 0: todos los proveedores son mocks loopback. No hubo fusión, despliegue, migraciones en producción, cambios de flags o secretos, ni escrituras en datos reales.

## 1. SHAs (rama `grok/reel-money-precision-e2e-20261019`, PR #157 en borrador, base `claude/t46-cierre-maestro`)
| SHA | Contenido |
|---|---|
| 33050a1 | Precisión numeric(12,4) (entrega anterior) |
| 3c463c9 | WIP: arnés E2E de navegador |
| b951663 | Paso 4: E2E de imágenes extra |
| f80c2e3 | Paso 4: QA de movimiento + control RED |
| 1f97e6d | D-RACE: parche portable (sin aplicar) + test. **Vercel en rojo: tsc incluía `patches/`** |
| 05bce00 | Auditoría puntos 1 y 2; `tsconfig` excluye `patches/`. **Vercel en rojo: literales BigInt** |
| 66d77b2 | Auditoría puntos 3 y 4: aserciones del ledger; arnés autocontenido |
| 7c9476e | Comprobación de UI del Paso 3 limitada a la tarjeta de la propia solicitud |
| **95b094f** | Corrección del build (sin literales BigInt). **Vercel Preview: success** |

## 2. Auditoría ChatGPT (QA-20261019-1337 / 1407): RED → GREEN
1. **`acquireCapacityHolds` aceptaba usd=-1.**
   - Ahora valida TODAS las demandas con `ledgerUsd` antes de leer saldo o escribir cualquier hold, y rechaza el lote completo.
   - Se retiró `Math.max(0, …)` del store Supabase.
   - Los tests cubren -1, -0.0001, NaN, +Infinity, -Infinity y 1e8, y verifican 0 lecturas de saldo y 0 filas.
   - También se comprueba que el hold guarda el usd ya normalizado.
2. **`ledgerUsd(0.00010000001)` devolvía 0.0001.**
   - Regla nueva: techo EXACTO (BigInt) del decimal más corto de ida y vuelta (`String(x)`), sin tolerancias.
   - Garantía: resultado ≥ entrada, resultado < entrada + 0.0001, y múltiplo exacto de 0.0001.
   - Consecuencia documentada: con ruido binario, `0.1+0.2` (= 0.30000000000000004) pasa a 0.3001. Es una reserva conservadora.
   - Tests:
     - frontera: 0.00010000001→0.0002, 0.00019999999→0.0002, 1e-20→0.0001, 5e-324→0.0001, 12.50000001→12.5001;
     - propiedad sobre 20 000 valores.
   - RED: 8 fallos (`unit/RED-auditoria-1337-…log`). GREEN: 126/127 en paid-calls + production-intelligence + avatar. El fallo restante es preexistente (ver D-PREEXIST).
   - Test PG de precisión: 24/24.
3. **`reel-images-e2e.cjs` sin aserciones sobre el ledger.** Ahora consulta `pi_paid_operations` por `project_id`, sin `catch` (un error de consulta aborta el E2E). Exige:
   - D1: 0 operaciones openai y 1 de guion;
   - D2: 1 operación por imagen generada, con `shot_id` igual a la clave de contenido del objeto y claves únicas; cada operación COMMITTED, con job registrado y 0 < comprometido ≤ reservado ≤ 0.07; Σ reservado ≤ tope 2;
   - D3: filas openai idénticas tras los reintentos (sin reservas ni liquidaciones nuevas) y 1 sola operación de guion.
4. **Arnés dependiente de archivos externos.** `scripts/harness/e2e/infra/setup.sh` prepara todo desde un checkout limpio:
   - descarga Node 22 y PostgREST 12.2.3;
   - instala dependencias propias (playwright, pg) en `.e2e-local/deps`;
   - genera un secreto JWT aleatorio con openssl en `.e2e-local/secrets` (gitignored) y crea su propio PG;
   - aplica las migraciones más 0023 (de 9dccd68, verificada con sha256 0b49d9a4…8131);
   - siembra usuarios y políticas, y genera las texturas sintéticas.

   `start.sh` y `run-e2e.sh` solo usan rutas relativas al repo o `$E2E_HOME`. **Prueba:** `git clone` limpio de la rama en `/workspace/tmp/clean157` → setup → start → todas las corridas de este documento salieron de ese clon (`logs/setup-checkout-limpio.log`). Requisitos de sistema: PostgreSQL 17, psql, ffmpeg, curl, openssl, xz, git, npm (más tesseract para el OCR de subtítulos).
5. **Vercel Preview en rojo (1f97e6d, 14:34).** Era un fallo de build en dos fases, ambas reproducidas con `npx tsc --noEmit`:
   - (a) `patches/d-race-lease/ledger-lease.pg.test.ts` importa símbolos que solo existen con el parche aplicado; se corrigió excluyendo `patches/` en `tsconfig.json`;
   - (b) los literales BigInt `10n` no compilan con el target del tsconfig; se corrigió usando `BigInt(10)`.
   - Con 95b094f, tsc queda limpio y Vercel en success.
   - No pude leer los logs de Vercel: el MCP devolvió 403 para el scope atomivid.

## 3. Paso 3 — E2E real de navegador (clon limpio)
- Stack: Next dev real, Playwright headless (chrome-headless-shell con H.264), PG local + PostgREST real, gateway Supabase-compatible, mock Anthropic y worker de prueba con `scripts/render-worker.ts`. Sin filas precargadas.
- **GREEN `step3-green2`: 25 PASS · 0 FAIL, exit 0.** Cubre:
  - creación por formulario y revisión;
  - respuesta perdida (`route.fetch` + `abort`) con recuperación: 1 despacho y 1 intento;
  - configuración y `director_requested` conservados;
  - MP4, director.json e intento coinciden, con hash de subida igual al almacenado;
  - reproducción con currentTime +≥2 s, y descarga con sha256 idéntico;
  - otra cuenta: 404, redirección y 4xx sin cambios;
  - Director no disponible: failed con mensaje explícito, sin montaje clásico, UI «Pediste el Director» en su tarjeta, reservas liberadas;
  - egreso: ninguna salida hacia proveedores reales.
- **RED `step3-red2` (`E2E_RED=1`, sin inyectar la indisponibilidad): 22 PASS · 3 FAIL, exit 1.** Fallan exactamente las 3 aserciones de C.

## 4. Paso 4 — Imágenes extra, presupuesto, reintento y QA de medios
- **Bloqueo exacto y desviación documentada:**
  - el worker productivo en modo local-fixture envuelve fetch con `restrictFetchToLoopback`, y `openai.ts` fija `OPENAI_IMAGES_ENDPOINT` (https);
  - la ruta web rechaza un tope de material con IMAGE_PROVIDER fixture o curated-library;
  - por eso, para este escenario, el worker es `scripts/harness/e2e/worker-images.ts`: hace la misma lectura de fila e intento que worker-cli y llama a `runRenderJob`, pero desvía SOLO `POST api.openai.com/v1/images/generations` al mock loopback y rechaza cualquier otra salida;
  - el adaptador OpenAI, el ledger, la reserva y el material-fill son los productivos.
- Faltante de material: el mock de guion `[imgx]` crea escenas con oraciones al 21 % y al 79 %, lo que da 3 planos frente a 2 beats de material. Así el Director pide `ai_image` (2 planos a 0.07). No se usan hooks en el código de producto.
- **GREEN `step4-green`: 21 PASS · 1 FAIL, exit 1.**
  - D1, tope 0.01: failed con DIRECTOR_MATERIAL_BUDGET, 0 llamadas, 0 objetos, ledger sin operaciones openai.
  - D2: el intento 1 genera 2 imágenes vía mock (sha servido = objeto guardado) y luego se rompe el render a propósito; ledger con 2 operaciones COMMITTED correctas.
  - D3a: «Reintentar» del panel da 0 llamadas nuevas, pero **FALLA: no conserva el tope aprobado** → defecto D-RETRY-CEILING.
  - D3b: reintento con el tope re-aprobado → completed; 0 llamadas nuevas, mismos objetos y filas del ledger idénticas; director.json `materialFill.spentUsd=0`.
- **RED `step4-red` (tope holgado en D1): 17 PASS · 5 FAIL.**
- **QA de medios del MP4 final de D3 (`media_qa.py reel`): 19/19.**
  - ffprobe: H.264 1080x1920 + AAC, 30.19 s; decodificación completa sin errores; nº de fotogramas coherente; audio −18 dB.
  - Las 2 imágenes generadas están en sus planos (NCC 0.99/1.00 con margen) con etiqueta «Recreación IA».
  - Movimiento por plano medido: push_in con escala 1.04–1.10 dentro del ±50 % de lo esperado; pan con dx ±50 %.
  - Subtítulos por OCR: 62/62 palabras.
  - Narración ↔ visual coherente.
  - RED con el mapeo de imágenes intercambiado: 17/2.
- **QA de movimiento con texturas sintéticas sobre la composición PRODUCTIVA VerticalReel (`motion-render.ts` + `media_qa.py motion`): 18/18.**
  - push_in medido 1.088 frente a 1.087 esperado (ambos planos);
  - pan con dx −27.1 px frente a −26.9 px;
  - estático con SSIM 1.000 / 0.999;
  - cortes b=1.00; crossfade con mezcla a=0.31, b=0.33; fade con luminancia 6.3 frente a 49.9.
  - RED (todo renderizado estático y cortado): 13/5.
  - **El push-in NO es estático.** La alerta F2 de freezedetect era un artefacto del detector con zoom lento sobre imágenes planas, por lo que no hacía falta corrección de causa raíz.
  - Los umbrales y su justificación están en el encabezado de `media_qa.py`.

## 5. D-RACE (sin aplicar, **requiere decisión del dueño**)
- Archivos: `patches/d-race-lease/ledger-lease.patch`, `ledger-lease.pg.test.ts` y `apply-and-test.sh` (lo aplica en un worktree temporal).
- Qué hace el parche: un SUBMITTED reciente (dentro del arrendamiento de 15 min sobre `updated_at`) lanza `SubmissionInFlightError` (subclase de ReconciliationRequiredError) SIN marcar RECONCILIATION_REQUIRED. Al vencer el arrendamiento se comporta como hoy, y un `updated_at` futuro no extiende el arrendamiento.
- Resultado con el parche: 6/6. Sin el parche, `ledger-race.pg.test.ts` sigue en ROJO: 3 fallos de concurrencia 2/5/10.
- `src/lib/production-intelligence/ledger.ts` no se tocó.

## 6. Defectos abiertos
- **D-RETRY-CEILING (P2, nuevo):**
  - El «Reintentar» del panel (RequestCard → GenerateButton) re-despacha sin `directorMaterialUsd`, así que el intento nuevo no tiene reserva de material y falla con «material nuevo no autorizado», aunque las imágenes ya estén pagadas y guardadas.
  - Arreglarlo implica decidir si un tope aprobado se hereda entre intentos (política de gasto), por lo que **requiere decisión del dueño**. No lo cambié.
- **D-RACE (P1):** parche listo; requiere decisión del dueño.
- **D-PREEXIST:** `capacity-hold-accounting.test.ts` B2.1-1 falla con `service.rpc is not a function` ya en la base a761b01. No lo introduje yo; no se debilitó.
- **P3:**
  - la página de revisión muestra un error crudo de Remotion («browserExecutable…») al usuario;
  - la revisión muestra «Puedes continuar» junto a «Proveedores necesarios ✕» (artefacto de los proveedores fixture);
  - tras una respuesta perdida, la UI queda en revisión hasta recargar.
- Migraciones locales no aplicables: `20261011020000_pilot_scheduler` (pg_net) y `20261014183400_finished_podcast_image_slot` (json). Ninguna afecta al Reel.

## 7. Matriz
| Criterio | Estado |
|---|---|
| Auditoría 1 (usd negativo/NaN/Inf) | comprobado (RED→GREEN) |
| Auditoría 2 (techo exacto) | comprobado (RED→GREEN) |
| Auditoría 3 (aserciones de ledger) | comprobado (GREEN pasa, RED las hace fallar) |
| Auditoría 4 (arnés autocontenido) | comprobado (clon limpio) |
| Build Vercel Preview | comprobado (95b094f success) |
| Paso 3 completo con RED | comprobado |
| Imágenes extra en el montaje | comprobado |
| Sin llamadas con el presupuesto agotado | comprobado |
| El reintento no regenera | comprobado (D3b) |
| El «Reintentar» del panel conserva el tope | **fallido** (D-RETRY-CEILING) |
| Push-in / pan / transiciones medidos | comprobado |
| Duración, resolución, audio, decodificación, subtítulos, narración↔visual | comprobado |
| D-RACE corregido en ledger.ts | no ejecutado (decisión del dueño) |
| CI de GitHub Actions en el HEAD | no ejecutado (el repo no dispara CI en esta rama) |
