# Auditoría funcional — Podcast Studio integrado (PR #228)

**USD 0.** Proveedores simulados en `127.0.0.1`. Sin merge, sin deploy, sin migraciones de producción, sin flags, sin secretos, sin requeues y sin llamadas de pago.

Borrador de arreglo (no fusionar): https://github.com/hanzmo16-png/Atomivid/pull/229  
Rama: `cursor/podcast-studio-audit-228-94b5`  
Candidato auditado (sigue en borrador): https://github.com/hanzmo16-png/Atomivid/pull/228

## SHAs

| Qué | SHA | Qué cubre |
| --- | --- | --- |
| Inicio pedido | `fa68400f16c277c86edb306b5d84078557a976ac` | Candidato: tren #224 @ `91da24be` + #227 @ `cc17b867`. El informe de cierre de #227 describe código verde en `797b8b0e`. |
| Punta del candidato al cerrar esta auditoría | `67fcd7e44af755338cc8afaf52abb49e470a65ad` | La punta se movió durante el trabajo. Encima de `fa68400f` entran #225 @ `44a3468` (`e27c0ada`), #226 @ `29faa64` (`e3f4190b`), hidratación de `voice_kind` (`53895625`) y el caso 12 del arnés (`67fcd7e4`). `origin/claude/candidato-podcast-studio` seguía en `67fcd7e4` al escribir este informe. |
| Árbol que se acepta para la siguiente etapa de mocks | `7e67dd15e210f11598938e3b0d60d10c52b3eff2` | Un commit encima de `67fcd7e4`. Reproduce y descarga desde la cuenta, y reintenta el inicio sin otro cargo. |

La evidencia de navegador y las pruebas unitarias de este informe se ejecutaron en `7e67dd15`. El delta `fa68400f..67fcd7e4` se releyó: HeyGen v3 y la confirmación de Long Form no cambian el asistente de estudio salvo el CSS de Recraft en Reels, que no es el flujo del podcast. Los defectos de la lista de la cuenta y del re-despacho seguían en `67fcd7e4` y se corrigen solo en `7e67dd15`.

## Veredicto

