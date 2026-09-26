# Voces: catálogo, «Texto a voz» y «Mi voz»

Estado: **código implementado y probado sin gasto; nada activado en
producción.** Flags apagados, migración 0021 sin aplicar, ninguna síntesis
ni clonación real ejecutada con este código. Las voces no se escucharon:
la elección se basa en datos medidos por la API y métricas acústicas
objetivas de las previews públicas. La naturalidad la juzga una persona.

## 1. Catálogo fijo de cinco voces

`src/lib/voices/catalog.ts`. El catálogo NO cambia solo; cambiarlo es
editar ese archivo. Una voz que falla nunca se sustituye en silencio.

| Id | Perfil | voice_id | Idiomas | Uso 1 año (caracteres) | Clonaciones | Posiciones medidas | F0 mediana (preview) |
|---|---|---|---|---|---|---|---|
| mateo | La de siempre (A/B previa) | uYlzyj2kIZo3HfBB21vF | es, en | — | — | ya en My Voices | 122 Hz |
| miguel | M1 grave, cinematográfica | k8cFOyAg7B9qwBlDDNTC | es, en ✓ | 913.499.655 | 449.296 | ♂ uso #12, clonaciones #7, búsqueda «deep» #2 | 84 Hz |
| mauricio | M2 natural, conversacional | 94zOad0g7T7K4oa7zhDq | es, en ✓ | 675.403.815 | 115.213 | ♂ uso #14, tendencia #25, «conversational» #2 | 150 Hz |
| norah | F1 cálida, podcast | kcQkGnn0HAT2JRDQ4Ljp | es, en ✓ | 9.691.289.479 | 85.553 | ♀ uso #2, tendencia #6, «conversational» #2 | 213 Hz |
| tatiana | F2 firme, narrativa | 2rigMbVWLdqtBSCahJFX | solo es | 2.982.109.100 | 138.724 | ♀ uso #4, clonaciones #5, «narrative_story» #1 | 170 Hz |

✓ = inglés verificado por ElevenLabs con `eleven_multilingual_v2` (el
modelo que usamos). Las cuatro nuevas: `rate` 1, sin `fiat_rate`, aviso de
retiro de 730 días (garantía de disponibilidad), `free_users_allowed`.

Fuente: `scripts/elevenlabs-voice-catalog-research.ts` (solo lectura,
`GET /v1/shared-voices` ordenado por `usage_character_count_1y`, `trending`
y `cloned_by_count`, por género, más búsquedas por caso de uso), run
36261382375 (previews y tablas en su artefacto). Son métricas de la
biblioteca, no una lista promocional.

**Por qué no las más usadas en cada caso**
- ♂ #1 Fernando Martínez («Rapid, Persuasive») y #2 Alberto Rodríguez
  (105 Hz): ninguno es tan grave como Miguel (84 Hz) para el perfil
  cinematográfico; Fernando es rápido y persuasivo, no conversacional.
