# Audio Podcast Studio 1.0

Módulo nuevo y aislado para crear podcasts **solo audio**. Ruta: `/dashboard/audio-studio`.

## Alcance de 1.0

- **Episodios**: monólogo (1 voz) o diálogo (2 voces), en **español o inglés**, con voces del idioma del episodio elegidas una por una y duración objetivo de 5 a 60 min (ver «Idioma y voces»).
- **Guion**:
  - se pega o se escribe en el editor;
  - «Generar estructura de guion» crea un esqueleto de secciones con pautas (sin IA ni costo);
  - guardado manual y automático;
  - control de revisión entre pestañas;
  - aviso al cerrar con cambios sin guardar.
- **Música inteligente** (biblioteca propia CC0 de Podcast 3.0, licencia comercial verificada pista por pista):
  - un ambiente por sección según el texto, con fundidos cruzados de 2 s entre secciones;
  - entrada y cierre;
  - atenuación (ducking) bajo la voz;
  - volumen configurable.

  Si un ambiente no tiene pista con licencia verificada, no se musicaliza y se explica. También existen los modos «un solo ambiente» y «sin música».
- **Generación del MP3** (worker):
  - voz por intervención, con pausas (0,5 s con la misma voz, 0,35 s al cambiar de voz, 1,2 s entre secciones);
  - mezcla con la música y máster a −16 LUFS con pico ≤ −1 dBTP;
  - exporte MP3 a 192 kbps y verificación con `ffprobe` y `ebur128` antes de publicar.

  Reutiliza sin modificarlos `assembleVoice`, `mixAndMaster` y `exportAudio` (`src/lib/podcast/v3/audio.ts`), `ffmpeg.ts` y `music-library.ts`.
- **Autorización expresa del gasto**: hay que marcar el monto exacto estimado, que debe caber en el tope del episodio. El servidor rechaza cualquier otro monto.
- **Sin doble cobro**:
  - cada intervención se guarda en caché (`tts/<sha256>.mp3`) antes de sumar su costo;
  - repetir, reanudar o remezclar nunca vuelve a sintetizar lo ya generado;
  - el gasto se detiene antes del cargo que excedería lo autorizado.
- **Recuperación**: tras un fallo del proveedor o una interrupción (sin latido durante 10 min), «Reanudar» continúa con la misma autorización.
- **Remezcla**: cambia la música sin regenerar la voz (costo 0).
- **Biblioteca de audio**:
  - solo los proyectos de la cuenta;
  - reproductor (`preload="none"`) y descarga del MP3 mediante URL firmada de 10 min;
  - «Archivados» separados;
  - archivar no borra nada.
- **Proveedores de voz**:
  - `AUDIO_STUDIO_VOICE=fixture` usa espeak-ng local («voz de prueba local»). Solo funciona fuera de producción (nunca con `VERCEL` ni `NODE_ENV=production`).
  - El adaptador real de ElevenLabs solo se activa con `AUDIO_STUDIO_PAID_TTS=1` **y** el mapa `AUDIO_STUDIO_ELEVENLABS_VOICES` (ver «Idioma y voces»).
  - `AUDIO_STUDIO_VOICE=demo` (o sin definir en producción; `off` la apaga): voz de demostración espeak-ng, USD 0, **solo para la cuenta dueña** (ver «Voz de demostración (solo la cuenta dueña)»).

  Sin esas dos condiciones la síntesis está **inactiva**: el editor lo avisa desde el inicio, no muestra la autorización de gasto, «Generar MP3» ni «Reanudar», y el servidor rechaza cualquier generación sin llamada ni cargo. Este documento **no afirma** si producción tiene hoy la síntesis activa: depende de configuración externa al código, que se comprueba en el entorno, no aquí.
- **Worker**: el worker en proceso (`AUDIO_STUDIO_WORKER=inline`) lo usan el arnés y el CI. En producción el modo es `github` (ver «Worker de producción»), y solo sintetiza si la síntesis real está activa.

### Primer episodio

El primer episodio se carga como proyecto editable para la cuenta interna del dueño:

- Título: «El día que entiendes que no puedes controlarlo todo».
- Idioma y voz: español; perfil `es-latam-m-profesional` (Víctor, masculina profesional, latinoamericano).
- Duración: objetivo 18 min; estimado 17.9 min.
- Costo estimado: unos USD 3.04, con un tope de USD 6.
- Guion original sobre estoicismo, en 15 secciones.

Su id es estable por cuenta, así que nunca se duplica ni pisa una versión editada.

