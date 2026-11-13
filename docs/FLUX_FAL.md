# FLUX.1 [dev] vía fal.ai — «Imágenes IA con FLUX» (Reel y Long Form)

**Segundo proveedor seleccionable.** Recraft sigue siendo el principal y la opción predeterminada. OpenAI Images
conserva su papel actual, solo bajo las reglas existentes (`IMAGE_PROVIDER`). FLUX nunca sustituye en silencio a otro
proveedor, y ningún otro proveedor lo sustituye a él.

## Contrato (verificado el 2026-11-13 en la documentación oficial)
- **Modelo:** `fal-ai/flux/dev` (FLUX.1 [dev], text-to-image).
  - `GET https://api.fal.ai/v1/models?endpoint_id=fal-ai/flux/dev` (público) → `status: active` (comprobado el 2026-11-13).
  - Esquema: https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/flux/dev.
- **Entrada:** `prompt` (obligatorio), `image_size` (enum o `{width,height}`), `num_inference_steps` (1–50, por defecto 28),
  `guidance_scale` (1–20, por defecto 3,5), `num_images` (1–4), `seed`, `enable_safety_checker` (por defecto true),
  `output_format` (jpeg|png), `sync_mode` y `acceleration`.
- **Salida (todo obligatorio):** `images[]`, `timings`, `seed`, `has_nsfw_concepts[]` y `prompt`.
- **Lo que envía ATOMIVID:**
  - `image_size` **exacto**: 720×1280 para 9:16 y 1280×720 para 16:9.
  - `num_images: 1`, `num_inference_steps: 28`, `guidance_scale: 3.5`, `enable_safety_checker: true`, `output_format: "jpeg"`.
  - Nunca `sync_mode`.
  - El enum `portrait_16_9` (576×1024) **no** se usa: no pasaría el control automático de imagen (lado corto < 700 px).
- **Precio:** https://fal.ai/models/fal-ai/flux/dev indica «USD 0.025 per megapixel. Images are billed by rounding up to
  the nearest megapixel».
  - 720×1280 son 0,92 MP, que se cobran como 1 MP: **USD 0,025 por imagen**, que es el estimado y el techo.
  - La API de precios de fal (`GET /v1/models/pricing`) devuelve `unit_price 0.025, unit image`.
- **Cola:**
  - `POST https://queue.fal.run/fal-ai/flux/dev` con `Authorization: Key $FAL_KEY` y `X-Fal-No-Retry: 1` → `request_id`.
  - Estado: `GET /fal-ai/flux/requests/{id}/status`; resultado: `GET /fal-ai/flux/requests/{id}` (solo `owner/app`).
  - Las URLs de medios caducan, así que los bytes siempre se descargan y se guardan.
- **Filtro de seguridad:** si devuelve `has_nsfw_concepts[0] = true`, la imagen no se usa.
  - Se trata como costo incierto (`invalid_response` con request_id), nunca como un rechazo sin cobro.

## Flujo
1. **Elección** (solo para cuentas permitidas):
   - Reel: «Imágenes IA con FLUX» en el formulario. Se guarda `reel_image_source = 'flux'` al crear el pedido.
   - Long Form: en «Configurar producción». El plan fija `providers.image = "flux"` y escribe `reel_image_source = 'flux'`
     en el **mismo UPDATE condicional** que confirma el plan.
   - En ambos casos la elección es inmutable después: lo garantiza el trigger existente.
2. **Worker** (`run-job.ts`), antes de reservar o pagar nada:
   - relee la elección;
   - exige que coincida con el plan;
   - vuelve a comprobar la cuenta (`fluxAllowedForWorker`) y `FAL_KEY`.
3. **Supply:** el sobre va bajo el proveedor `flux`.
   - Reel: (escenas + reserva de regeneración) × USD 0,025.
   - Long Form: el techo generativo del plan.
