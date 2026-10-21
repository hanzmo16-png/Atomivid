# Recraft V4 Styles vía fal.ai — «Imágenes IA con Recraft» (Reel y Long Form)

Estado: **simulación aprobada** solamente (pruebas con HTTP simulado). Ninguna llamada real a fal.ai se hizo.

## Contrato (verificado 2026-10-21 en la documentación oficial)
- Modelo: `recraft/v4/style/text-to-image` — https://fal.ai/models/recraft/v4/style/text-to-image/api
  - Entrada: `prompt` (obligatorio), `image_size` (`portrait_16_9` para 9:16, `landscape_16_9` para 16:9),
    `style_id` **o** `image_urls` (1–10 PNG/JPG/WEBP), `style_match` (`precise|flexible`), `enable_safety_checker`.
  - Salida: `images[]` (`url`, `content_type`, …) y `style_id` (el usado o el CREADO en esta generación).
- Precio (https://fal.ai/models/recraft/v4/style/text-to-image): USD 0,035 por imagen con `style_id`;
  sin `style_id` se crea un estilo desde `image_urls` por USD 0,005 extra y se devuelve su `style_id`.
- Endpoint relacionado `recraft/v4/create-style` (https://fal.ai/models/recraft/v4/create-style/api): no se usa;
  la primera escena crea el estilo implícitamente y las demás reutilizan el `style_id` devuelto.
- Cola (https://docs.fal.ai/model-apis/model-endpoints/queue): `POST https://queue.fal.run/recraft/v4/style/text-to-image`
  (`Authorization: Key $FAL_KEY`, `X-Fal-No-Retry: 1`) → `request_id`; estado
  `GET https://queue.fal.run/recraft/v4/requests/{id}/status`; resultado `GET https://queue.fal.run/recraft/v4/requests/{id}`
  (solo owner/app, nunca la ruta completa del modelo). Las URLs de medios expiran: siempre se descargan y se guardan.

> El id `01a15cd6-f79f-77f1-8f4a-06d582611ae4` de la prueba manual es un **request_id** de la cola, **no** un
> `style_id`. El servidor lo rechaza explícitamente como style_id.

## Flujo
1. El usuario elige «Imágenes IA con Recraft» en el formulario del Reel (solo con `RECRAFT_REEL_ENABLED=true`) y da
   un `style_id` o 1–10 imágenes de referencia (se guardan en `videos/{requestId}/recraft-style/`). Sin estética
   predeterminada: el prompt usa la escena del guion y, opcionalmente, la nota de estilo del propio usuario.
2. Worker (`run-job.ts`): lee la elección en una consulta aparte, exige `FAL_KEY` ANTES de reservar o pagar voz,
   reserva el sobre `recraft` = escenas × 0,035 (+0,005 si aún no hay style_id).
3. Por escena (`generate-video.ts` → `visual-resource-resolver.ts` → `paid-calls/gate.ts`): reserva en
   `pi_paid_operations` el **estimado** (el tope total del Reel `provider_spend_cap_usd` lo admite o rechaza en
   `pi_submit_with_supply` antes de llamar), envía, **guarda el request_id (PROVIDER_JOB_RECORDED) antes de sondear**,
   sondea, descarga, valida (tipo real, no vacío, ≥512 px) y sube a Storage; COMMITTED con el costo.
4. Interrupción: el siguiente intento encuentra PROVIDER_JOB_RECORDED y **reanuda el mismo request_id**; nunca reenvía.
5. Primer `style_id` devuelto → `video_requests.reel_recraft_style_id` (una sola vez, trigger inmutable).
6. Cualquier fallo (sin clave, 402/saldo, 401/403, 429, 4xx, 5xx, timeout, descarga inválida) detiene el Reel con un
   mensaje claro. Nunca stock, fixture ni otro proveedor como sustituto.

## Dónde configurar FAL_KEY
- **Worker (obligatorio)**: el render corre en **GitHub Actions** (`.github/workflows/render.yml`, disparado por
  `repository_dispatch` desde Vercel), **fuera de Vercel**. Hace falta el *repository secret* `FAL_KEY` en
  GitHub → hanzmo16-png/Atomivid → Settings → Secrets and variables → Actions. Este PR lo mapea solo en el job de
  Reel (no Long Form).
- **Vercel (Production/Preview)**: hoy ninguna ruta de Vercel llama a fal (la web solo guarda la elección y las
  referencias). Se reporta que FAL_KEY ya está guardada en Vercel Prod/Preview — **no verificado** (403 del conector).
  Vercel solo expone variables nuevas tras un **redeploy**. Con `RENDER_WORKER=inline` (solo desarrollo) sí la
  necesitaría el proceso de Next.
- Nunca con prefijo `NEXT_PUBLIC_`; nunca se registra.

## Activación (orden) — NADA de esto se hizo en este PR
1. Aplicar `supabase/migrations/20261021090000_reel_recraft_images.sql` (sin tablas nuevas; inserta la política
   `recraft` CERRADA).
2. Desplegar web + worker. 3. Secret `FAL_KEY` en GitHub Actions. 4. Habilitar la política `recraft` en
   `pi_supply_policies` con topes financiados y evidencia, y registrar una lectura de saldo de fal (no existe aún un
   lector automático de saldo fal: sin ella `ensureJobSupplyReady` bloquea en producción — fail-closed).
5. `RECRAFT_REEL_ENABLED=true` en Vercel + redeploy. 6. Autorización explícita de Hans con presupuesto.

## Piloto real (UI → MP4) — NO ejecutar sin autorización explícita de presupuesto
El saldo de USD 9,96 en fal **no** es autorización.
1. `npx tsx scripts/recraft-pilot-preflight.ts` (solo lectura, sin red a fal) con `RECRAFT_PILOT_AUTHORIZED_USD`.
2. En /dashboard/new: Reel, 30 s, tema neutro elegido por Hans, «Imágenes IA con Recraft», 1–3 imágenes de
   referencia propias (o un style_id real), revisar guion, producir.
3. Evidencia: fila `pi_paid_operations` por escena (provider `recraft`, request_id, COMMITTED, committed_usd),
   `reel_recraft_style_id` igual para todas las escenas, objetos `videos/{id}/scene-N-recraft.webp`, MP4 final.
4. Costo estimado Reel 30 s (≈6 escenas): Recraft USD 0,215 (techo 10 escenas USD 0,355) + guion Anthropic +
   voz ElevenLabs (~USD 0,05–0,10 a 0,10/1k car.) — todo dentro del tope por Reel `REEL_MAX_PROVIDER_SPEND_USD` (1,50).


## Long Form (YouTube 16:9) — añadido en `claude/recraft-integration`
- **Dónde se elige:** en «Configurar producción», en el selector «Imágenes generadas por IA» → «Imágenes IA con Recraft». Se acepta un `style_id` o de 1 a 10 imágenes de referencia, más ajuste y nota opcionales. El plan y su costo se recalculan con el precio de Recraft antes de confirmar.
- **Persistencia:** la ruta confirm-production valida en servidor (cuenta permitida, `style_id` válido y distinto de un request_id, referencias PNG/JPG/WEBP de hasta 5 MB). Comprueba que la solicitud sea del usuario antes de subir nada y guarda las referencias en `videos/{id}/recraft-style/`. Después, en el **mismo UPDATE condicional** que confirma el plan:
  - fija `plan.providers.image = "recraft"`;
  - fija `reel_image_source = 'recraft'` y `reel_recraft_style`.
  - La migración `20261021160000_long_form_recraft_images.sql` permite la transición `null → recraft` solo junto a la confirmación; después es inmutable.
  - `reel_recraft_style_id` se escribe una sola vez.
- **Worker (`run-job.ts`), antes de reservar o pagar nada:**
  - relee la elección en la base de datos y exige que coincida con el plan confirmado;
  - vuelve a comprobar la cuenta dueña (`recraftAllowedFor`) y `FAL_KEY`.
- **Producción (`produce.ts` y `shot-executor.ts`):**
  - Las imágenes IA del plan van a Recraft con `landscape_16_9` y la nota del usuario. El prompt sale de la escena.
  - **La primera imagen crea el estilo**: su `style_id` se guarda antes de pedir la siguiente, que ya lo reutiliza. Si no se puede guardar, no se pide ninguna otra imagen.
  - El request_id se guarda en el ledger antes de sondear. Un reintento **reanuda** ese mismo request_id y nunca reenvía.
  - Un envío ambiguo (red, 5xx o 429) queda en `RECONCILIATION_REQUIRED` y no se reenvía.
  - Solo un rechazo final con costo cero (402 de saldo, 401/403, 400/422) puede reintentarse tras corregir la causa, con una clave nueva.
  - **Nunca hay sustitución:** ante cualquier fallo, la producción se detiene con un mensaje recuperable y no usa stock, tarjetas ni otro proveedor.
  - Las escenas que el plan reserva a material de archivo y los clips de video previstos no cambian.
  - Cada imagen se rotula como «Recreación IA», nunca como documento.
- **Precio:**
  - El plan estima cada imagen a USD 0,04 (0,035 + 0,005), como si todas crearan el estilo, así que es un techo.
  - El sobre de supply va bajo el proveedor `recraft`.
  - El techo total del pedido (`request-budget`) las incluye en la etapa «images».

## Quién puede elegir Recraft (piloto)
- `recraftAllowedFor(user)` (`src/lib/video/recraft-access.ts`) deja elegir Recraft en dos casos:
  - **todos**, si `RECRAFT_REEL_ENABLED=true`;
  - **si no, solo la cuenta interna dueña confirmada**. En la web se identifica con `INTERNAL_PRODUCTION_OWNER_USER_ID`; en el worker, con el mismo valor bajo `RECRAFT_PILOT_OWNER_USER_ID`, para no encender otras rutas solo para el dueño.
- Con este mecanismo, el piloto de Hans no necesita una variable nueva en Vercel.

## Saldo de fal (supply)
- Lector oficial: `GET https://api.fal.ai/v1/account/billing?expand=credits` (`src/lib/supply/fal.ts`, `scripts/supply/observe.mjs`).
  - Requiere una **clave Admin** explícita (`FAL_ADMIN_KEY`). `FAL_KEY` nunca se usa para el saldo: un 401 guardaría una lectura DOWN que taparía un saldo manual válido.
  - Solo `credits.current_balance` en USD cuenta como saldo (`provider_api`, válido 5 minutos).
  - Un 401/403, otra moneda o una forma distinta no son saldo, y el sistema falla cerrado.
  - En el worker, `FAL_ADMIN_KEY` solo está en el paso de render, para la relectura GET que hace el gate cuando el saldo envejece a mitad de producción; `npm ci` y los demás pasos no la ven.
- Se consulta al comprobar disponibilidad en Configurar, en el arranque, por llamada si el saldo está viejo y cada hora (`supply-observe.yml`). Solo hace GET; nunca genera ni recarga.
- Alternativa ya autorizada por el dueño (2026-10-05): una fila `manual_entry` en `pi_capacity_snapshots`, válida 30 minutos. Debe tener procedencia (quién y cuándo leyó el panel de fal) y no reemplaza la política ni los topes.

## Activación (orden)
1. Migraciones: `20261021090000_reel_recraft_images.sql` y después `20261021160000_long_form_recraft_images.sql`.
2. Merge y despliegue: Vercel despliega la web. El worker es `render.yml` en la rama por defecto.
3. Secretos de GitHub Actions: `FAL_KEY` (ya reportado) y `FAL_ADMIN_KEY` (clave Admin de fal, para leer el saldo). En Vercel, `FAL_ADMIN_KEY` para el chequeo de saldo en Configurar y en el arranque.
4. Política `recraft` en `pi_supply_policies`: `enabled=true`, `baseline`, `unit_cost_usd=1`, `max_concurrent`, `max_daily_calls`, `daily_cap_usd` y `monthly_cap_usd` **financiados y aprobados por Hans**, con su evidencia. Hasta entonces, toda producción con Recraft espera en «esperando disponibilidad» sin gastar.
5. Piloto: lo ejecuta Hans desde la interfaz, dentro del tope aprobado.

## Reversión
- **Desactivar sin desplegar:** poner `enabled=false` en la política `recraft`. Las producciones con Recraft quedan en espera y nada se cobra.
- **Revertir el código:** hacer revert del merge. Las columnas aditivas pueden quedarse: el código anterior las ignora.
- **No se borran filas del ledger.**
