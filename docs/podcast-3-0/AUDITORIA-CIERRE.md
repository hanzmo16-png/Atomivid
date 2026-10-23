# Podcast V3 — auditoría independiente y cierre (Claude, 2026-10-23)

Alcance: PR #192 (`grok/podcast-estudio-audiovisual`, head `d12bfb5`, incluye #193) auditado y corregido en el
PR #196 (`claude/podcast-v3-cierre`), integrado con la rama principal `2cc9a22` (PR #194). **Sin merge, sin despliegue,
sin migración productiva, sin activar el interruptor y sin ninguna llamada de pago.** No se tocaron los archivos de
#194/#195 (Long Form).

## Estado del PR #192
- Head `d12bfb5` = commit indicado. CI de #192 en verde (podcast-3-0-e2e, podcast-2-1-e2e, rescate editorial, fixtures).
- Contra `main` 2cc9a22 era **no fusionable** (`dirty`): único conflicto `package.json` (listas de pruebas). Resuelto por
  unión (pruebas de Long Form de main + pruebas de Podcast V3).

## Defectos encontrados (y corregidos en #196)
| # | Severidad | Defecto | Corrección |
|---|---|---|---|
| 1 | Alta (despliegue) | `podcast-video.yml` no pasaba `PODCAST_V3_ENABLED` ni `HEYGEN_API_KEY` al worker: con el interruptor activo en la app, un episodio autorizado quedaba «autorizado» para siempre (el worker salía con `STUDIO_DISABLED`). | El workflow pasa `vars.PODCAST_V3_ENABLED` y `secrets.HEYGEN_API_KEY`; si app y worker no coinciden, el episodio pasa a `failed` con el motivo y **sin cargos**. |
| 2 | Alta (costos) | Sin barrera previa: la voz (ElevenLabs) se pagaba antes de saber si HeyGen tenía saldo o si la estimación cabía en el tope. | Antes de la primera llamada de pago: autorización explícita, estimación de proveedores ≤ tope efectivo (min(presupuesto, autorizado)) y saldo verificado con GET de facturación gratuitos (caracteres ElevenLabs, monedero USD HeyGen). Saldo no verificable = bloqueado. |
| 3 | Media (costos) | La subida de la foto del avatar a HeyGen ocurría fuera del libro de operaciones; cada reintento la repetía. | `AvatarProvider.prepare` vía `paidOnce` (op `avatar_prepare`): el reintento reutiliza la referencia guardada. |
| 4 | Media (seguridad) | Con el estudio apagado se emitían URLs firmadas de subida de fotos y se podía usar el LLM de pago del guion. | Ambos exigen `PODCAST_V3_ENABLED=1`; sin él, plantilla gratuita y 503 para subir fotos. |
| 5 | Media (producto, modo A) | «Solo audio» renderizaba igualmente un MP4 (set + subtítulos). | `spec.output="audio"`: sin búsqueda de imágenes, sin planos, sin MP4; solo MP3/WAV. Validación: solo audio exige modo narración. |
| 6 | Media (producto, modo B) | La narración audiovisual con imágenes no era accesible desde el asistente. | Nueva modalidad «Narración con imágenes (video)» (1–2 voces, imágenes relacionadas, transiciones, música, MP4 + audio). |
| 7 | Media (UX, modo C) | Quien escucha en plano general / sobre el hombro era un fotograma congelado; los fondos de transición y título también. | Movimiento de cámara sutil y continuo (zoompan lento a 2×, zoom 1.01–1.07, periodo ≥ 6 s, desfase por plano). No anima la boca: sin lip-sync falso. |
| 8 | Baja (evidencia) | La migración del estudio no tenía auditoría reproducible (solo se aplicaba en el arnés). | `migration-audit-v3.sh` en BD desechable (ver abajo). |

Pendiente, documentado (no corregido): un cobro **incierto** (p. ej. HeyGen agota el tiempo de espera) bloquea el
reintento automático de esa operación — correcto para no cobrar dos veces, pero requiere conciliación manual
(consultar el `video_id` en HeyGen y marcar la fila `settled` o `released`). Los clips de reacción del oyente no se
generan (costarían un clip de HeyGen extra por plano); el movimiento de cámara los sustituye a costo cero.

