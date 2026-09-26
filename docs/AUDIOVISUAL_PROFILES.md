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
| **Pendiente** | Disponibilidad real de los 22 archivos (workflow de solo lectura `verify-music-library.yml`, corre al abrir el PR); muestras reales (abajo); revisión de Work. |

## Propuesta presupuestada de muestras reales (no autorizada, no ejecutada)

- **Objetivo:** reemplazar «Muestra real pendiente» por resultados reales revisados, y validar con imagen y audio las aceptaciones 1, 2 y 4.
- **Proveedores (todos ya integrados, ninguno nuevo):**
  - Claude (guion);
  - ElevenLabs (voz, la misma del cliente);
  - Pexels/Pixabay (stock, gratis);
  - biblioteca de música curada (gratis);
  - OpenAI imágenes (`gpt-image-2`, 1024×1536 medium);
  - GitHub Actions (render).
- **Tarifas de referencia:** registradas en `billing/pricing.ts` y, para imagen, el costo real medido en M3 (US$0,0558 por imagen).

| # | Muestra (30 s, español) | Generaciones de pago | Estimado |
| --- | --- | --- | --- |
| 1 | Horror y misterio con guion que menciona éxito y negocios (aceptación 1) | 1 guion + 1 voz | US$0,12 |
| 2 | Cómic + misterio (aceptación 2) | 1 guion + 1 voz + 6 imágenes | US$0,46 |
| 3 | Cómic + humor (aceptación 2) | 1 guion + 1 voz + 6 imágenes | US$0,46 |
| 4 | Cine realista, divulgativo | 1 guion + 1 voz | US$0,12 |
| 5 | Anime | 1 guion + 1 voz + 6 imágenes | US$0,46 |
| 6 | Ilustración 3D | 1 guion + 1 voz + 6 imágenes | US$0,46 |
| | **Total estimado** | 6 guiones, 6 voces, 24 imágenes | **US$2,08** |

- **Máximo solicitado:** **US$3,50**, incluidos reintentos.
- **Orden:** primero las muestras 1 y 2 (~US$0,58), revisión de imagen y audio, y solo entonces el resto.
- **Criterios para detener:**
  - el gasto acumulado llega a US$3,50;
  - una muestra supera US$0,75;
  - dos fallos de imagen seguidos en el mismo perfil;
  - la primera muestra ilustrada no mantiene el estilo entre escenas;
  - la música elegida contradice la dirección al escucharla.
- **Requisito operativo:** un workflow de muestra con libro de gasto (como `long-form-quality-sample.yml`), que se preparará solo después de la autorización.
