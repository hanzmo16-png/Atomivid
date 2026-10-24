# Podcast 3.0 (Atomicvid) — estudio de episodios

> **Estado: NO listo para producción. Validado solo en simulación** (proveedores simulados, BD local desechable). Nada de esto se ha probado con proveedores reales.

## Qué incluye
| Modo | Qué hace |
|---|---|
| A · Narración cinematográfica | 1–2 voces que se alternan, imágenes relacionadas (archivo o «Recreación» marcada), escenas con zoom, música por ambiente, transiciones, subtítulos opcionales. MP4 + audio MP3/WAV aparte. |
| B · Un avatar presentador | Avatar existente o creado desde foto **con consentimiento explícito**. Segmentos con sincronía labial (HeyGen) cortados del máster de voz; frecuencia de aparición y duración máxima configurables; el resto del turno son imágenes. |
| C · Conversación entre dos | Dos voces y dos avatares independientes; generador de conversación (IA opcional, plantilla gratis de respaldo); parser de guion «Nombre: texto»; primeros planos, plano a dos, sobre el hombro, posiciones invertibles, escenarios, imágenes intercaladas. |

**Honestidad sobre los planos de dos personas:** cada avatar se genera por separado. En «plano a dos» y «sobre el hombro» quien escucha es un **fotograma fijo** de su clip, y la «espalda» del sobre el hombro es una silueta aproximada (desenfocada y oscurecida). No son dos personas filmadas juntas.

**El Duro:** solo se usa si `PRIVATE_VOICE_GRANTS` lo concede a la cuenta. Si no hay concesión aparece «No disponible» y **nunca** se sustituye por otra voz. Si está concedida a otra cuenta, se oculta.

## Audio
- Biblioteca musical propia CC0 (8 ambientes, cortinas, ambientes) — `assets/podcast-music/LICENSE.md`. Corrige que en producción no había música (faltaba `PODCAST_MUSIC_DIR`): el flujo 2.x usa esta biblioteca cuando la variable no existe.
- Ducking por sidechain, fundidos, cortinas, ambiente; máster mono a **−16 LUFS, pico real ≤ −1 dBTP, sin recortes** (ganancia lineal + limitador sobremuestreado a −3 dBFS, verificado con ebur128 en el MP4 final).
- Las pruebas verifican que la música **está presente** (energía en las pausas ≥ 15 dB por encima de la versión sin música).

## Planificador editorial
Determinista. Prioridad VERACIDAD > CALIDAD > CONSISTENCIA > COSTO > VELOCIDAD: imágenes reales antes que recreaciones, sin repetir imágenes, toda recreación con la etiqueta «Recreación» en pantalla.

## Costos y protección
- Estimación desglosada (voz, avatar, imágenes, video, render) y presupuesto por episodio. Sin autorización explícita (casilla + monto ≥ estimación y ≤ presupuesto) no hay ninguna llamada de pago.
- Libro de operaciones con clave de idempotencia (sha256) por operación: reintentos y re-despachos no cobran dos veces; resultado incierto bloquea el reintento automático; rechazos del proveedor liberan la reserva; un episodio no entregado libera sus reservas.
- Exclusión de ejecuciones duplicadas por compare-and-set en la fila del episodio.

### Costo estimado de un episodio de ~10 min (configuración de los fixtures, tarifa de voz por defecto USD 0.10/1K)
| Modo | Voz | Avatar | Imágenes | Render | **Total** |
|---|---|---|---|---|---|
| A narración | 0.83 | 0 | 0.14 | 0.11 | **≈ USD 1.08** |
| B avatar | 0.83 | 11.16 (36 apariciones, 288 s) | 0 | 0.11 | **≈ USD 12.10** |
| C conversación | 0.83 | 17.28 (48 apariciones, 442 s) | 0 | 0.11 | **≈ USD 18.22** |

Con la tarifa configurada en producción (`PRICING_ELEVENLABS_USD_PER_1K_CHARS=0.2`) la voz sube a ≈ USD 1.66. El avatar domina: bajar la frecuencia o la duración máxima lo reduce casi linealmente. La tarifa de HeyGen (0.0385 USD/s) es la observada en el repo, no una cotización vigente.

## Proveedores: real vs simulado
| Proveedor | En pruebas/CI | En la app (con estudio activado) |
|---|---|---|
| ElevenLabs (voz) | mock (espeak-ng / tono) | real adapter (untested live) — `synthesizeVoice` existente |
| HeyGen (avatar, lip-sync, crear desde foto) | mock (cara animada «AVATAR SIMULADO») | real adapter (untested live) — `heygenAvatarProvider` existente |
| Pexels (imágenes) | mock («IMAGEN SIMULADA») | real adapter (untested live) |
| Recraft (recreaciones) | mock | **no conectado** en modo real (las recreaciones quedan como tarjeta de título) |
| Anthropic (conversación con IA) | mock | real adapter (untested live), solo con `PODCAST_V3_LLM=1`, vía el libro de suministro existente |
| Música | biblioteca CC0 propia | igual (sin proveedor externo) |

## Activación (requiere autorización del propietario)
1. Aplicar `supabase/proposals/20261023120000_podcast_v3_studio.sql` (aditiva: dos tablas nuevas con RLS de lectura por dueño; rollback en `.rollback.sql`). **No aplicada** en producción.
2. `PODCAST_V3_ENABLED=1` en Vercel y en el workflow del worker; `HEYGEN_API_KEY` en el entorno del worker para B/C.
3. Opcional: `PODCAST_V3_LLM=1` para la conversación con IA.

Sin esto: el asistente aparece, el modo A usa el flujo 2.x existente (ahora con música) y B/C se muestran «pendiente de autorización».

## Cómo probar
- `npm run test:podcast3` (requiere ffmpeg y espeak-ng) · `npm run podcast3:demo -- salida` · E2E: workflow `podcast-3-0-e2e` (casos 1–10).
- Prueba real desde atomicvid.app (tras activar): Podcast → asistente → elegir modo → guion → … → paso 9 revisar costo → paso 10 autorizar → esperar → reproducir y descargar MP4/audio.

## Limitaciones conocidas
- Ninguna ruta real probada en vivo. Recraft no conectado en modo real.
- La música es síntesis simple (funcional, no profesional).
- Planos de dos personas compuestos (oyente en fotograma fijo).
- La estimación usa 15 car/s; el costo real de avatar depende de la duración real de la voz y puede superar la estimación (siempre dentro del presupuesto autorizado, que es el tope duro).
- Compartido con áreas de otros agentes: integración mínima en `src/lib/podcast/server.ts` (música por defecto), `video-jobs.ts` (tipo de trabajo `studio`), `scripts/podcast-video-worker.ts` (enrutado) y la página `dashboard/podcast` (asistente + formulario clásico en «Formulario clásico»). No se tocaron ResultView, reproductor, recuperación de enlaces, Long Form/Recraft ni la misión editorial.
