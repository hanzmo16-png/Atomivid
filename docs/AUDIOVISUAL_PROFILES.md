# Dirección audiovisual en Reels — implementación

Implementa `docs/AUDIOVISUAL_DIRECTION.md` (especificación aprobada, commit 24b4e1f) para **Reels**.
Rama: `claude/audiovisual-profiles`. Todo va detrás de `AUDIOVISUAL_PROFILES_ENABLED` (apagado por defecto).
No hubo llamadas de pago, migraciones productivas, despliegues ni fusiones.

## Qué ve el cliente

- En «Nuevo video → Reel» hay cinco tarjetas: Cine realista, Ilustración 3D, Anime, Cómic y Horror y misterio.
- Debajo aparece un resumen de una línea, p. ej. «Suspenso · música de tensión · ritmo pausado».
  - Antes del guion, si la emoción depende de la historia, el resumen lo dice («Emoción según tu guion · …»).
- «Ajustes adicionales» (intención, música, ritmo) está cerrado por defecto.
  - Con Horror y misterio solo se ofrecen suspenso y música de tensión o sin música.
- El selector «Tono del contenido» (antes «Estilo / tono») se conserva. La voz y el idioma no cambian.
- Cada tarjeta tiene un hueco para su muestra. Hoy dice «Muestra real pendiente»: no se muestran imágenes de referencia como resultados (ver presupuesto abajo).
- Los perfiles ilustrados aparecen como «Aún no disponible» cuando la generación de imágenes está apagada o el presupuesto no alcanza.
  - El servidor rechaza la misma combinación aunque el formulario se manipule.
- En la revisión del guion aparece un panel «Dirección audiovisual» con:
  - lo que se producirá con ese guion;
  - cualquier bloqueo detectado antes de gastar, con su ruta de recuperación;
  - el botón «Cambiar» (PATCH `/api/generate/[id]/direction`).

## Arquitectura (`src/lib/video/audiovisual/`)

| Módulo | Qué hace |
| --- | --- |
| `catalog.ts` (apto para navegador) | Separa apariencia (perfil), intención narrativa, dirección musical y ritmo. Valida la selección en servidor y arma el resumen y la guía de redacción. |
| `direction.ts` | Resuelve la dirección **versionada** ligada al guion aprobado, con huella SHA-256 de selección + tono + tema + guion. Los reintentos la reutilizan; cualquier edición la invalida. |
| `music.ts` | Asigna un carácter fino a cada una de las 22 pistas (según su prompt o descripción, no escuchado) y selecciona por dirección. |
| `montage.ts` | Planos por ritmo y energía de cada escena sobre los tiempos reales de la voz. |
| `visuals.ts` | Prompt con el estilo del perfil por escena, disponibilidad y presupuesto, stock con modificador y grado de color. |
| `readiness.ts` | Combina música e imágenes. Se usa en la revisión (para mostrarlo), en `/render` (409 antes de gastar) y en el worker. |
| `persistence.ts` | Lee y escribe las columnas nuevas y tolera que la migración no esté aplicada. |
| `directed-reel.ts` | Pipeline dirigido; `generate-video.ts` le delega solo si hay dirección. |

- **Prioridad de la intención:**
  1. ajuste explícito;
  2. perfil completo (Horror → suspenso);
  3. tono fuerte (terror, humor, motivacional);
  4. intención del guion completo;
  5. tono débil (educativo, curiosidades…);
  6. divulgativo.
- **Umbral del guion completo:** hacen falta ≥3 coincidencias de ≥2 términos distintos, en ≥2 escenas, con ≥2 por cada 100 palabras y 1,5× sobre la segunda intención. Las palabras aisladas no bastan.

## Reglas de producción implementadas

- **Persistencia:**
  - `audiovisual_selection` se guarda al crear la solicitud.
  - `audiovisual_direction` se resuelve al aprobar (en el mismo UPDATE atómico que pasa a `processing`) y se reutiliza en reintentos si la huella coincide.
  - Generar, editar o regenerar una escena del guion, o cambiar la selección, pone `audiovisual_direction` en NULL.
  - El worker vuelve a comprobar la huella y, si no coincide, no gasta nada.
