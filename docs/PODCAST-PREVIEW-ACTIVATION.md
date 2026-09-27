# Activación de podcast en Preview — paquete revisable

**Estado (2026-09-27): aplicado solo en parte; activación pendiente.**

| Paso | Estado | Evidencia |
|---|---|---|
| 1. Migración 0022 | **Aplicada** | run 36286808790 |
| 2. Worker `tts.yml` fijado a `db4d200` | **No registrado**: el push fue rechazado | la rama por defecto sigue en `7772943` con `ref: 0a53459…` |
| 3. Variables del Preview de podcast | **No aplicadas** | sin acceso a Vercel desde la sesión |

No hay llamadas pagadas. No se fusionó ningún PR.

### Desviación: 0022 se aplicó con la activación pendiente

**Qué pasó.** Con la orden de aplicar el paquete, se ejecutó el paso 1 antes
de comprobar que los pasos 2 y 3 podían completarse:
- el registro del worker requiere modificar la rama por defecto;
- las variables requieren acceso a Vercel.

Ninguno de los dos pudo hacerse. El paquete quedó a medias: esquema nuevo,
worker anterior y Preview de podcast sin configurar. Lo correcto habría sido
confirmar antes que los tres pasos eran realizables, o avisar de que solo el
primero lo era.

**No se repite ni se revierte automáticamente.** Revertir exige decisión
propia: el bloque `ROLLBACK` del encabezado de 0022, solo si ninguna pieza
usa los campos nuevos.

**Resultado exacto** (run 36286808790, `apply-supabase-migration.yml` desde
`claude/tts-podcast` en `9dd5760`, `migration_file=0022_tts_podcast.sql`):
- antes: «1 migración(es) NO completamente aplicada(s): 0022 (not_applied)»,
  con 6 objetos de 0022 ausentes;
- durante:
  - «"0022_tts_podcast.sql" aplicada y confirmada correctamente»;
  - «Resumen: 1 aplicada(s) [0022_tts_podcast.sql], 0 reconciliada(s)
    sin reejecutar SQL [-], 0 ya registrada(s) [-]»;
- después: 123 comprobaciones con `exists: true` y 0 con `false`. Incluye
  las columnas `max_chars_per_piece`, `long_pilot`, `music_choice`,
  `mix_status`, `mix_path` y `mix_loudness`. 0021 sigue intacta.
- **No verificado individualmente**: el mapa de esquema no comprueba el
  CHECK ampliado del guion (1..60.000), los CHECK nuevos ni el índice
  parcial `tts_jobs_one_active_long_pilot`. Figuran como aplicados solo
  porque el script confirmó la migración completa.

**Compatibilidad con el worker que está registrado de verdad** (`0a53459`),
confirmada leyendo el código; no se ejecutó contra la base real:
- el worker y la app de voces (mismo código de «Texto a voz» en `1a0272d`)
  solo leen y escriben columnas anteriores a 0022: `id`, `user_id`,
  `title`, `language`, `voice_choice`, `script`, `characters`, `status`,
  `attempts`, `segments_done`, `segments_total`, `audio_path`,
  `duration_seconds`, `completed_at`, `error_message`, `updated_at`;
- las filas nuevas que crea la app de voces toman los valores por defecto
  de 0022: `music_choice 'none'`, `long_pilot false`, `mix_attempts 0` y
  el resto null. Cumplen los CHECK nuevos;
- el índice parcial solo afecta a filas con `long_pilot = true`, que ese
  código nunca escribe;
- el CHECK del guion pasa de 20.000 a 60.000 caracteres: amplía, y la app
  de voces sigue limitando a 20.000.
- Consecuencia: el Preview de voces debería seguir igual. Se confirmará con
  la próxima pieza real que se genere.

### Paso 2 rechazado por el control de permisos

- Se intentó llevar a la rama por defecto los dos commits de esta rama
  (`2a347a1`, `ed266c4`).
- El control de permisos de la sesión lo rechazó como **modificación de un
  recurso compartido**: la rama por defecto ejecuta el worker de todas las
  piezas de «Texto a voz», también las del Preview de voces.
- Una lectura posterior del estado también fue rechazada, sin motivo
  indicado.