- Antonio (♂ «conversational» #1): 124 Hz, casi igual a Mateo (122 Hz) y
  sin inglés verificado; Mauricio se diferencia (150 Hz).
- Alejandro Durán: **recargo** (`rate` 2, `fiat_rate` 0,2) y no apto para
  cuentas gratuitas → descartado.
- ♀ #1 Cristina Campos: preview a −32,6 LUFS (muy baja) y sin inglés.
- Andrea: sin garantía de disponibilidad (`notice_period` vacío).
- Tatiana no tiene inglés verificado: en inglés se muestra deshabilitada
  con el motivo. Alternativa con el mismo problema: Lumina (es-CO).

**Pendiente antes de activarlas:** agregar las cuatro a My Voices (hoy
`GET /v1/voices/{id}` → 400; Mateo → 200). Gratis, no ocupa espacios
(plan Starter: `voice_slots_used` 0/10, confirmado antes y después del
plan). Workflow `voice-catalog-add.yml` con `mode=add`, `confirm=true`;
idempotente, nunca elimina, falla sin sustituir si ElevenLabs devuelve
otro `voice_id` o aparece un recargo. El plan de solo lectura corre en
cada PR que toca el catálogo.

**Dónde se elige:** Nuevo video (Reel; Avatar cuando la narración la
sintetiza ElevenLabs) y Texto a voz. Long Form no expone selección (sigue
con Mateo). Sin elección o con Mateo, la solicitud y la clave de caché de
voz son idénticas a las de antes.

## 2. Texto a voz (`/dashboard/tts`, `TEXT_TO_SPEECH_ENABLED`)

Título, texto, idioma, voz (un narrador por pieza), duración y consumo
estimados en vivo, historial con reproductor, descarga MP3 y reintento.

- **Fragmentos** (`src/lib/tts/segment.ts`): por párrafos y oraciones, ≤900
  caracteres, nunca a mitad de palabra; pausa de 650 ms entre párrafos y
  180 ms dentro de un párrafo; `previous_text`/`next_text` para mantener la
  entonación.
- **Worker** (`tts.yml`, evento `text-to-speech`; `render.yml` no cambia):
  reclamo condicional, voz y propiedad comprobadas otra vez, caracteres de
  la cuenta consultados antes de gastar, cada fragmento por la caché de
  voz + registro de gasto (un fragmento generado no se vuelve a pagar; uno
  incierto no se repite), unión con ffmpeg, marca de fallo si se corta.
- **Doble envío**: `client_request_id` único por usuaria → misma pieza.
- **Límites iniciales**: 3.000 caracteres por pieza (≈3-4 min) y 6.000 por
  usuaria y mes (`TTS_MAX_CHARS_PER_PIECE`, `TTS_MAX_CHARS_PER_USER_MONTH`).
  Motivo: la cuenta Starter comparte su cuota con toda la narración del
  producto; el 2026-09-26 quedaban 14.888 caracteres hasta el 16-10.

## 3. Mi voz (`/dashboard/voices`, `MY_VOICE_ENABLED`)

Muestra (grabar en el navegador o subir MP3/M4A/WAV/WEBM/OGG, ≤10 MB,
30 s-3 min) → dos declaraciones de consentimiento versionadas
(`VOICE_CONSENT_VERSION`) → clonación instantánea → prueba corta → voz
privada seleccionable.

- **Propiedad**: crear, reintentar, usar y eliminar comprueban el usuario
  de la sesión en el servidor; una voz ajena enviada por id falla igual que
  una inexistente. Las voces privadas nunca se listan a otra usuaria ni en
  el catálogo general. Claves del proveedor solo en servidor y workers.
- **Worker** (`voice-clone.yml`, evento `clone-voice`): duración medida con
  ffprobe, espacio de clonación comprobado antes de enviar, nombre neutro
  en ElevenLabs (nunca el de la usuaria), `voice_id` guardado al instante.
  Rechazo del proveedor → reintentable. Fallo incierto (red, respuesta
  rota, worker cortado durante la clonación) → `needs_review`, no se repite
  (pudo crear una voz y ocupar un espacio).
- **Muestra original**: se borra al terminar salvo que la usuaria marque
  «conservar»; si algo falla se conserva para reintentar; se borra al
  eliminar la voz.
- **Eliminar**: primero `DELETE /v1/voices/{id}` (si falla, nada se borra),
  luego muestra y prueba. Videos y audios ya generados no cambian; una
  pieza pendiente con esa voz se detiene con el motivo.
- **Caché**: la clave incluye propietaria, voz, texto, idioma, modelo,
  ajustes, velocidad y contexto de fragmentos.
- **Capacidad**: la cuenta Starter admite 10 voces clonadas en total
  (compartidas por todas las usuarias). `MAX_USER_VOICES_PER_USER`=1. No se
  cambia la suscripción ni se borran voces para liberar espacios.

## 4. Activación (nada hecho; requiere revisión)

1. Aplicar `supabase/migrations/0021_voices_and_text_to_speech.sql` con
   `apply-supabase-migration.yml` (aditiva; rollback en el propio archivo).
2. Agregar las cuatro voces a My Voices (`voice-catalog-add.yml`, gratis).
3. Encender en Vercel, según se apruebe: `VOICE_CATALOG_ENABLED`,
   `TEXT_TO_SPEECH_ENABLED`, `MY_VOICE_ENABLED`.
4. Los workers `tts.yml` y `voice-clone.yml` usan los secrets existentes
   (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ELEVENLABS_API_KEY`) y el
   mismo `GH_WORKER_TOKEN`/`GH_WORKER_REPO` que el render.
