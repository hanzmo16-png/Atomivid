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
| Subtítulos por hablante | worker de video lee `production_timeline` (`[Nombre]`) | E2E c7: `subtitulos.json` con [Hans]/[Invitada] |
| Video AV completo | VideoPanel «Producir ahora» → despacho → worker real (narra, imágenes Pexels **simuladas**, editor v3, MP4) → reproductor y descarga | E2E c7 |
| UI por turno | `TurnsPanel.tsx`: subir grabación (URL firmada), editar un turno, estado por turno | E2E c8 (clics reales) |
| Operaciones inciertas | aviso «Requiere revisión», reintento/edición deshabilitados; `/generate` responde 409 | E2E c8 |

## Dependencia de migración
`supabase/proposals/20261021200000_podcast_v2_production.sql` (+ `.rollback.sql`): columnas `production`, `production_timeline` (jsonb).
**Sin aplicar** en ningún proyecto real. Sin ella, activar `PODCAST_V2_ENABLED` rompe las consultas; con el flag apagado el código usa las columnas de siempre.

## Limitaciones honestas
- Si el proceso muere con una llamada en vuelo, ese segmento queda «incierto»: la UI lo muestra y bloquea reintentos; la **conciliación** con el historial de ElevenLabs sigue siendo manual (no hay botón de conciliar: requiere acceso al proveedor).
- Las operaciones inciertas ocupan cupo de concurrencia del proveedor hasta conciliarse.
- Los medios de Pexels se vuelven a buscar en cada reintento de video (gratis; no se persisten entre intentos).
- El pipeline de video del producto se ejercita E2E (c7) con Pexels simulado; `scripts/podcast-2-0/evidence-mp4.py` queda solo como render auxiliar.
- Nunca dos avatares: cada participante es una imagen.
- Estimación de narración pendiente en `pilot-server` es conservadora (sobreestima) para episodios v2.

## E2E (USD 0)
Casos: 1 narración · 2 diálogo A/B · 3 mixto (API) · 4 recuperación · 5 aislamiento · 6 errores/concurrencia · 7 video AV desde la UI · 8 UI por turno.
Workflow propuesto: `.github/workflows/podcast-2-1-e2e.yml` (no se pudo subir: el token no tiene el scope `workflow`).

`scripts/harness/e2e/podcast/start.sh` (PG + PostgREST + gateway local + mock ElevenLabs con espeak-ng + Next), luego `run.sh <salida> 1,2,3,4,5,6`.

## Los 6 fallos de `test:unit` en local
`recovery-flow` ×2 y `attempt-state` ×4 requieren `WebSocket` nativo (Node ≥ 22). Con el Node del sistema de la máquina (v20.19.2) fallan igual en base `c638f40d` y en la rama; con Node 22.12 pasan en ambas (base 2169/0, rama 2181/0). CI usa Node 22 → no aparecen. Reproducir:
`PATH=/usr/bin:$PATH npm run test:unit` (falla 6) vs `PATH=<node22>/bin:$PATH npm run test:unit` (0 fallos).

## Auditoría P2.1 (2026-10-23) — correcciones en `claude/podcast-2-1-audit-fixes`
| Hallazgo | Corrección | Prueba |
|---|---|---|
| Editar turnos saltaba el tope de 30 000 caracteres del guion (gasto de voz sin tope) | `applyTurnAction` aplica `validateScript` al guion resultante | `integration.test.ts` «turnos: editar no supera el límite…» |
| La API de turnos aceptaba editar/adjuntar con un cobro incierto (solo la UI lo impedía) | 409 con cobro incierto, 503 si el registro no se lee | misma prueba |
| Reserva de voz (`voiceEnvelopeUsd`) menor que lo que el gate registra por llamada (`ledgerUsd`, techo estricto): Long Form se detenía a mitad (486+100 car. a 0.2 → 0.1172 < 0.1174) y el caso Reel 13d20347 seguía sin cubrirse | cada llamada con `ledgerUsd`, trozos de beats largos, nunca menos que el total bruto anterior | `voice-envelope.test.ts` (barrido aleatorio) |
| CHECK de `production` aceptaba array/escalar/claves ausentes (NULL pasa un CHECK) | `coalesce(…, false)` + `jsonb_typeof = 'object'` | `migration-audit.sh` |
| El rollback dejaba episodios v2 narrables como 1.x (voz A, etiquetas «A:», TTS de grabaciones propias) y cobrables, incluso por el tick programado o «Producir ahora» (que reescribe el presupuesto) | antes de borrar columnas: `source='upload'` sin guion (el código 1.x rechaza generar y producir), presupuesto 0, borrador/fallido → fallido, video programado/en cola → bloqueado; estado previo en la copia, refrescado en un segundo ciclo | `migration-audit.sh` (neutraliza, restaura, segundo ciclo) |
| Filtro «-mos» eliminaba sustantivos (cosmos, átomos, abismos, ritmos) | terminaciones verbales (-amos/-emos/-imos/-ábamos/-íamos…) con lista de sustantivos permitidos | `visual.test.ts` |
| CI de regresión podía pasar con `test:unit` ≠ 0; c9 aceptaba más operaciones que llamadas | exige exit 0; igualdad y claves únicas | workflow / `podcast-e2e.cjs` |

## Orden de despliegue (requiere autorización de Hans en cada paso)
1. Fusionar #178 → #181 → #184 (+ estas correcciones) en la rama por defecto: los workers (`repository_dispatch`) ejecutan SIEMPRE el código de la rama por defecto.
2. Con `PODCAST_V2_ENABLED` sin definir (Vercel y variable del repositorio), desplegar: el código nuevo funciona sin la migración (columnas no leídas; 42703 se trata como 1.x).
3. `PRICING_ELEVENLABS_USD_PER_1K_CHARS` en Vercel debe ser igual a la del worker (`0.2` en `podcast-video.yml`); si la app estima con 0,1 el worker detiene la narración en segundo plano (>6000 car.) antes de cobrar («límite autorizado USD 0.76»).
4. Solo para el modo por turnos (conversación/emocional/música): aplicar la migración, luego `PODCAST_V2_ENABLED=1` en Vercel **y** en la variable del repositorio, y redeplegar. Activar el flag sin la migración rompe todas las páginas de Podcast.
5. Reversión: flag fuera + redeploy; si se revierte la migración, el `.rollback.sql` neutraliza antes los episodios v2 (restauración: la sentencia de su cabecera).
6. Transición de la reserva de voz: desplegar sin renders de Reels/Long Form en curso. Un intento reservado por el código anterior y re-reservado por el nuevo puede fallar con «job envelope changed» (sin cobro nuevo; se reintenta).