- No se reintentó por otra vía. El cambio queda como diff revisable en esta
  rama; lo aplica quien tenga la decisión.


Código revisado: PR #17, rama `claude/tts-podcast`, commit
**`db4d20020eb1f76c4824235d653b1df484948097`** (incluye PR #16). CI:
run 36281394446, en verde en el intento 2. El intento 1 falló solo en la
prueba intermitente de la masterización compartida (`audio-master.ts`), que
sigue **sin resolver**; ver `docs/PODCAST.md` §6.

El paquete tiene tres pasos, en este orden. Cada uno requiere autorización
y se puede revertir por separado.

| Paso | Qué cambia | Dónde | Afecta a |
|---|---|---|---|
| 1. Migración 0022 | Columnas y restricciones nuevas en `tts_jobs` (aditiva) | Supabase compartido con producción | Solo filas nuevas de `tts_jobs`; nada existente cambia |
| 2. Worker `tts.yml` fijado a `db4d200` | El único commit de esta rama | Rama por defecto (registro) | Toda pieza de «Texto a voz», también las del Preview de voces |
| 3. Variables del Preview de podcast | Flags de la rama `claude/tts-podcast` | Vercel, alcance Preview + rama | Solo el Preview de `claude/tts-podcast` |

## Paso 1 — Migración 0022

- Workflow: `apply-supabase-migration.yml`, ya registrado.
  - «Use workflow from»: rama `claude/tts-podcast`. Hoy apunta a
    `9dd5760`, que es `db4d200` más una herramienta de verificación; el
    archivo 0022 es idéntico;
  - `migration_file`: `0022_tts_podcast.sql`.
- Con `migration_file` se aplica **solo** 0022. Nunca vacío: aplicaría
  cualquier otra migración pendiente.
- Qué hace: amplía el CHECK del guion (1..60.000), agrega 11 columnas
  nullable o con valor por defecto, 3 CHECK nuevos y un índice único parcial.
  No reescribe datos.
- **Comprobado sin gasto**:
  - el detector de SQL destructivo del workflow encuentra 0 líneas
    bloqueantes en 0022;
  - `migration-schema-map.ts` de esa rama incluye 0022, así que el workflow
    verifica el esquema antes y después;
  - 0021 ya está aplicada (run 36267136646) y no se repite.
- Filas que siga creando la app de voces: no envían las columnas nuevas y
  la base pone los valores por defecto. `music_choice 'none'`,
  `long_pilot false`, `mix_status null` y `max_chars_per_piece null`
  cumplen los CHECK nuevos.
- El worker registrado hoy (`0a53459`) no lee las columnas nuevas: sigue
  funcionando igual hasta el paso 2.
- Reversión: el bloque `ROLLBACK` del encabezado de 0022, solo si ninguna
  pieza usa todavía los campos nuevos.

## Paso 2 — Worker fijado al commit revisado

Esta rama (`claude/podcast-preview-activation`) contiene **un solo commit**
sobre la rama por defecto. Solo cambia `.github/workflows/tts.yml`:

- checkout `0a53459…` → `db4d20020eb1f76c4824235d653b1df484948097`;
- `timeout-minutes` del trabajo 20 → 60 y del paso 15 → 52;
  `TTS_WORKER_BUDGET_SECONDS=2700`.

Quedó idéntico al `tts.yml` revisado en `db4d200`, salvo el commit fijado.
Registrar = llevar este commit a la rama por defecto
(`claude/atomivid-mvp-setup-0079jv`).

**No cambia**:
- `voice-clone.yml` sigue fijado a `0a53459`: clonar, borrar y la voz
  «Hans podcast» no se tocan;
- `render.yml`, Reel, Avatar y Long Form no cambian.

**Solo después del paso 1**: el worker nuevo lee las columnas de 0022. Sin
ellas, la lectura de la pieza falla antes de reclamarla: la pieza se queda
«en cola», sin avanzar y sin gasto, hasta que se aplique 0022 y se
reintente.

### Efecto sobre el Preview de voces que usa Hans

Solo hay un worker de «Texto a voz». Tras este paso, las piezas que Hans
cree desde el Preview de voces (`claude/voices-medieval-tts`) también las
procesa `db4d200`. **Verificado sin gasto**
(`scripts/ui-verification/voices-preview-compat.ts`: la app de voces real
con `next dev`, el worker nuevo, Supabase simulado y la voz de prueba):

Resultado: **10 comprobaciones correctas, 0 fallos** (rama de la
herramienta: `claude/tts-podcast`; app de voces: `1a0272d`, la que usa el
Preview de voces).

- Filas con la forma exacta del insert de la app de voces, más los valores
  por defecto de 0022, procesadas por el worker `db4d200`:
  - con voz del catálogo: `completed`, `narracion.mp3`, sin mezcla;
  - con una voz propia (`custom:<id>`, como «Hans podcast»): igual.
- La página «Texto a voz» de la app de voces muestra 3 piezas (una
  anterior con `audio.mp3` y las dos nuevas), cada una con reproductor y
  «Descargar MP3».
- Las tres descargas son MP3 válidos.
- No aparece ningún control de podcast (música, mezcla).
- «Mi voz» sigue mostrando la voz propia.
- Sin errores en la consola del navegador.

No cubre la voz real de ElevenLabs ni la creación desde la interfaz de
voces (esa ruta no depende del worker; su compatibilidad con 0022 es la de
las columnas descritas en el paso 1).

Qué cambia para esas piezas:
- la narración pasa a nivelarse entre fragmentos y a masterizarse
  (−19 LUFS, pico real ≤ −1,5 dBTP);
- el archivo nuevo se llama `narracion.mp3` en lugar de `audio.mp3`; la app
  de voces lo encuentra por `audio_path`;
- las piezas anteriores no se tocan.

La app de voces no ofrece música, así que nunca crea mezclas.

Reversión: volver a fijar `0a53459` con los tiempos anteriores (un commit en
la rama por defecto). Las piezas ya generadas con `db4d200` siguen
reproduciéndose con cualquiera de las dos apps.

## Paso 3 — Variables del Preview de podcast (Vercel)

Alcance: **Preview**, rama **`claude/tts-podcast`** únicamente. No se edita
ninguna variable de Production ni de la rama `claude/voices-medieval-tts`.

| Variable | Valor | Para qué |
|---|---|---|
| `TEXT_TO_SPEECH_ENABLED` | `true` | Sección «Texto a voz» |
| `TTS_MUSIC_ENABLED` | `true` | Sin música / Suspenso / Documental |
| `MY_VOICE_ENABLED` | `true` | Mostrar «Hans podcast» en el selector |
| `MY_VOICE_ALLOWLIST_EMAILS` | cuenta de Hans | Solo Hans ve y usa su voz |
| `GH_WORKER_REPO` | `hanzmo16-png/Atomivid` | Encolar el worker |
| `NEXT_PUBLIC_SITE_URL` | URL del Preview de `claude/tts-podcast` | Enlaces y redirecciones |

Mismos valores que el Preview de voces, más `TTS_MUSIC_ENABLED`.

**No se agregan**:
- `TTS_LONG_PILOT_*`: los episodios largos siguen apagados y aplican los
  límites generales de 3.000 por pieza y 6.000 al mes;
- `TTS_PROVIDER_RESERVE_CHARS` (vale 3.000 por defecto).

**Por confirmar en el panel de Vercel** (no visible desde aquí), igual que
para el Preview de voces:
- que Preview tenga `GH_WORKER_TOKEN`;
- que `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` y
  `SUPABASE_SERVICE_ROLE_KEY` sean del mismo proyecto que usan los secrets
  de GitHub.

Tras guardar las variables hay que volver a desplegar el Preview de
`claude/tts-podcast`. Reversión: borrar esas variables de la rama.

## Comprobaciones gratuitas después de cada paso

1. **Tras 0022**: el resumen del workflow muestra las columnas de 0022 con
   `exists: true`. El Preview de voces sigue listando las piezas de Hans.
2. **Tras el registro**: `tts.yml` de la rama por defecto muestra
   `ref: db4d200…`. No se dispara nada a mano.
3. **Tras las variables**: en el Preview de podcast, «Texto a voz» muestra
   las tres opciones de acompañamiento y el selector incluye «Hans podcast».
   Todavía no se genera nada.

La primera generación real es la prueba A (tope US$0,15), que tiene
autorización propia.