## Aislamiento

- **Código**
  - El módulo vive en:
    - `src/lib/audio-studio/**`
    - `src/app/dashboard/audio-studio/**`
    - `src/app/api/audio-studio/**`
  - No importa nada de Podcast Studio Premium (`src/lib/podcast/**`, `src/app/dashboard/podcast/**`, `src/components/podcast/**`), ni proveedores, ni ledger. Una prueba lo verifica.
  - Fuera del módulo solo cambia `src/app/dashboard/layout.tsx`, con el enlace «Audio Podcast»: en la franja móvil (< 640 px) y en la barra desde 1024 px. Entre 640 y 1023 px no se añade a la barra porque la desbordaría y taparía la ayuda (defecto M3-1, prueba `qa-m3-movil`); allí se entra por `/dashboard/audio-studio`.
- **Datos**
  - No hay migraciones ni tablas nuevas.
  - Cada proyecto es un JSON en el bucket privado existente `videos`, bajo `audio-studio/v1/<id de cuenta>/<id de proyecto>.json`.
  - El estudio nunca lee, escribe ni borra fuera de ese prefijo. Ningún otro módulo lo usa.
- **Cuentas**
  - La ruta se construye solo con el id de la sesión autenticada. Los ids se validan como UUID, así que no admite `../`.
  - Otra cuenta recibe 404 al leer, editar, archivar o generar un proyecto ajeno.
  - Sin sesión: 401 en la API y redirección a `/login` en la página.
  - Las acciones POST/PUT exigen `Content-Type: application/json`, lo que frena los envíos cruzados desde otro sitio.
- **Acceso**: misma lista privada que Podcast y Long Form (beta y cuenta interna del dueño).

## Interruptor

`AUDIO_STUDIO_DISABLED=1` apaga a la vez:

- la ruta (404);
- la API (403);
- el enlace del panel.

No hace falta desplegar código. No es un secreto.

## Idioma y voces

- **Idioma del episodio**: `es` o `en`. Se elige al crear el episodio y se puede cambiar en el editor; cambiarlo no traduce el guion, reinicia las voces a las del nuevo idioma y exige una nueva autorización (cambia la revisión). Los proyectos guardados sin idioma se leen como español.
- **Catálogo curado** (`VOICE_PRESETS`): 4 perfiles en español (Víctor, Mateo, Ximena, Tiara Gogh) y 4 en inglés (Roger, Sarah, Callie, Matilda). En un diálogo cada participante elige su voz del idioma del episodio; una voz de otro idioma bloquea «Listo para generar».
- **Mapa `AUDIO_STUDIO_ELEVENLABS_VOICES`** (`perfil=voiceId`, separados por comas): los **4 perfiles en español son obligatorios**; los de inglés son **opcionales** (un perfil sin voz mapeada no está disponible).
- **Validación contra la cuenta real**: con la síntesis real activa, `GET /api/audio-studio/voices` (exige sesión) consulta `GET /v1/voices` de ElevenLabs (sin síntesis ni costo) y devuelve solo las voces configuradas, públicas y compatibles con cada modelo; nunca expone clones privados. El servidor vuelve a validar idioma y compatibilidad **antes de encolar y antes de sintetizar**: una voz no disponible se rechaza sin cargo, nunca se sustituye en silencio.
- **Estado de la síntesis**: la misma ruta responde `synthesis` = `real`, `local`, `demo` o `inactiva`, calculado con la misma función que usa el servidor para generar (`studioVoiceFor(user)` → `voiceAvailability`, con la cuenta autenticada). No devuelve valores de variables ni el motivo interno. Con `inactiva` no consulta al proveedor (0 llamadas salientes).
- **Guion en inglés**: además de «Voz 1:» / «Voz 2:», se admite «Voice 1:» / «Voice 2:».

## Modelo de voz: V4 Turbo y Multilingual v2

Cada proyecto elige su modelo en el editor («Modelo de voz»). **Los proyectos nuevos empiezan en V4 Turbo.** Los proyectos anteriores, sin modelo guardado, se leen como Multilingual v2 (legado): ningún proyecto cambia de modelo al leerse.