- **Imágenes:**
  - Los perfiles ilustrados generan una imagen por escena con el estilo del perfil; la intención solo cambia la luz y la paleta.
  - La ruta en Storage lleva un hash del prompt: un reintento reutiliza sin volver a pagar, y un guion o estilo nuevo nunca reutiliza una imagen anterior.
  - Si una imagen falla, la producción se detiene: nunca se sustituye por stock realista.
  - Se comprueban generación habilitada, proveedor, tope de escenas (`MAX_STYLED_IMAGES_PER_VIDEO`, 10) y presupuesto (`MAX_VISUAL_COST_USD`) antes de la voz.
  - Son imágenes fijas con movimiento de cámara, no animación generada. Ningún perfil autoriza Veo ni otro video pago.
- **Música:**
  - Solo pistas compatibles con la dirección, sin fallback a otra cualquiera y sin Beatoven en modo dirigido.
  - Si la pista elegida falta en el bucket, se prueba la siguiente compatible; si no queda ninguna, se detiene antes de la voz con la ruta de recuperación («Cambia la música… o «Sin música»»).
  - Tensión solo admite Tension Dark y Tension Pulse.
- **Montaje:**
  - Cobertura exacta de 0 al final: los silencios entre escenas ya no dejan fotogramas negros.
  - Cortes internos en huecos entre palabras.
  - Suspenso: la escena previa a la revelación se sostiene con acercamiento lento y la revelación entra por corte seco con impulso.
  - Humor y acción cortan más seguido con fundidos breves.
  - Los clips de stock se piden con duración ≥ plano + fundido + 0,3 s para evitar congelados.
  - Todo se valida antes del render.
- **Voz y mezcla:**
  - La voz no se regenera para imponer un estilo; la única resíntesis es la corrección de ritmo que ya existía.
  - La intención guía la redacción del guion, sin prometer control de actuación.
  - La música nunca supera la mezcla estándar; en suspenso y emotivo sube menos en los silencios.
  - Masterizado con margen de pico real de 1 dB.
- **Compatibilidad:** las solicitudes sin selección siguen `generate-video.ts` sin cambios. Avatar y Long Form no leen ni escriben estas columnas.
  - `VerticalReel` solo cambia si recibe los props nuevos.
  - `direction.ts`, `music.ts` y `montage.ts` no dependen de Reel; Long Form necesitará su propia tabla de ritmos de documental.

## Cómo activarlo (pendiente, requiere autorización)

1. Aplicar `supabase/migrations/0020_audiovisual_direction.sql` con `apply-supabase-migration.yml`.
   - Es aditiva, con rollback documentado.
   - Verificada aquí contra Postgres 16 local: 0001–0020 aplican y 0020 es idempotente.
2. `AUDIOVISUAL_PROFILES_ENABLED=true`.
3. Para los perfiles ilustrados, además: `OPENAI_IMAGE_GENERATION_ENABLED=true`, `IMAGE_PROVIDER=openai` con clave, y `MAX_VISUAL_COST_USD` ≥ escenas × costo por imagen.
   - Sin eso, las tarjetas se ven como «Aún no disponible».

## Evidencia

| Tipo | Qué |
| --- | --- |
| **Comprobado con código** | Pruebas de coherencia (aceptación 1 y 2), persistencia, reintentos, invalidación, validación de servidor, compatibilidad con solicitudes antiguas y migración ausente, cobertura del montaje, bloqueos sin gasto (aceptación 3) y orden del pipeline. |
| **Visto** | Selector en 390 px y 1280 px sin desbordes; panel de revisión (listo y bloqueado). Renders fixture de tres direcciones (`scripts/test-pipeline-audiovisual.ts`): horror con grado oscuro, viñeta y búsqueda «dark»; cómic de misterio (5 planos, anticipación y revelación con corte seco); cómic de humor (10 planos, fundidos de 4 fotogramas); subtítulos legibles. Son colores sólidos de prueba, no imágenes reales. |
| **Escuchado** | Nada. La música fixture es un tono sintético; las 22 pistas reales no se han escuchado en esta misión. |
| **Medido (no escuchado)** | `verify-music-library.yml` (solo lectura, run 36240727326): **22/22 pistas disponibles**, MP3 válidos de ~45 s, loudness entre −20,3 y −10,8 LUFS. Pistas compatibles por dirección: tensión 2, ligera 2, inspiradora 8, neutra 6, emotiva 7, enérgica 4. |
| **Pendiente** | Muestras reales (abajo) y revisión de Work. |

## Gasto durable y operaciones inciertas (revisión de Work)

Se aplica a todo el Reel dirigido. El flujo anterior (sin dirección) solo recibe los marcadores de imagen.

