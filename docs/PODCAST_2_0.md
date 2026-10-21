# Atomicvid Podcast 2.0 — inventario, diseño y estado (2026-10-21)

Rama: `grok/podcast-2-0-20261021` sobre `claude/atomivid-mvp-setup-0079jv` (HEAD base `c638f40d`, Merge PR176).
Todo lo aquí descrito es **USD 0**: sin llamadas pagadas, sin despliegue, sin migraciones, Supabase no tocado.

## 1. Inventario verificable de brechas (clasificación)

| Función | Estado | Evidencia |
|---|---|---|
| Podcast narración individual (guion → ElevenLabs → montaje/MP4) | FUSIONADO + DESPLEGADO en producción (rama por defecto) | `src/lib/podcast/narrate.ts`, `video-jobs.ts`, `video-montage.ts`, worker `scripts/podcast-video-worker.ts` (render.yml) |
| Grabación propia (subir audio, olfateo de contenedor, masterizado) | FUSIONADO | `src/lib/podcast/recording.ts` |
| Voces privadas por cuenta (El Duro solo para concesiones `PRIVATE_VOICE_GRANTS` con email confirmado) | FUSIONADO | `src/lib/voices/private-voices.ts` (commit fe84bdee) |
| Selector de voz Reel ("duro hans") | FUSIONADO | `src/lib/video/reel-voices*.ts` |
| Avatar: 3 modos de narración, sin elección de voz, 45 s, ~USD 0.04/s | FUSIONADO (hecho conocido, no modificado) | `src/lib/video/avatar/pipeline.ts` |
| Correcciones de recuperación de Podcast (PR138/139/144/145/146) y QA editorial (PR160) | PENDIENTE (borradores abiertos, no fusionados) | `gh pr list` |
| Dos narradores / conversación A-B | NO EXISTÍA — añadido aquí como contrato + simulación | `src/lib/podcast/v2/conversation.ts` |
| Director emocional de voz | NO EXISTÍA — añadido (simulado) | `src/lib/podcast/v2/director.ts` |
| Director musical por emoción | NO EXISTÍA en Podcast — añadido (simulado) | `src/lib/podcast/v2/music.ts` |
| QC editorial de podcast | Parcial (PR160 borrador; av-qc.ts fusionado) — añadido `qc.ts`, reutiliza `scripts/av-qc.ts` | `src/lib/podcast/v2/qc.ts` |
| Caché por hash + idempotencia por segmento | NO EXISTÍA para Podcast 2.0 — añadido (memoria/archivo; falta tabla durable) | `src/lib/podcast/v2/cost-cache.ts` |
| UI «Narración individual / Conversación» | PENDIENTE — **no se muestra** porque el pipeline real A/B no existe en el worker (regla: no mostrar opciones que no funcionan) | — |
| Avatar dual sincronizado | BLOQUEADO — no hay integración multi-avatar; alternativa honesta: dos voces + imágenes de apoyo | — |

### Error de redondeo SUPPLY-ENVELOPE-USED (CORREGIDO en esta rama)
`jobSupplyDemands` reservaba `chars/1000 × tarifa` sobre el total (Reel: 2 llamadas). Cada llamada se admite con su costo redondeado hacia arriba a 4 decimales (`ceilLedgerUsd`), así que 2 × ceil(486 car.) > ceil(972 car.) → `SUPPLY-ENVELOPE-USED` (video 13d20347-…). Ahora se reserva la **suma de techos por llamada** (`voiceEnvelopeUsd`; long form: por beat). Archivo `src/lib/supply/job.ts` (código de suministro compartido, no de ramas activas de Claude). Prueba: `src/lib/supply/voice-envelope.test.ts` (barrido 1–3000 caracteres).

## 2. Director emocional de voz (`podcast-voice-direction/1`)
Esquema zod por segmento con todos los campos pedidos (segment_id, speaker_id, text, emotion [12 valores], delivery, pace, intensity, emphasis, pausas, pronunciation, voice_id, provider, model, estimated/actual_duration_ms, music_cue) y separación explícita **`native`** (parámetros del proveedor) vs **`post`** (silencio insertado, crossfade, loudness).
Asignación determinista por reglas de significado (sin aleatoriedad; prueba de igualdad).