| Modelo | Rol | Tarifa usada en la estimación | Ajustes que se envían |
|---|---|---|---|
| `eleven_v4_turbo` | **Por defecto en proyectos nuevos** | `AUDIO_STUDIO_RATE_ELEVEN_V4_TURBO` si se comprobó en la cuenta (nunca menos que la de lista, USD 0,04/1K); si no, **la misma de v2** | stability, similarity_boost |
| `eleven_multilingual_v2` | **Respaldo explícito** y modelo de los proyectos anteriores | Tarifa efectiva de producción (`PRICING_ELEVENLABS_USD_PER_1K_CHARS`, nunca menos de USD 0,20/1K) | stability, similarity_boost, style, use_speaker_boost |

- **Sin descuentos no comprobados.** Mientras la tarifa real de v4 Turbo en la cuenta no esté comprobada, se estima igual que v2. El editor lo indica.
- **Autorización ligada al modelo.** La autorización de gasto guarda el modelo. El worker se niega a sintetizar con otro.
- **Sin cambio automático de proveedor ni de modelo.** Si v4 Turbo falla, el episodio queda «Falló» en v4 Turbo. Pasar a v2 es un botón explícito («Cambiar a Multilingual v2 (respaldo)»): borra la autorización vigente y exige una nueva. Así no hay doble cobro.
- **Caché separada.** Clave = proveedor + modelo + voz + texto + ajustes de síntesis. Los episodios en inglés añaden `language: "en"` a los ajustes de la clave, así que las claves en español son las mismas de siempre (la caché existente sigue valiendo). Cambiar cualquiera vuelve a sintetizar; igualdad nunca se paga dos veces.
- **Límite por solicitud.** 10.000 caracteres por intervención en ambos modelos. Una línea más larga bloquea «Listo para generar».

Presupuesto del episodio inicial (18 min, 15.182 caracteres):

| | Multilingual v2 | v4 Turbo |
|---|---|---|
| Estimación del estudio (tarifa efectiva/conservadora) | USD 3,04 | USD 3,04 |
| Solo referencia: precio de lista de la API | USD 1,22 | USD 0,61 |

### Comprobaciones (USD 0 y de pago)

- `audio-studio-elevenlabs-capacidades` (workflow, **solo GET**). Verifica en la cuenta real: v4 Turbo disponible, español, límite de caracteres, style y speaker boost, y voces compatibles. No sintetiza ni consume créditos.
- `scripts/audio-studio/ab-v4-turbo.ts fixture <dir>` (USD 0). Usa el extracto de 90 s (≈1.270 caracteres) de «El día que entiendes que no puedes controlarlo todo». Imprime el tope exacto del A/B real (`TOPE_AB_USD`).
- `audio-studio-ab-v4-turbo` (workflow manual, **de pago**). Usa la misma voz y el mismo texto, con una solicitud por modelo. Solo corre si `confirmar_usd` coincide exactamente con el tope. Requiere autorización adicional.

## Worker de producción

- `AUDIO_STUDIO_WORKER=inline`: solo local y CI (nunca con `VERCEL` ni `NODE_ENV=production`).
- `AUDIO_STUDIO_WORKER=github`: la API despacha el evento propio `audio-studio-render`, que lo atiende `.github/workflows/audio-studio-worker.yml` con ffmpeg real.
  - Reutiliza `GH_WORKER_TOKEN` y `GH_WORKER_REPO` sin modificarlos.
  - No comparte evento con Reels, Long Form ni Podcast Premium.
  - El payload lleva solo los dos UUID.
- El worker (`scripts/audio-studio/worker.ts`) **no genera nada** salvo que se cumplan las tres condiciones:
  - la variable de repositorio `AUDIO_STUDIO_PAID_TTS` vale `1` (su valor real no se documenta aquí: se comprueba en la configuración del repositorio);
  - existen `AUDIO_STUDIO_ELEVENLABS_VOICES`;
  - el proyecto trae una autorización guardada para el mismo modelo y monto.

  La voz fixture nunca se usa en producción. Única excepción sin pago: la voz de demostración (sección siguiente).
- Si el despacho falla, no se cobra: la generación queda en cola y, al vencer, se puede reanudar.

## Voz de demostración (solo la cuenta dueña)

Permite al dueño generar, escuchar y descargar un MP3 completo en producción **sin ElevenLabs y a USD 0**, con una voz sintética espeak-ng. No es la voz final y se rotula así en todas partes: «Voz de demostración — no es la voz final; USD 0».