## Proveedores
| Proveedor | Estado | Evidencia |
|---|---|---|
| ElevenLabs | adaptador real sin probar en vivo; simulado en CI | `realTts` reutiliza `synthesizeVoice`; rechazo → reserva liberada |
| HeyGen | adaptador real sin probar en vivo; simulado en CI | Avatar IV desde imagen (`/v3/videos`, 720p), audio propio, tope por clip |
| Pexels | adaptador real sin probar en vivo | gratis |
| Recraft | **no conectado** en el estudio: elegirlo da 409 con motivo, nunca se sustituye | prueba `studio.test.ts` |
| Música | biblioteca CC0 propia | QC −16 LUFS, TP ≤ −1 |
| Render/almacenamiento/descarga | GitHub Actions + Supabase Storage, URLs firmadas solo del dueño | E2E caso 10 (simulado) |

## Costos
Tarifas públicas verificadas el 2026-10-23: HeyGen Avatar IV con foto **USD 2,31/min = 0,0385/s** (coincide con
`estimateHeygenCost`); ElevenLabs Multilingual v2 **USD 0,10/1K caracteres** en la tarifa API publicada (los créditos
incluidos en los planes salen más caros por carácter); runner Linux de GitHub **USD 0,006/min** (el código usa 0,008:
conservador).

- Solo audio, 10 min ≈ 9.000 caracteres → voz USD 0,90 + runner ≈ 0,05 = **USD 0,94–0,95** con la tarifa por defecto.
  Con la tarifa interna del worker (`PRICING_ELEVENLABS_USD_PER_1K_CHARS=0.2`) la voz se reserva a USD 1,80.
- Avatares 10 min: dominado por HeyGen (segundos de avatar × 0,0385). Ver anotación «estimación 10 min» del CI.
- **Requisito**: la tarifa de voz de la app (Vercel) debe ser la misma que la del worker (0.2); si la app estima a 0,10 y
  el worker reserva a 0,20, la barrera previa rechazará el episodio (sin cargo) por superar el tope.

Controles financieros: estimación previa desglosada; autorización explícita (casilla + monto ≥ estimación y ≤
presupuesto); tope efectivo = min(presupuesto, autorizado), acumulado por episodio en el libro; barrera previa de saldo;
una operación por clave sha256 (reintentos reutilizan lo pagado); incierto = bloqueado; rechazo = liberado; no
entregado = reservas liberadas; exclusión de ejecuciones duplicadas por compare-and-set; registro por episodio en
`podcast_studio_operations` y `cost_usd`.

## Migración (propuesta, NO aplicada)
`supabase/proposals/20261023120000_podcast_v3_studio.sql`: aditiva (2 tablas nuevas), `if not exists`, RLS con solo
lectura del dueño, escritura revocada a `anon`/`authenticated` (solo service role). Auditoría en CI
(`migration-audit-v3.sh`): re-ejecutable, `podcast_episodes` intacta, CHECKs, aislamiento entre usuarios, reversión
limpia y re-aplicación. La reversión **borra** los episodios de estudio y su libro: exportar antes si hubo uso real.

## Interruptor
`PODCAST_V3_ENABLED=1` no expone el estudio a usuarios no autorizados: la navegación, la página y todas las rutas exigen
`canAccessLongFormBeta` (403/404 para el resto); el worker exige el interruptor y `status=authorized`.

## Móvil
Emulación en CI (Chromium): iPhone 13 (390×664, DPR 3) y Pixel 7 (412×839, DPR 2,625): menú, asistente completo,
sin desbordamiento horizontal, reproducción. Solo verificable en un teléfono físico: reproducción y descarga del MP4/MP3
en Chrome Android y Safari iOS reales, subida de foto desde la cámara, comportamiento con la pantalla bloqueada
durante el sondeo de progreso, y rendimiento en red móvil.

## Despliegue y reversión (cuando el propietario lo autorice)
1. Merge de #196 (contiene #192). Vercel despliega con el estudio apagado: sin cambio visible en producción.
2. Aplicar la migración propuesta. 3. `PODCAST_V3_ENABLED=1` como variable del repositorio **y** en Vercel.
4. Piloto. Reversión: quitar `PODCAST_V3_ENABLED` (inmediato, sin datos perdidos); revertir el merge si hiciera falta;
   la reversión SQL solo tras exportar.
