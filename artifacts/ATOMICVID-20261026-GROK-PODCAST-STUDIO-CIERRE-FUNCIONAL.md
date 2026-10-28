# Podcast Studio — cierre funcional (Grok)

**Estado: borrador #227. NO FUSIONAR sin Hans. NO-GO de producción.**

Rama `cursor/podcast-studio-cierre-5d3a`, encima de #222 @ `98848a63`. https://github.com/hanzmo16-png/Atomivid/pull/227

Base de este trabajo: cabeza de #222 `98848a633b92206fd41fe332d0886887e7395b76` (`claude/podcast-estudio-tope-ui`, tope USD 50 apilado sobre #207 @ `d8b203d`). No se partió de `762714e`: esa punta no tiene Podcast Studio.

Presupuesto de esta pasada: **USD 0**. Todo lo ejecutado aquí usa proveedores simulados en `127.0.0.1`. No hay deploy, no hay merge, no hay llamadas de pago, no hay secretos en el diff.

## RESUELTO / YA CUBIERTO (PR + SHA + runs)

| Tema | Dónde queda | Qué se comprobó en esta punta |
| --- | --- | --- |
| Tope USD 50 en «Presupuesto» | #222 @ `98848a63` (esta base) | El asistente ya rechaza > 50 antes del 402. No se reabre. |
| M2 mocks del estudio | #217 @ `d0e91f0` (ChatGPT APROBADO, según el encargo) | No se reescribe. |
| T2 tren de modos, música, atrás, errores/reintentos, play/descarga | #221 @ `d6d7da2`, informe 183/183 | No se reescribe. En esta punta el arnés `scripts/harness/e2e/podcast/podcast-e2e.cjs` sigue cubriendo esos pasos y aquí se añadieron aserciones, no un arnés paralelo. |
| Formulario clásico Samsung 390 + descarga de escritorio | #202 `qa-aceptacion-ux` | Fuera de este diff. |
| Concesión de voz privada (#167) | `src/lib/voices/private-voices.ts` + `voiceAvailability` en `src/lib/podcast/v3/spec.ts` | **Sin concesión**, la UI ya mostraba y sigue mostrando la opción deshabilitada «El Duro (Hans) — No disponible: requiere autorización (PRIVATE_VOICE_GRANTS).». No se inventó otro texto. Con concesión al dueño, el catálogo visible ya incluía el clon; el fallo era el `voice_kind` (abajo). |
| Recraft sin FAL / sin adaptador de estudio | `visualProviders` en `src/lib/podcast/v3/studio.ts` | Fail-closed honesto: `available: false`, motivo con `FAL_KEY` y «el adaptador … aún no está conectado». El default del asistente es **Pexels**, no Recraft. Elegir Recraft bloquea el avance (409 / alerta) y no se sustituye. |
| Reintento sin doble cobro (libro) | `paidOnce` + `src/lib/podcast/v3/render.test.ts` (reintento de avatar reutiliza; fallo incierto no vuelve a llamar) y, en el arnés, «re-despacho de un episodio listo no regenera ni cobra» | Cubierto en unitario y, en esta pasada, también en escritorio (`c10d`/`c10b`) y en Samsung (`c11-samsung`). |
| `yuv420p` del estudio | `src/lib/podcast/v3/compose.ts` y `mocks.ts` | Ya está en el encode del estudio. No había un defecto de Podcast Studio que corregir. |
| CSS móvil de Recraft en Reels (#219 @ `fe09ab5`) | `ReelImageSourcePicker.tsx`, **no** está en esta pila | No se copia ese PR. El paso visual del estudio, medido en esta punta, no desbordaba a 390 px (0 px). Se aplicó el mismo patrón `min-w-0` / `max-w-full` a los controles **del asistente** (selects, input de foto, tabla de presupuesto, motivos largos) para que el paso de voces —opción larga de El Duro— tampoco ensanche la página. |

## ASIGNADO A CLAUDE (no se toca)

- M2 (#217) y T2 (#221). Cerrados en su informe; este PR no los reabre.
- #223 / #225 / #226 (Long Form / HeyGen). No se editaron esas ramas.
- O2 / O3: ninguna migración ni SQL de esas líneas. `git diff` de este PR no incluye `supabase/migrations` ni `supabase/proposals`.
- RC4, Director emocional (`src/lib/podcast/v2/director.ts`) y una «pantalla de presupuesto a 699 px»: en esta punta no son defectos del asistente de Podcast Studio. `yuv420p` ya está en la composición del estudio. El 699 que aparece en docs es un SHA de preview (`docs/podcast-estudio/CHECKPOINT.md`), no un ancho de layout. Se dejan quietos.
- El Duro **real** de ElevenLabs y Recraft **real** (fal.ai). Siguen fuera de alcance: harían falta concesiones de producción y autorización de gasto de Hans.

## CORREGIDO EN ESTE PR

El asistente ofrecía el clon concedido (se podía elegir el id) pero **no escribía `voice_kind: "clonada"`**. `PodcastWizard` solo guardaba `voice_id`; el default del borrador es `"sintetica"`, y ese valor viajaba al episodio.

1. `voiceAvailability` marca `kind: "clonada"` en clones privados y en la fila deshabilitada de El Duro.
2. Al elegir una voz, el asistente guarda `voice_kind` con `voiceKindFor` / `withVoiceKinds` (también al rehidratar un borrador viejo).
3. `studioAction` vuelve a escribir el tipo al crear: si la voz del catálogo es privada y la concesión pasa, el episodio queda `clonada` aunque el cliente mande el default. Otra cuenta o concesión ausente sigue en **400**, sin sustituir la voz.
4. El arnés, en escritorio y en **390×844**, afirma: concesión simulada ON → el dueño elige `DuroPruebaLocal03` como `clonada` y el episodio lo conserva; id real `CeFSZuaHs4SxcBxb9nCr` sin concesión → opción deshabilitada, no seleccionable; otra cuenta → el clon no está en la lista y `POST /api/podcast/v3` responde 400.
5. Aserciones de layout en el paso voces y en el paso visuales (`scrollWidth - innerWidth <= 1`) a 1280 px y a 390 px. Atrás + recarga conserva la voz y `voice_kind`. Play + descarga del MP4/MP3 en Samsung. Re-despacho de un episodio listo no regenera.

Recraft no se reimplementa. No había preselección engañosa: el default ya era Pexels y la prueba de unidad lo fija (`defaultDraft().provider === "pexels"`).

## DEPENDENCIAS

No hay objetos llamados O7 u O8 en este árbol. Las dependencias reales del estudio, sin aplicarlas aquí:

- **Migración propuesta, no de producción:** `supabase/proposals/20261024140000_podcast_v3_studio.sql` (y su rollback). En el arnés se aplica solo a la base desechable. No se fusiona con este PR.
- **Flag de generación:** `PODCAST_V3_ENABLED=1`. Sin eso el estudio no despacha. En Preview de Vercel la UI puede verse (`studioFlag`) pero la generación real sigue apagada hasta la migración y el flag.
- **`PRIVATE_VOICE_GRANTS`:** formato `voiceId=email`. Sin entrada para `CeFSZuaHs4SxcBxb9nCr`, El Duro real se muestra no disponible. Con concesión, solo el email confirmado del dueño lo usa; otra cuenta no lo ve y la API lo rechaza. El arnés concede únicamente el id ficticio `DuroPruebaLocal03=pilot-owner@local.test`.
- **Recraft / FAL:** hace falta `FAL_KEY` **y** `PODCAST_STUDIO_RECRAFT=1`. Si falta cualquiera, el proveedor queda no disponible y no se cambia por otro. Este PR no enciende ese flag ni llama a fal.ai.
- **Voces de catálogo:** `ELEVENLABS_API_KEY` apuntando al mock local en el arnés. En producción la lista sale de ElevenLabs (GET de voces, sin síntesis en el paso de elección).

## Evidencia Samsung 390×844 + escritorio

Simulado, USD 0, `127.0.0.1`. Chrome headless del arnés. Viewport Samsung: **390×844**, `isMobile`, UA Android SM-S911B. Escritorio del caso 10: **1280×1000**.

Unitarias (sin red), en esta máquina:

```text
node --import tsx --test --test-concurrency=1 \
  src/lib/podcast/v3/v3.test.ts \
  src/lib/podcast/v3/studio.test.ts \
  src/lib/podcast/v3/cierre.test.ts
# tests 40 / pass 40 / fail 0
```

Incluyen: El Duro sin concesión no disponible; con concesión `kind: "clonada"` y el borrador lo guarda; otra cuenta oculta; API 200 para el dueño con `voice_kind` corregido a `clonada` aunque el cliente mande `sintetica`; API 400 para otra cuenta y sin concesión; Recraft no es el default; Recraft no disponible sin FAL.

Arnés de navegador (proveedores `PODCAST_V3_PROVIDERS=mock`, ElevenLabs y Pexels en localhost, espeak-ng, ffmpeg):

```text
bash scripts/harness/e2e/podcast/run.sh grok-cierre "10,11"
# Caso 10 (escritorio): todas las comprobaciones en verde, incluido
#   c10b voice_kind clonada en el borrador, tras atrás+recarga, y en el episodio
#   [["DuroPruebaLocal03","clonada"]]
#   c10d/c10b play MP4, descarga H.264+AAC, re-despacho sin regenerar
# Único FAIL de esa corrida: aserción nueva del arnés (otra cuenta en 390
# miraba el <option> antes de abrir el paso Voces). Corregida y repetida:

bash scripts/harness/e2e/podcast/run.sh grok-cierre-11 "11"
# RESULTADO 81/81 PASS
```

Samsung 390×844 (`c11-samsung`), todas PASS, entre ellas:

- portada y pasos voces / visuales: desbordamiento **0 px**
- El Duro real deshabilitado con el texto de `PRIVATE_VOICE_GRANTS`
- clon simulado concedido → `voice_kind: "clonada"`; atrás + recarga lo conserva; el episodio guardado queda `[["DuroPruebaLocal03","clonada"],["VozCatalogoLeo02","sintetica"]]`
- Recraft visible como no disponible, **no** preseleccionado; elegirlo no avanza
- reproductor MP4 16:9 (`t > 1`), descarga MP4 H.264+AAC y MP3, loudness cerca de −16 LUFS
- libro: 3 TTS `settled` una vez; re-despacho `STUDIO_NOT_AUTHORIZED` (no cobra otra vez)
- otra cuenta: no ve `DuroPruebaLocal03`; ve El Duro real deshabilitado; API 400; paso voces a 390 px con desbordamiento 0

Escritorio (caso 10, 1280 px): los mismos controles de voz, Recraft y desbordamiento 0 px. Play/descarga de audio (`c10a`) y de MP4 (`c10d`, `c10b`).

Capturas de esa corrida (también en el árbol, para la revisión):

- `artifacts/podcast-studio-samsung-390-voces.png`
- `artifacts/podcast-studio-samsung-390-visuales.png`
- `artifacts/podcast-studio-desktop-voces-el-duro.png`

El arnés de estudio **no** compara sha del MP4 con una columna (el episodio de estudio no guarda `audio_sha256`). El sha del flujo clásico sigue en los casos 2 y 9 del mismo archivo; no se ejecutaron en esta pasada porque no eran el defecto. Donde el arnés de estudio sí mide el archivo, se comprobó códec, duración de reproducción y loudness.

CI de GitHub: el workflow `podcast-3-0-e2e` solo disparaba contra `claude/atomivid-mvp-setup-0079jv` y `main`. Este PR apunta a la rama de #222, así que se añadió esa base (y `claude/pr200-sobre-201-199`) al `pull_request` del workflow. La corrida encolada al abrir #227 (https://github.com/hanzmo16-png/Atomivid/actions/runs/40430419331) quedó cancelada al llegar el arreglo de tipos. La corrida que vale es la de la tabla de abajo.

## Simulado vs real

| | Simulado (esto) | Real (no hecho) |
| --- | --- | --- |
| Voz «El Duro» | Id ficticio `DuroPruebaLocal03`, catálogo del mock, espeak-ng, USD 0. El id real `CeFSZuaHs4SxcBxb9nCr` solo se prueba como **no disponible** porque el arnés no lo concede. | Clon de ElevenLabs de Hans. Exige `PRIVATE_VOICE_GRANTS` de producción y gasto autorizado. **No probado. No se afirma que suene.** |
| Recraft | UI fail-closed sin `FAL_KEY` y sin `PODCAST_STUDIO_RECRAFT`. Ninguna imagen de fal.ai. | Adaptador del estudio sigue sin conectar. **No se afirma que Recraft genere imágenes del podcast.** |
| HeyGen / Pexels / ElevenLabs | Mocks locales. El libro anota `elevenlabs-mock`. | Cero llamadas a proveedores de pago en esta pasada (el arnés registra egress y el diseño rechaza salidas no locales). |
| Base de datos | Postgres desechable del arnés, propuestas aplicadas solo ahí. | Ningún proyecto Supabase de producción tocado. |
| Layout 390×844 y escritorio | Chromium headless con el viewport indicado, contra `next dev` en `127.0.0.1:3300`. | No es un teléfono Samsung físico ni un navegador de Hans. |

## CI en verde (SHA del arreglo de tipos)

SHA completo: `797b8b0ef940d8decc07a60f41377f5ba904631b` (`797b8b0e`). Borrador #227, sin merge y sin deploy de producción. El verde de estos checks no cambia el NO-GO.

| Check | Resultado | Corrida |
| --- | --- | --- |
| typecheck (`podcast-3-0-e2e`) | pass | https://github.com/hanzmo16-png/Atomivid/actions/runs/40431076417/job/121948793230 |
| regression (`podcast-3-0-e2e`) | pass | https://github.com/hanzmo16-png/Atomivid/actions/runs/40431076417/job/121948792944 |
| render (`podcast-3-0-e2e`) | pass | https://github.com/hanzmo16-png/Atomivid/actions/runs/40431076417/job/121948793448 |
| e2e (`podcast-3-0-e2e`) | pass | https://github.com/hanzmo16-png/Atomivid/actions/runs/40431076417/job/121948793146 |
| verify (`spend-authorization-postgres`) | pass | https://github.com/hanzmo16-png/Atomivid/actions/runs/40431076439/job/121948598412 |
| Vercel (preview) | pass | https://vercel.com/atomivid/atomivid/GEcm83BDghZVAULs8KzBAWaNF5nG |
| Vercel Preview Comments | pass | https://github.com/hanzmo16-png/Atomivid/runs/121949463095 |

Corrida `podcast-3-0-e2e`: https://github.com/hanzmo16-png/Atomivid/actions/runs/40431076417 — conclusión **success** (typecheck, regression, render, e2e). Corrida `spend-authorization-postgres`: https://github.com/hanzmo16-png/Atomivid/actions/runs/40431076439 — conclusión **success** (verify). La corrida anterior `40430419331` quedó superseded; la de `0bfb50b6` (`40430475066`) falló el typecheck y este SHA la sustituye.

## GO / NO-GO producción

**NO-GO.**

Este cierre demuestra el asistente con mocks. No autoriza encender `PODCAST_V3_ENABLED` en producción, aplicar la migración del estudio, conceder El Duro real, ni gastar en ElevenLabs, HeyGen, Pexels o Recraft. Hace falta la revisión de Hans y, aparte, una prueba con gasto autorizado si se quiere oír el clon real o generar imágenes Recraft.