**GO** para la siguiente etapa: aceptación funcional del camino integrado con proveedores **simulados**, en el SHA `7e67dd15` (borrador #229, apilado sobre `claude/candidato-podcast-studio`).

Ese GO cubre, con mocks y base desechable: configurar (modalidad, voces, avatares, música, visuales), volver atrás y recargar sin perder el borrador, estimar y confirmar dentro del tope de USD 50, generar, fallar y reintentar el mismo episodio sin doble cargo, y reproducir y descargar desde la cuenta del dueño. Otra cuenta no recibe la voz privada ni los archivos.

**NO-GO** para autorizar producción. No se enciende `PODCAST_V3_ENABLED` en producción, no se aplica la migración propuesta, no se concede El Duro real y no se llama a ElevenLabs, HeyGen, Pexels ni fal.ai de pago.

**NO-GO** del candidato tal como está en `67fcd7e4`, sin #229. En esa punta el asistente sí reproduce antes de reiniciarse, pero «Tus episodios» no ofrece reproductor ni descarga, y un segundo worker puede marcar el episodio `failed` mientras el primero sigue.

#228 permanece borrador. #229 permanece borrador. No se fusiona ninguno.

## Hallazgos

### P0

Ninguno abierto en `7e67dd15`.

### P1 — la cuenta no reproducía ni descargaba (corregido en `7e67dd15`)

En `67fcd7e4`, `src/app/dashboard/podcast/page.tsx` listaba el episodio de estudio con título, estado y costo. El reproductor y la descarga vivían solo dentro del asistente. Tras «Empezar de nuevo» el episodio listo seguía en la cuenta y no se podía oír ni bajar.

Corrección: `StudioEpisodeList` consulta `GET /api/podcast/v3/:id`. `episodeAction` firma MP4 y audio solo si `status === "ready"`, solo para `user_id` del dueño, y solo si la ruta empieza por `${userId}/podcast-studio/${id}/`. El reproductor de la cuenta usa `studio-player` o `studio-audio-player` (solo audio no ofrece MP4).

Criterio de aceptación, cumplido en el arnés de `7e67dd15`: después de reiniciar el asistente, la tarjeta de la cuenta reproduce (`readyState >= 2`, `currentTime > 1`) y ofrece la descarga; el reproductor del asistente ya no está en la página. Caso 10a (solo audio) afirma que no hay enlace MP4.

### P1 — un inicio no confirmado no se podía repetir, y un segundo worker marcaba `failed` (corregido en `7e67dd15`)

En `67fcd7e4`, `authorizeAction` respondía 409 a cualquier episodio que no estuviera en `draft` o `failed`. Si el cargo ya estaba autorizado y `run_started_at` seguía vacío, no había forma de volver a pedir el mismo trabajo sin otro monto. Además, el worker aplicaba `status = "failed"` a cualquier excepción, incluida `DuplicateRunError`. El worker que perdía la carrera podía dejar el episodio en error mientras el ganador seguía o ya había entregado el archivo.

Corrección:

- Si `status === "authorized"` y `run_started_at` es null, y el cuerpo trae `confirm: true`, se llama solo a `dispatch`. No se vuelve a ejecutar `authorize`. Sin `confirm`, 400.
- `studioRunErrorFailsEpisode` devuelve falso para `DuplicateRunError`. El worker registra `STUDIO_DUPLICATE` y sale sin tocar el estado.
- El botón de la cuenta dice «Volver a pedir el inicio (no se cobra otra vez)» para no chocar con el «Reintentar» del fallo de proveedor (caso 12).

Criterio de aceptación, cumplido: la prueba «API: autorizado sin arranque se re-despacha sin volver a autorizar ni cambiar el monto» y «una segunda generación del mismo episodio no marca el episodio como fallido». El caso 12 del arnés sigue mostrando un solo episodio, `dup=0` y la operación ya pagada reutilizada.

### P2 — Recraft del estudio no está hecho

Una opción deshabilitada no es una función terminada.

Hoy, sin `FAL_KEY` o sin `PODCAST_STUDIO_RECRAFT=1`, `visualProviders` deja Recraft en `available: false` con el motivo de falta de clave y de adaptador. El default es Pexels. Elegir Recraft no avanza y la API responde 409 (`requireProvider`), sin sustituir el proveedor. Eso es fail-closed y el arnés lo afirma en escritorio y en 390 px.

Lo que falta, y por qué no se enciende el flag:

| Capa | Estado |
| --- | --- |
| Código de Reels / Long Form | `src/lib/providers/image/recraft.ts` existe y lo usan esos flujos. No es el worker del estudio. |
| Código del estudio | `realImages` solo busca y descarga fotos (Pexels). No implementa `recreate`. `visualProviders` marca Recraft disponible si `FAL_KEY` y `PODCAST_STUDIO_RECRAFT=1` están puestos, aunque el worker no tenga adaptador. Con esos dos valores el asistente dejaría pasar Recraft y el pipeline no llamaría a fal.ai (`images.recreate` ausente) y caería a la foto de archivo. |
| Configuración | No se define `FAL_KEY` ni `PODCAST_STUDIO_RECRAFT` en esta pasada. |
| Validación con proveedor real | No hecha. Cero llamadas a fal.ai. |

Criterio para dar Recraft del estudio por hecho, fuera de este GO: un adaptador `recreate` en el worker del estudio, la disponibilidad en `true` solo cuando ese adaptador está conectado, una prueba con mock de fal que cuente una recreación y rechace la sustitución por Pexels, y después —con autorización de gasto de Hans— una corrida real. Hasta entonces la opción permanece no disponible.

### P2 — El Duro real no está hecho

| Capa | Estado |
| --- | --- |
| Código | `voiceAvailability` y `validateSpec` rechazan `CeFSZuaHs4SxcBxb9nCr` sin concesión y no sustituyen la voz. Con `PRIVATE_VOICE_GRANTS` de la forma `voiceId=email`, solo esa cuenta lo ve como clon y el episodio guarda `voice_kind: "clonada"`. Un catálogo vacío no degrada un clon ya guardado (`withVoiceKinds` en `53895625`, afinado en `7e67dd15`). |
| Configuración | El arnés concede solo el id ficticio `DuroPruebaLocal03=pilot-owner@local.test`. El id real se muestra deshabilitado: «No disponible: requiere autorización (PRIVATE_VOICE_GRANTS).» |
| Proveedor real | No se llama a ElevenLabs. No se afirma que el clon de Hans suene. |

### P2 — el workflow `podcast-3-0-e2e` no escucha este candidato

`pull_request.branches` de `.github/workflows/podcast-3-0-e2e.yml` incluye `claude/atomivid-mvp-setup-0079jv`, `main`, `claude/podcast-estudio-tope-ui` y `claude/pr200-sobre-201-199`. No incluye `claude/candidato-podcast-studio` ni la rama del arreglo. Por eso #229 no dispara ese workflow. La corrida de navegador de esta auditoría es local, con el mismo arnés (`scripts/harness/e2e/podcast/`).

## Qué aportan #225, #226 y #219

| PR | En este árbol | Aporta al Podcast Studio |
| --- | --- | --- |
| #224 @ `91da24be` | Sí, es ancestro. Sigue abierto, no fusionado a la rama por defecto. | Es el tren sobre el que se construyó el candidato. No es un flujo nuevo de estudio. |
| #227 @ `cc17b867` | Sí. Borrador abierto. El cierre que documenta `797b8b0e` está contenido. | Es el estudio: asistente, tope USD 50, voz clonada, Recraft fail-closed, arnés de casos 10 y 11. Esta auditoría no reabre ese cierre; comprueba el árbol integrado y añade lo que la cuenta todavía no hacía. |
| #225 HeyGen API v3 @ `44a3468` | Sí, vía `e27c0ada`. Borrador abierto contra la rama por defecto. | Listado de conciliación y webhook oficial de HeyGen. No genera un episodio de estudio. El avatar del estudio en esta pasada es `heygen-mock`. Hace falta para una corrida real de avatar, no para el GO de mocks. |
| #226 Long Form confirmar con el total del worker @ `29faa64` | Sí, vía `e3f4190b`. Borrador abierto contra la rama por defecto. | Confirmación de presupuesto de Long Form. No es el asistente de podcast. El merge trae también el CSS `min-w-0` / `max-w-full` de `ReelImageSourcePicker.tsx` (commit `0170dc4a` dentro de esa historia). Eso es el formulario de Reel, no el paso Visuales del estudio. |
| #219 Recraft móvil en Reel @ `fe09ab5d` | No. `fe09ab5d` no es ancestro de `fa68400f`, de `91da24be` ni de `7e67dd15`. El PR sigue abierto. | No aporta al podcast. El paso Visuales del estudio, medido aquí, no desborda a 390 px (0 px) sin ese commit. |

`git diff 7e67dd15` no toca `supabase/migrations`, `supabase/proposals` ni workflows de O3.

## CI del candidato `67fcd7e4`

Consultado el 27 oct 2026, sobre `claude/candidato-podcast-studio`. Las corridas de podcast E2E de GitHub seguían en curso al cerrar el informe; no se usan como prueba de `7e67dd15`.

| Workflow | Resultado en `67fcd7e4` | Lectura para el estudio |
| --- | --- | --- |
| `podcast-audiovisual-cierre` | success — https://github.com/hanzmo16-png/Atomivid/actions/runs/40436781377 | A favor del árbol integrado. No sustituye el arnés de navegación de los casos 10–12. |
| `spend-authorization-postgres` | success — https://github.com/hanzmo16-png/Atomivid/actions/runs/40436781343 | A favor. Libro y tope, base desechable. |
| `podcast-3-0-e2e` | en curso al cerrar (jobs `typecheck`, `regression` y `render` en success; job `e2e` sin conclusión) — https://github.com/hanzmo16-png/Atomivid/actions/runs/40436781415 | Corre el arnés **sin** el commit `7e67dd15`. No prueba la reproducción desde la cuenta. |
| `podcast-2-1-e2e` | en curso (`typecheck` y `regression` en success; `e2e` sin conclusión) — https://github.com/hanzmo16-png/Atomivid/actions/runs/40436781454 | Flujo clásico 2.1, no el asistente v3. |
| Reel total budget | success — run `40436781434` | Fuera del estudio. No bloquea. |
| Rescate motor editorial | success — run `40436781439` | Fuera del estudio. No bloquea. |
| E2E fixture evidence | success — run `40436781397` | Fuera del estudio. No bloquea. |
| `qa-m3-movil` | success — run `40436781402` | Móvil de otros formularios. El 390 px del estudio se midió en el arnés local. |

En #229 (`7e67dd15`) sí terminaron, en success: `spend-authorization-postgres` (run `40437234932`), Rescate (`40437234937`) y `qa-m3-movil` (`40437234926`). `podcast-3-0-e2e` no se encoló por el filtro de ramas descrito arriba.

## Pruebas ejecutadas en `7e67dd15` (USD 0)

Unitarias del estudio, sin red:

```text
node --import tsx --test --test-concurrency=1 \
  src/lib/podcast/v3/v3.test.ts \
  src/lib/podcast/v3/studio.test.ts \
  src/lib/podcast/v3/cierre.test.ts \
  src/app/dashboard/podcast/StudioEpisodeList.render.test.tsx
# tests 45 / pass 45 / fail 0

node --import tsx --test --test-concurrency=1 src/lib/podcast/v3/render.test.ts
# tests 11 / pass 11 / fail 0
```

Incluyen el re-despacho sin segundo `authorize`, `DuplicateRunError` que no marca `failed`, El Duro sin concesión, Recraft que no es el default y el render del reproductor de la cuenta.

Arnés de navegador (Postgres, PostgREST, gateway, ElevenLabs mock, Pexels mock y Next en localhost; `PODCAST_V3_PROVIDERS=mock`). Registro: `.e2e-local/out/audit-228.log` (no está en git).

```text
RESULTADO 236/236 PASS
POR_CASO {"10":93,"11":87,"12":56}
```

Caso 10 escritorio 1280 px (audio, narración, avatar, diálogo). Caso 11 en iPhone 13, Pixel 7 y Samsung 390×844. Caso 12 en escritorio y Samsung 390×844 (presupuesto de USD 60 bloqueado con el tope de USD 50, rechazo simulado 429, reintento del mismo episodio, `dup=0`, `reused=1`).

Comprobado en esa corrida, entre otras líneas PASS:

- Atrás y recarga conservan borrador y voz.
- El Duro real, sin concesión, sale deshabilitado y no se puede elegir. El texto es el de `PRIVATE_VOICE_GRANTS`.
- Recraft visible como no disponible, no preseleccionado; elegirlo no avanza. Desbordamiento del paso visuales: 0 px a 390, 412 y 1280.
- Sin confirmación explícita no se genera. El costo liquidado queda por debajo de lo autorizado (ej. caso 11 iPhone: 5.2396 / 10.0000; caso 12: 0.0315 / 10.0000).
- Lip-sync del caso 11: 33 segmentos, 0 violaciones. Planos general, sobre hombro y primeros planos presentes. Música en la mezcla (`atomivid-documental.wav` / `atomivid-misterio.wav`).
- MP4 H.264+AAC y MP3, loudness cerca de −16 LUFS y true peak ≤ −1 dBTP.
- Libro: cada operación una vez y liquidada. Re-despacho de un episodio listo no regenera ni cobra.
- Tras reiniciar el asistente, la cuenta reproduce y descarga (audio en 10a; MP4 en 10/11/12, incluido Samsung).

Capturas de esa corrida, copiadas al árbol:

- `artifacts/pr228-audit/samsung-390-voces.png`
- `artifacts/pr228-audit/samsung-390-visuales.png`
- `artifacts/pr228-audit/samsung-390-cuenta-reproducir.png`
- `artifacts/pr228-audit/samsung-390-reintento-reproducir.png`
- `artifacts/pr228-audit/desktop-reproducir.png`

Los casos 1–9 del mismo arnés no se repitieron en esta máquina. En GitHub, sobre `67fcd7e4`, el job `e2e` de `podcast-3-0-e2e` seguía en curso. No hay un fallo de estudio en esos casos dentro de esta pasada.

## Archivos del arreglo (`7e67dd15`)

- `src/app/dashboard/podcast/StudioEpisodeList.tsx` (nuevo) y `StudioEpisodeList.render.test.tsx`
- `src/app/dashboard/podcast/page.tsx`
- `src/app/dashboard/podcast/PodcastWizard.tsx` (etiqueta del botón y no degradar el tipo de voz)
- `src/lib/podcast/v3/api.ts`
- `src/lib/podcast/v3/pipeline.ts`
- `src/lib/podcast/v3/wizard.ts`
- `src/lib/podcast/v3/v3.test.ts`
- `scripts/podcast-3-0/studio-worker.ts`
- `scripts/harness/e2e/podcast/podcast-e2e.cjs`
- `package.json` (`test:podcast3` y `test:unit` incluyen el render de la lista)

Para integrarlo, Claude puede tomar el borrador #229. La base del PR es `claude/candidato-podcast-studio`. No se empujó a ramas `claude/*`.

## CI en `a761920c` (punta de #229 al cerrar la espera)

Los cinco checks de ese commit terminaron. Ninguno falló. No hubo nada que corregir de `7e67dd15`. #229 sigue en borrador.

| Workflow / job | Resultado | Run |
| --- | --- | --- |
| `qa-m3-movil` / `movil` | pass (5m26s) | https://github.com/hanzmo16-png/Atomivid/actions/runs/40438561631 |
| Rescate motor editorial / `rescate` | pass (2m37s) | https://github.com/hanzmo16-png/Atomivid/actions/runs/40438561605 |
| Vercel | pass | https://vercel.com/atomivid/atomivid/7F3ruwmqEwJQ9G1BbcPbYcyfFVw4 |
| Vercel Preview Comments | pass | https://vercel.com/github |
| `spend-authorization-postgres` / `verify` | pass (48s) | https://github.com/hanzmo16-png/Atomivid/actions/runs/40438561772 |
