# Preflight del worker de Audio Podcast Studio

T-20261119-0918-chatgpt-25. Gasto: **USD 0**. Solo archivos nuevos: no cambia el producto, ningún workflow existente, Premium ni datos.

## Qué prueba (y qué no)

`scripts/harness/audio-studio-worker-preflight/preflight.mts` ejecuta **el mismo CLI que corre en producción** (`scripts/audio-studio/worker.ts`, el de `.github/workflows/audio-studio-worker.yml`) con:

- **Storage desechable** (`fake-storage.mjs`): un Supabase Storage en 127.0.0.1, usado por el mismo cliente `supabase-js` y el mismo `storageStore` que producción. Rechaza los borrados.
- **Voz de demostración** espeak-ng y **FFmpeg locales**: los mismos que instala el worker.
- **Cortafuegos de proceso** (`net-guard.mjs`): cualquier conexión del worker fuera de 127.0.0.1 se bloquea y se anota.
- **Fallo inyectado** (`fake-espeak.sh`): el motor de voz falla en la llamada N para probar la reanudación.
- **Sin saltos silenciosos** (Z1): la ejecución normal exige que se hayan registrado las 45 comprobaciones esperadas.
- **Rechazos sin escrituras**: L3, L4, X1, X2 y X3 comprueban además que el Storage no recibió ninguna subida, y L4 que el proyecto ajeno queda intacto.

| Cubre | No cubre |
|---|---|
| Contrato del despacho API → GitHub (evento, payload solo con ids, sin token) | Sesión real de Hans en atomicvid.app |
| ES y EN, con 1 y 2 voces: el MP3 real se decodifica a 48 kHz y 192 kbps, −16 LUFS, pico ≤ −1 dBTP | Supabase de producción y secretos reales del runner |
| Música CC0 audible y voz ≥ 3 dB por encima (ducking) | Que Vercel tenga `GH_WORKER_TOKEN`/`GH_WORKER_REPO` |
| Fallo a mitad → «fallida» sin MP3; «Reanudar» reutiliza la voz ya generada | La voz real de ElevenLabs (requiere autorizar el importe) |
| Reinicio tras quedarse sin latido; remezcla sin volver a sintetizar | |
| Despacho duplicado → rechazado sin escrituras (idempotencia) | |
| Aislamiento por cuenta; archivar y restaurar sin borrar | |
| Rechazos: sin autorización, voz apagada (`off`), cuenta que no es la dueña, ids inválidos | |
| Cero red externa y gasto 0 | |

**Este CI no demuestra producción autenticada.** Eso solo lo demuestra el runbook de abajo.

Ejecución local (necesita `ffmpeg` y `espeak-ng`):

```bash
npx tsx scripts/harness/audio-studio-worker-preflight/preflight.mts --out /tmp/preflight
# Controles negativos: cada uno debe salir con 1 y fallar SOLO en su comprobación
npx tsx scripts/harness/audio-studio-worker-preflight/preflight.mts --out /tmp/neg-voz --control-negativo=voz  # falla A1: worker sin voz
npx tsx scripts/harness/audio-studio-worker-preflight/preflight.mts --out /tmp/neg-red --control-negativo=red  # falla N1: el worker intenta salir a internet (red-canary.mjs) y el cortafuegos lo bloquea y lo anota
npx tsx scripts/harness/audio-studio-worker-preflight/preflight.mts --out /tmp/neg-mp3 --control-negativo=mp3  # falla A2: el MP3 publicado no está; nunca se aprueba un MP3 ausente
```

Límite del cortafuegos: protege el proceso Node del worker (fetch y sockets, incluido TLS). FFmpeg y espeak-ng son binarios nativos que no pasan por él; el worker solo les entrega rutas locales.

En CI corre `.github/workflows/audio-studio-worker-preflight.yml`, que sube como artefacto la matriz, los logs, los MP3 y los SHA-256.

## Runbook de 10 minutos para Hans: la única prueba que falta (producción autenticada, USD 0)

**Antes:** no hace falta tocar nada. El worker usa la voz de demostración por defecto y solo con la cuenta dueña.

1. Desde el celular, entra a `https://atomicvid.app/dashboard/audio-studio` con tu cuenta.
2. Abre el episodio inicial («El día que entiendes que no puedes controlarlo todo») o crea uno nuevo de 5 minutos.
3. Comprueba que el editor muestra **«voz de demostración»** y un costo estimado de **USD 0.00**.
4. Marca la autorización del monto mostrado y pulsa **«Generar MP3»**. Anota la hora.
5. Espera de 3 a 8 minutos. El estado pasa de «En cola» a «Generando» y luego a «Listo». Puedes cerrar la app y volver.
6. Reproduce el MP3 y descárgalo. Después archiva el episodio y restáuralo.
7. Mándame la hora y una captura del resultado: «Listo», o el error si lo hubo.

**Qué compruebo yo después, sin gasto:**
- que exista una ejecución de `audio-studio-worker` para esa hora en GitHub Actions;
- que su log termine en `RESULTADO TERMINADA (voz de demostración, USD 0)`.

**Si falla:**
- **El estado se queda en «En cola» más de 10 minutos y no hay ejecución en Actions:** el despacho no salió. Faltan `GH_WORKER_TOKEN` o `GH_WORKER_REPO` en Vercel, o están mal; yo lo diagnostico.
- **La ejecución termina en `SIN_VOZ`:** el secreto `INTERNAL_PRODUCTION_OWNER_USER_ID` del repositorio no coincide con tu cuenta.
- **La ejecución termina en `FALLIDA`:** pulsa «Reanudar» (la voz ya generada no se repite) y mándame la hora.

**Rollback sin código:** variable de repositorio `AUDIO_STUDIO_VOICE=off`, que apaga la voz demo del worker. `AUDIO_STUDIO_DISABLED=1` en Vercel apaga el módulo entero.

## Rollback de este preflight

Descartar la rama `claude/audio-studio-worker-preflight`. No hay migraciones, cambios de producción ni archivos existentes modificados.