- **Registro de gasto por solicitud** (`paid-ledger.ts`, en Storage `<solicitud>/state/paid-ledger.json`):
  - cada operación pagada se **reserva y guarda antes de llamar** al proveedor; si no se puede guardar, no se llama;
  - se **liquida** al terminar: `spent` (costo real o estimado), `released` (costo cero conocido) o `uncertain` (pudo cobrarse);
  - es uno por solicitud, no por intento: el gasto de intentos fallidos se conserva y el tope se aplica al acumulado, que nunca se amplía en un reintento;
  - `generation_costs` recibe al final los **totales acumulados**: caracteres de voz inicial más la corrección de duración, e imágenes pagadas en todos los intentos.
- **Imágenes** (`visual-resource-resolver.ts`):
  - un error de `Storage.list` o de lectura del marcador **detiene** la producción; nunca se interpreta como «no existe»;
  - el marcador `state/generated/<prefijo>.json` pasa por `started` → `stored`;
  - si la subida falla tras cobrar (con 3 reintentos), queda `generated_unstored`; una respuesta inválida queda `generated_invalid`;
  - con `started`, `generated_unstored` o `generated_invalid` la imagen **no se regenera automáticamente**.
- **Voz** (`voice-cache.ts`):
  - la clave cubre texto + proveedor + voz/modelo/ajustes + idioma + velocidad; un reintento reutiliza audio y tiempos por palabra;
  - la corrección de duración es otra entrada y otra operación (`voice_retime`), y ambas se contabilizan;
  - los mismos estados que en imágenes impiden resintetizar algo cobrado sin resultado guardado.

### Qué costos son medidos y cuáles estimados

| Operación | Reserva previa | Liquidación | Base |
| --- | --- | --- | --- |
| Imagen (OpenAI `gpt-image-2`) | US$0,07 (conservadora; M3 midió US$0,0558) | costo del `usage` de la respuesta | **medido** si la respuesta trae `usage`; si no, **estimado** |
| Voz (ElevenLabs) | caracteres × tarifa × 1,2 | caracteres × US$0,10/1.000 (`billing/pricing.ts`) | **estimado**: caracteres exactos, tarifa según plan |
| Corrección de voz | igual que voz | igual que voz | **estimado** |
| Guion (Claude, muestras) | US$0,08 (peor caso de 3 intentos) | se liquida por la reserva | **estimado conservador**: tokens no medidos |
| Stock, música curada, render | — | — | sin costo por llamada |

### Operaciones de costo incierto

La regla es que solo se concede costo cero con evidencia (`src/lib/providers/charge-outcome.ts`). Ante la duda, la operación es incierta.

- **Costo cero: no se envió.** Solo fallos inequívocamente anteriores al envío: DNS (`ENOTFOUND`, `EAI_AGAIN`), conexión rechazada o inalcanzable (`ECONNREFUSED`, `ENETUNREACH`, `EHOSTUNREACH`, `UND_ERR_CONNECT_TIMEOUT`), TLS, URL inválida, falta de clave o presupuesto insuficiente antes de llamar. Si hay varios destinos, todos deben haber fallado así.
- **Costo cero: rechazo explícito.** Solo una lista cerrada de status: 400, 401, 403, 404, 413, 415 y 422 (más la moderación de OpenAI), y 429. Se liberan; un reintento posterior es posible.
- **Incierto:**
  - una conexión perdida con la solicitud en vuelo (`ECONNRESET`, socket cerrado, `fetch failed` sin código);
  - timeout;
  - 5xx, 408, 409 u otro status;
  - una respuesta 200 rota;
  - una descarga fallida tras un 200;
  - un proceso caído entre reservar y liquidar.
- **Sin reintento automático de lo incierto, tampoco dentro del proveedor.**
  - `openai.ts` solo repite (`OPENAI_IMAGE_MAX_RETRIES`) cuando la solicitud no salió.
  - Un 500 o una conexión cortada se lanzan tras una sola llamada.
  - ElevenLabs no reintenta.
- **Cómo se tratan las inciertas:**
  - cuentan por su reserva dentro del tope;
  - **bloquean** repetir la misma operación, en el registro y también en el marcador de imagen o el registro de voz;
  - aparecen en `openUncertainKeys`.