Capacidades verificadas en la documentación oficial (https://elevenlabs.io/docs/best-practices/prompting/controls, 2026-10-21):
- `eleven_multilingual_v2` (modelo en uso, `src/lib/ai/voice.ts`): `<break>` ≤3 s sí; **audio tags no**; phoneme no (solo alias); `speed` 0.7–1.2, stability/style; previous_text/next_text sí.
- `eleven_v3` / `eleven_v4`: audio tags sí; **`<break>` no**; no se envía previous_text (no verificado → no se envía).
- `eleven_flash_v2`: phoneme sí.
Una etiqueta no admitida **no se envía**: se registra la adaptación en `adaptations`; si un plan la exige, `buildProviderRequest` lanza `UnsupportedDirectionError`.
Guardas: velocidad alta sostenida, saltos emocionales (suavizado + pausa), cambio de voz/modelo por hablante (error de timbre), stability acotada ±0.15 del valor base del hablante (identidad de El Duro), crossfade 30 ms, loudness −16 LUFS.
Muestras extra útiles para El Duro (sin re-clonar): 1–2 min de lectura reflexiva lenta, 1 min con preguntas/entonación interrogativa, 1 min de narración de suspenso en voz baja, 30 s enérgicos. Se usarían solo como referencia de escucha/A-B, nunca para sustituir la voz.

## 3. Conversación A/B (`podcast-conversation/1`)
Contrato con participantes A/B (fuente: voz privada, grabación propia, voz de catálogo, mock), tipos de turno (pregunta, respuesta, repregunta, desacuerdo, reacción, aclaración, transición, sorpresa), y **clase de afirmación** (hecho documentado *con URL obligatoria*, hipótesis, dramatización, opinión) + aviso obligatorio de que no es una entrevista real. `dialogueIssues` detecta monólogos/participantes confundidos, muletillas, repeticiones, preguntas sin respuesta y pausas mecánicas. Pausa entre turnos determinista por tipo.
Pipeline simulado: guion → turnos → voces (2 voces espeak-ng distintas) → timestamps → imágenes por hablante → música → mezcla con ducking → MP4 con subtítulos etiquetados `[A]`/`[B]`.
Avatar dual: **no disponible** → alternativa honesta (dos voces + imágenes de apoyo).

## 4. Grabación propia y modo mixto
Simulado y probado: el audio de A se usa tal cual (hash idéntico antes/después, 0 llamadas TTS para A), B sintético, reemplazo de un turno de B = **1** síntesis (el resto desde caché). En producción falta: asignar una grabación por turno (hoy `recording.ts` acepta un archivo por episodio) y alinear turnos con la grabación (requiere transcripción con timestamps; Scribe es de pago → necesita autorización) — **ALCANCE PENDIENTE**.

## 5. Director musical
Cues por emoción con duración mínima de 45 s (sin cambios constantes), silencio intencional antes de una revelación, menos música en reflexión (−30 dB), fundidos, ducking por sidechain, loudnorm −16 LUFS / TP objetivo ≤ −1. Solo pistas con licencia verificable (Kevin MacLeod, CC BY 4.0, `/workspace/reels-libro/musica/LICENSES.md`; atribución obligatoria). Pistas sin licencia → hallazgo bloqueante.

## 6. QC editorial
Objetivos: intro larga, duración vs objetivo, narración uniforme, ideas repetidas, marcas de pronunciación, silencios accidentales, imágenes repetidas, subtítulos con hablante incorrecto, final abrupto; AV con `scripts/av-qc.ts` (códecs, duración, decodificación, loudness, subtítulos). Subjetivo: expresividad/naturalidad → **requiere escucha humana**. Nunca se afirma «indistinguible de un humano».

## 7. Costo, caché e idempotencia
Estimación previa por llamada con precio publicado; modelo sin precio → `UnknownPriceError` (fail-safe). Clave sha256(cuenta, voz, modelo, texto, ajustes). Estados `reserved|paid|ambiguous|failed_unbilled`; ambiguo cuenta como gastado y bloquea reintento hasta reconciliación explícita; otra cuenta → `ACCESO_DENEGADO`. Falta: tabla durable en Supabase (requiere migración autorizada) e integración con `pilotBudgetEnvelope` de PR173/174 (no fusionados).

## 8. Receta (primer episodio real desde la cuenta de Hans) — requiere autorización
1. Autorizar: fusión de esta rama (tras revisión), despliegue, y gasto ElevenLabs (≈USD 1.1–1.4 para 15 min).
2. Confirmar `PRIVATE_VOICE_GRANTS` contiene El Duro para el email de Hans (ya fusionado).
3. Narración individual (ya en producción): Podcast → nuevo episodio → guion → voz El Duro → narrar → video.
4. Conversación: hasta integrar `v2` en el worker, no hay ruta en la app; usar la simulación (`npx tsx scripts/podcast-2-0/render.ts C <dir>`) solo como vista previa del contrato.