4. **Por imagen**, con la misma puerta que Recraft (`paid-calls/gate.ts`):
   1. La reserva en `pi_paid_operations` es el estimado.
   2. Se envía y se **guarda el request_id antes de sondear**.
   3. Se sondea, se descarga y se valida (tipo real, tamaño, dimensiones).
   4. Pasa el control automático (encuadre, resolución, imagen vacía). Si lo rechaza, se regenera **una vez** con su propia
      clave; un segundo rechazo detiene el video.
   5. Se sube a Storage y la fila queda COMMITTED.
5. **Interrupción:** se reanuda el mismo request_id y nunca se reenvía.
   - 402, 401/403 o 400/422 son rechazos sin cobro: se reintentan en un intento posterior.
   - 429, 5xx o red caída al enviar quedan en conciliación y nunca se reenvían.
6. **Nunca hay sustituto:** ni stock, ni fixture, ni OpenAI, ni Recraft.
7. Cada imagen de Long Form se rotula «Recreación IA».

## Quién puede elegir FLUX
`fluxAllowedFor` (`src/lib/video/flux-images.ts`):
- **todos**, solo si `FLUX_IMAGES_ENABLED=true`. Es independiente de `RECRAFT_REEL_ENABLED`;
- **si no, solo la cuenta interna dueña**: el mismo criterio del piloto de Recraft (`INTERNAL_PRODUCTION_OWNER_USER_ID` /
  `RECRAFT_PILOT_OWNER_USER_ID`).

## Prueba real controlada (una imagen) — `scripts/fal/flux-real-test.ts` y `.github/workflows/flux-real-test.yml`
- **Preflight (USD 0):**
  - el modelo está activo;
  - `FAL_KEY` autenticada (`GET /v1/models/pricing`, para cualquier llamador autenticado);
  - precio de la cuenta;
  - estimación de fal (`POST /v1/models/pricing/estimate`);
  - saldo (`FAL_ADMIN_KEY`, `GET /v1/account/billing`).
- **Generación**, solo si se cumplen todas las condiciones:
  - preflight satisfactorio;
  - autorización explícita ≥ estimado y ≤ USD 0,50;
  - frase `GENERAR-UNA-IMAGEN-FLUX`;
  - saldo verificado ≥ estimado.
- **Ejecución:** una sola imagen 9:16 con el adaptador real de ATOMIVID y el control automático. Sin reintentos pagados.
- **Costo real:** se lee de `GET /v1/models/billing-events?request_id=…`, que exige una clave con `billing:usage:read`.
- **Evidencia:** el informe JSON y la imagen se suben como artefacto del workflow.
- **No escribe** en Supabase ni en el ledger de producción.
- **Disparadores:**
  - `push` a la rama FLUX: preflight. Solo genera cuando ese mismo push añade o cambia
    `ops/flux-real-test/authorization.json`.
  - `workflow_dispatch`: disponible una vez fusionado.

## Activación en producción (orden) — NADA de esto se hizo en este PR
1. Aplicar `supabase/migrations/20261113150000_flux_image_source.sql` con `apply-supabase-migration.yml`.
   - Es aditiva y compatible con el código desplegado, así que se aplica **antes** del merge.
   - Verificación local: `supabase/migrations/verify/flux_image_source.sql`.
2. Merge y despliegue (Vercel para la web; `render.yml`, en la rama por defecto, para el worker).
3. Secretos: `FAL_KEY` y `FAL_ADMIN_KEY` ya existen en GitHub Actions; en Vercel, según Hans, ya están configurados.
   - El worker usa `FAL_KEY` en el paso de render, el mismo mapeo que Recraft (ver la nota del PR).
   - La web solo usa `FAL_ADMIN_KEY`, para comprobar el saldo al configurar.
4. Habilitar la política `flux` en `pi_supply_policies` con topes financiados y aprobados por Hans. Hasta entonces, toda
   producción con FLUX espera «disponibilidad» sin gastar.
5. Piloto con la cuenta dueña. Después, opcionalmente, `FLUX_IMAGES_ENABLED=true` en Vercel y redeploy.

## Reversión
- `enabled=false` en la política `flux`: las producciones FLUX quedan en espera y no se cobra nada.
- Revert del merge. La columna admite `'flux'`, pero el código anterior nunca lo escribe; las filas ya creadas quedan en
  espera, sin cobro, por la falta de política.
