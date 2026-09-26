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
modelo que usamos), comprobado otra vez el 2026-09-26 (run 36264831128,
solo lectura). **Mateo no tiene inglés verificado** con ese modelo (sus
idiomas verificados: es, it, pt, de, ru, hi, cs, el, id, ms, no, ko): se
mantiene en inglés porque ya narraba así en producción, pero no está
avalado por ElevenLabs. Tatiana: solo español verificado → sigue limitada
a español. Las cuatro nuevas: `rate` 1, sin `fiat_rate`, aviso de
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

## 4. Límites reales (cuenta ElevenLabs, 2026-09-26, solo lectura)

- Plan **Starter**, 38.002 caracteres por período; usados 23.114 → **quedan
  14.888 hasta el 2026-10-16 03:08 UTC**. `can_extend_character_limit=false`:
  no hay excedente; al agotarse, **toda** la narración (Reel, Avatar, Long
  Form y Texto a voz) falla hasta la renovación.
- Ritmo medio ≈ 15 caracteres/s ≈ 900 por minuto de audio (estimación; la
  duración real se mide).

| Pieza | Caracteres | % del período | Costo registrado (US$0,10/1.000) |
|---|---|---|---|
| Reel de 60 s | ≈ 900 | 2 % | ≈ 0,09 |
| Texto a voz 3.000 (máximo por pieza) | 3.000 (≈ 3,3 min) | 8 % | 0,30 |
| Episodio de 10 min | ≈ 9.000 | 24 % | ≈ 0,90 |
| Episodio de 20 min | ≈ 18.000 | 47 % | ≈ 1,80 |

- Hoy cabe **un** episodio de 10 min y **ninguno** de 20 min antes de la
  renovación. Con 38.002 por período, dos episodios de 20 min agotan la
  cuenta. **Episodios largos no son sostenibles en Starter**; habilitarlos
  requiere más caracteres (decisión de plan de Hans; no se cambió nada).
- Límite inicial propuesto para el piloto: 3.000 por pieza y 6.000 por
  usuaria y mes, con un máximo de 2 usuarias en el piloto (≤ 12.000 ≈ 32 %
  del período), dejando el resto a Reel, Avatar y Long Form.
- **Clonación**: `voice_limit=10` y `voice_slots_used=0` son de **toda la
  cuenta** (GET /v1/user/subscription), no por usuaria. Piloto: 1 voz por
  usuaria, 3 en toda la cuenta (`MAX_TOTAL_USER_VOICES`), acceso solo por
  lista (`MY_VOICE_ALLOWLIST_EMAILS`/`_USER_IDS`); al agotarse, mensaje
  claro y no se envía la muestra. Una clonación incierta sigue ocupando
  capacidad hasta revisarla.

## 5. Concurrencia

- Límite mensual de Texto a voz y cupos de voces propias: los aplica la base
  de datos en el INSERT con bloqueo (`pg_advisory_xact_lock`), no solo la
  comprobación previa de la aplicación. Probado con dos envíos simultáneos.
- Cuota de caracteres del proveedor: el worker descuenta lo que reservan
  otras piezas en curso y, si no puede consultar la cuota, no gasta.
- Espacios de clonación: el worker descuenta las clonaciones en curso.
- Límite conocido: Reel, Avatar y Long Form no reservan caracteres; una
  pieza larga lanzada a la vez que un Long Form puede encontrar la cuota
  agotada a mitad (se detiene; lo generado se conserva).

## 6. Activación (nada hecho; requiere autorización)

**Hecho clave**: `repository_dispatch` y `workflow_dispatch` solo disparan
workflows cuyo archivo exista en la **rama por defecto**
(`claude/atomivid-mvp-setup-0079jv`), y `repository_dispatch` ejecuta el
código de esa rama. Hoy no están ahí `tts.yml`, `voice-clone.yml`,
`voice-catalog-add.yml`, `session-validation.yml` ni
`medieval-horse-sample.yml`: tenerlos en el PR no basta.

1. **Registrar los workflows** en la rama por defecto (un commit solo con
   esos archivos, igual que Work registró `reel-animation-samples.yml`).
   Para probar antes de fusionar: variable del repositorio
   `VOICE_WORKERS_REF=<commit revisado del PR #16>` (tts.yml y
   voice-clone.yml lo usan en el checkout) y `PINNED_REF` en
   `medieval-horse-sample.yml`. Tras fusionar, vaciar `VOICE_WORKERS_REF`.
2. **Migración 0021**: `apply-supabase-migration.yml` con
   `ref=claude/voices-medieval-tts` y `migration_file=0021_voices_and_text_to_speech.sql`
   (solo esa: sin el nombre aplicaría también las pendientes de #13/#15).
   Aditiva; rollback en el archivo.
3. **My Voices**: `voice-catalog-add.yml` con `mode=add`, `confirm=true`
   (gratis, sin espacios; se detiene ante recargo o voice_id distinto; no
   borra voces; no cambia el plan).
4. **Flags solo en Preview** (Vercel): `VOICE_CATALOG_ENABLED`,
   `TEXT_TO_SPEECH_ENABLED`, `MY_VOICE_ENABLED` + `MY_VOICE_ALLOWLIST_EMAILS`
   (cuenta de Hans y cuenta de prueba A), `GH_WORKER_TOKEN`/`GH_WORKER_REPO`
   ya existentes. Producción sigue apagada.
5. **Validación con sesión** (`session-validation.yml`): etapa `free`
   primero; `tts` y `myvoice` solo con `confirm=GASTAR` y el paquete
   autorizado. Requiere dos cuentas de prueba (secrets
   `SESSION_USER_A_*`, `SESSION_USER_B_*`).
6. **Orden de integración** (sin fusionar todavía): #13 → #14 (Work) → #15
   → #16, cada uno con merge commit (no squash, para no duplicar cambios en
   los PR apilados), cambiando la base del siguiente a la rama por defecto
   tras cada fusión. #10 (codex/product-flow) es independiente.