- **Quién la ve**: solo la cuenta `INTERNAL_PRODUCTION_OWNER_USER_ID` (correo confirmado). Cualquier otra cuenta sigue exactamente igual que hoy: síntesis «inactiva», sin autorización ni «Generar MP3».
- **Precedencia**: si `AUDIO_STUDIO_PAID_TTS=1`, manda ElevenLabs (o su error de configuración); la demo nunca reemplaza en silencio la voz de pago. La voz fixture sigue prohibida en producción.
- **Qué cambia en el editor**: `synthesis: "demo"`, aviso visible con el rótulo, costo estimado y tarifa USD 0.00, confirmación «por USD 0.00» y botón «Generar MP3 de demostración». El audio producido guarda `provider: "demo"` y la biblioteca y el editor lo marcan con el rótulo.
- **Por qué funciona en producción sin abrir la voz fixture**: `demoVoice` (en `src/lib/audio-studio/voice.ts`) llama a `espeak-ng` de forma explícita; no usa `espeakVoice` de Podcast ni `fixtureVoice`, que siguen negándose con `VERCEL`/`NODE_ENV=production`. Su proveedor se llama `demo-espeak` (la caché nunca se mezcla con ElevenLabs).
- **Gasto**: la autorización se guarda con USD 0. El worker solo acepta un monto 0 con la voz demo; con voz de pago un monto 0 se sigue rechazando.
- **Worker**: el runner instala `espeak-ng` y solo usa la demo si el dueño del proyecto es `INTERNAL_PRODUCTION_OWNER_USER_ID`; en otro caso imprime `RESULTADO SIN_VOZ`.

**Activación**: no requiere configuración. Tras el deploy, en producción (Vercel) la demo queda encendida para la cuenta dueña aunque `AUDIO_STUDIO_VOICE` no exista, y el worker pasa a `github` si `AUDIO_STUDIO_WORKER` no existe y están `GH_WORKER_TOKEN`/`GH_WORKER_REPO` (los del worker de video). El runner toma `AUDIO_STUDIO_VOICE` de la variable de repositorio o `demo` por defecto, y el dueño de la variable `INTERNAL_PRODUCTION_OWNER_USER_ID` o, si no existe, del secreto ya existente (no se modifica). Ninguna otra cuenta dispara el worker: sin voz, `startWorker` devuelve «apagado».

**Desactivar / revertir sin código**: `AUDIO_STUDIO_VOICE=off` en Vercel (redesplegar) y como variable de repositorio; `AUDIO_STUDIO_WORKER=off` apaga el despacho. El estudio vuelve a «inactiva». Los MP3 de demostración ya generados quedan en la biblioteca marcados como demo; un episodio en cola con autorización USD 0 no se procesa con voz de pago (el worker lo rechaza). Para quitar el código: `git revert -m 1` del merge.

| Voz de demostración | `src/lib/audio-studio/voz-demo.test.ts`, `src/app/dashboard/audio-studio/voz-demo.render.test.tsx` | Matriz dueño/cliente/producción/precedencia, USD 0 de punta a punta, preflight, CLI y workflow, render real en modo demo con `NODE_ENV=production`, rótulos en editor y biblioteca |
| E2E | `scripts/harness/e2e/audio-studio/audio-studio-e2e.cjs` | Ver abajo |

El E2E corre en Samsung 390×844 y en escritorio 1440×900, con un arnés local sin red externa. Cubre:

- enlace en el panel y episodio inicial;
- creación y guardado de episodios, con conservación tras recargar;
- guardado automático y conflicto entre pestañas;
- música y presupuesto;
- generación bloqueada hasta autorizar; estado de síntesis «local» informado por la ruta de voces y visible en el editor;
- archivar y restaurar;
- aislamiento entre cuentas por interfaz y por API;
- 401 sin sesión y 415 para envíos que no son JSON;
- portada, Podcast Premium, Long Form y Facturación siguen respondiendo;
- ningún archivo previo del Storage local borrado;
- ninguna salida a proveedores reales.

CI: `.github/workflows/audio-podcast-studio.yml`.

## Verificación en producción

`.github/workflows/audio-studio-produccion.yml` se lanza manualmente después del despliegue. Cuesta USD 0.

- **`publico`**: sin sesión ni secretos, en escritorio y con agente de móvil. Comprueba:
  - la ruta, que redirige a `/login`;
  - la API, que responde 401;
  - el envío que no es JSON, que responde 415;
  - que los módulos anteriores siguen respondiendo.
- **`episodio`**: deja cargado el episodio inicial del dueño de forma idempotente y lo relee.
  - Usa los secretos ya existentes `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e `INTERNAL_PRODUCTION_OWNER_USER_ID`, sin modificarlos.
  - Solo escribe bajo `videos/audio-studio/v1/<dueño>/`.