- **Cómo se desbloquean: recuperación manual explícita** (`recovery.ts`, `recoverPaidOperation`), después de revisar el panel del proveedor:
  1. Exige una nota del operador y un tope.
  2. Rechaza la recuperación si el resultado ya está guardado, porque el próximo intento lo reutiliza sin pagar.
  3. **Comprueba el presupuesto primero:** el comprometido, que incluye el intento anterior, más la reserva de otro intento debe caber en el tope. Si no cabe, no cambia nada.
  4. Libera **juntos** el marcador de imagen o el registro de voz (a `released`, guardando el estado previo y la nota) y reconoce la entrada del registro.
  5. El gasto anterior sigue contando. El reintento hace una reserva nueva, así que ambos intentos quedan sumados.
  6. Es idempotente: repetirla completa lo que haya faltado.

  `ledger.acknowledge` por sí solo no desbloquea el marcador; es una primitiva interna. En el workflow de muestras, la entrada `acknowledge` usa esta recuperación.
- **En Reels de clientes**, una operación incierta detiene el intento con un mensaje que pide revisión. Todavía no hay una pantalla de soporte que llame a la recuperación: es una acción manual pendiente de producto.

## Workflow de muestras reales (preparado, NO ejecutado)

Archivos: `.github/workflows/audiovisual-samples.yml`, `scripts/audiovisual-samples.ts` y `docs/quality/audiovisual-samples/manifest.json`.

- **Modos:**
  - `plan` (por defecto) no llama a proveedores: solo lee los registros y muestra plan, estimación y comprometido. Probado localmente.
  - `run` exige `confirm=GASTAR`. Las claves de pago solo se inyectan en ese caso.
- **Topes duros en código:**
  - **US$3,50 total** y **US$0,75 por muestra**; las entradas solo pueden bajarlos;
  - el acumulado se lee de los registros durables de las seis muestras, con reintentos, fallos e inciertas;
  - cada muestra usa como tope min(US$0,75, US$3,50 − comprometido por las demás) y solo arranca si su peor caso cabe;
  - la decisión y el tope se **recalculan inmediatamente antes de cada muestra** (`sample-runner.ts`), releyendo los registros durables con lo que acaba de comprometer la anterior. El plan impreso al inicio es solo informativo.
  - Las muestras se ejecutan en serie.
  - Ejemplo probado: con un total de US$1, si la primera compromete US$0,62, la segunda recibe un tope de US$0,38. No arranca si su peor caso es US$0,62, y si su estimación se quedara corta, su registro bloquea antes de llamar.
- **Cada muestra:**
  - el guion (Claude) se genera una sola vez, pasa el control de calidad y se reutiliza;
  - se produce con el mismo pipeline de producto;
  - se entrega MP4, primer fotograma, hoja de contacto, loudness e informe con el registro.
- **Se detiene ante el primer fallo.**
- **Muestras por defecto:** `horror` y `comic-mystery` (primera tanda); las demás se eligen tras revisar imagen y audio.
- **Requisito para ejecutarlo:** `workflow_dispatch` solo aparece cuando el YAML existe en la rama por defecto. Hay que registrarlo ahí, como ya se hizo con otros workflows de muestra.

### Presupuesto (no autorizado)

| Muestra | Peor caso reservado | Estimación típica |
| --- | --- | --- |
| horror, cinematic (clips reales) | US$0,20 c/u | US$0,08 c/u |
| comic-mystery, comic-humor, anime, illustration-3d (6 imágenes) | US$0,62 c/u | US$0,42 c/u |
| **Las seis** | **US$2,90** | **≈ US$1,83** |

- **Máximo solicitado:** US$3,50 total y US$0,75 por muestra.
- **Orden:** primero `horror` + `comic-mystery` (peor caso US$0,83, típico ≈ US$0,50), luego revisión de imagen y audio antes de seguir.
- **Criterios para detener:**
  - tope alcanzado (lo impone el código);
  - cualquier fallo (el runner se detiene);
  - operación incierta (se bloquea hasta recuperarla explícitamente);
  - estilo inconsistente entre escenas o música que contradiga la dirección al escucharla (revisión humana antes de la siguiente tanda).

## Segunda fase: YouTube Long Form

- Los cinco perfiles llegarán a Long Form después, con ritmos de documental propios; no se reutiliza la tabla de ritmos de Reels.
- Son reutilizables sin cambios: `catalog.ts`, `direction.ts` (`format` preparado), `music.ts`, `paid-ledger.ts`, `voice-cache.ts` y los marcadores de imagen.
- Fuera del alcance de este PR.
