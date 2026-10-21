# Podcast 2.1 — integración real (rama, NO producción)

Estado: código en la rama `grok/podcast-2-0-20261021` (PR #178, draft). Nada fusionado, desplegado ni migrado en entornos reales.

## Qué está conectado (camino real, tras `PODCAST_V2_ENABLED=1`)
| Pieza | Conectado a | Prueba |
|---|---|---|
| Formulario: individual/conversación, estándar/emocional, música, voz B ≠ A | `NewEpisode.tsx` → `POST /api/podcast` (`production`) | E2E c1/c2 (clics reales) |
| Director de voz por segmento | `narrate-v2.ts` → `gatedVoiceSynthesize` (libro mayor + resultados persistidos) | c2: ajustes distintos por segmento; c1: speed≠1 solo en parte |
| Voces separadas A/B | `voiceFor(participant)`; `VOICE_IDENTITY_MISMATCH` si no coincide | c2: llamadas por voz = turnos por hablante |
| El Duro solo dueño | `visibleVoices`/`canUsePrivateVoice` en `buildProduction` | c5: invisible y rechazado (400) para otra cuenta |
| Mixto (grabación propia) | `POST /api/podcast/[id]/turns` ticket→subida firmada→attach; sin TTS; sha conservado | c3 |
| Reemplazar un turno | acción `edit` → solo ese segmento se resintetiza | c3: exactamente 1 llamada |
| Música + ducking + loudnorm 2 pasadas | `narrate-v2.ts` (sidechaincompress, `masterAudioLoudness`) | c1/c2: −16 LUFS, TP ≤ −1, LRA ≤ 15 |
| Reanudación sin doble cobro | resultados persistidos + `ReconciliationRequiredError`/`SubmissionInFlightError` | c4 |
| Subtítulos por hablante | worker de video lee `production_timeline` (`[Nombre]`) | unit + MP4 de evidencia |

## Dependencia de migración
`supabase/proposals/20261021200000_podcast_v2_production.sql` (+ `.rollback.sql`): columnas `production`, `production_timeline` (jsonb).
**Sin aplicar** en ningún proyecto real. Sin ella, activar `PODCAST_V2_ENABLED` rompe las consultas; con el flag apagado el código usa las columnas de siempre.

## Limitaciones honestas
- Si el proceso muere con una llamada en vuelo, ese segmento queda «incierto» y **requiere revisión manual** (no se reenvía para no cobrar dos veces).
- El MP4 de evidencia (`scripts/podcast-2-0/evidence-mp4.py`) es un render de verificación (tarjetas + subtítulos), no el pipeline de video del producto (worker + Pexels, no ejercitado E2E).
- Nunca dos avatares: cada participante es una imagen.
- Estimación de narración pendiente en `pilot-server` es conservadora (sobreestima) para episodios v2.

## E2E local (USD 0)
`scripts/harness/e2e/podcast/start.sh` (PG + PostgREST + gateway local + mock ElevenLabs con espeak-ng + Next), luego `run.sh <salida> 1,2,3,4,5,6`.

## Los 6 fallos de `test:unit` en local
`recovery-flow` ×2 y `attempt-state` ×4 requieren `WebSocket` nativo (Node ≥ 22). Con el Node del sistema de la máquina (v20.19.2) fallan igual en base `c638f40d` y en la rama; con Node 22.12 pasan en ambas (base 2169/0, rama 2181/0). CI usa Node 22 → no aparecen. Reproducir:
`PATH=/usr/bin:$PATH npm run test:unit` (falla 6) vs `PATH=<node22>/bin:$PATH npm run test:unit` (0 fallos).
