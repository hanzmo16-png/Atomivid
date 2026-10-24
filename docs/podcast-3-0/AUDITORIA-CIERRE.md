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

### Segunda ronda (cierre controlado)
| # | Severidad | Defecto | Corrección |
|---|---|---|---|
| 9 | **Crítica** (pérdida de trabajo / cobro) | Lo pagado (voz, clips) solo vivía en el disco del runner; el libro guardaba una ruta local. Un reintento en otro runner de GitHub (siempre efímero) no podía reutilizarlo. | Almacén de artefactos pagados en Storage privado (`<dueño>/podcast-studio/<episodio>/paid/`); el libro guarda la referencia; si falta, falla cerrado (`PaidArtifactMissingError`) y nunca repaga. |
| 10 | Alta (cobro doble) | La clave del clip de avatar era el hash de los bytes del máster re-codificado: otra versión de ffmpeg = otra clave = clip pagado dos veces. | Clave determinista: clave de la voz pagada del turno + desplazamiento + segundos. |
| 11 | Alta (costos) | App y worker estimaban con tarifas distintas (Vercel vs `0.2` fijo en el workflow). | La estimación guarda sus tarifas (`estimate.rates`); el worker estima y reserva con esas. |
| 12 | Alta (costos) | Duraciones reales mayores que las estimadas podían agotar el tope a mitad de los clips (pagados y sin terminar). | Segundo control tras la voz con duraciones reales: no se pide ningún clip si no caben todos. |
| 13 | Alta (recuperación) | Runner muerto (tiempo/cancelación): el episodio quedaba «generating» para siempre. | `podcast-video-mark-failed.ts` lo pasa a `failed`; reservas en vuelo → `uncertain` (conciliación, nunca repago). |
| 14 | Media (prueba) | El E2E móvil elegía el modo por posición (`MODES[2]`); al añadir el modo B pasó a probar otro modo (39 < 40 comprobaciones). | Selección por etiqueta (`c10c`, conversación). |

## Pruebas reales mínimas (preparadas, NO ejecutadas)
Requisitos: migración aplicada; `PODCAST_V3_ENABLED=1` solo para la cuenta piloto (Vercel Preview o producción con la beta cerrada); variable del repositorio para el worker. Saldos verificados (2026-10-23 22:20 UTC, lectura gratuita): ElevenLabs 100.996 caracteres, HeyGen USD 47,72 (monedero API).
| Prueba | Configuración | Costo máximo autorizado (tope duro del episodio) |
|---|---|---|
| R1 Solo audio | 1 voz, ~900 caracteres | USD 0,25 |
| R2 Narración con imágenes | 2 voces, ~900 caracteres, Pexels | USD 0,25 |
| R3 Avatar | 1 avatar existente, 2 turnos, frecuencia 1, máx. 5 s | USD 0,60 |
| R4 Conversación | 2 avatares, 4 turnos cortos, máx. 4 s | USD 1,00 |
| R5 Reintento | cancelar R3 a mitad y reintentar: debe reutilizar todo lo pagado | USD 0 adicional (dentro de R3) |
| **Total** | | **USD 2,10** |

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
