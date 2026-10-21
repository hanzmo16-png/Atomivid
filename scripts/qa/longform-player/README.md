# QA local: continuidad del reproductor Long Form

Prueba `LongFormResult` (el componente real, montado por `ResultView`) en Chromium, en escritorio (1280×800) y móvil (412×915, táctil). Costo USD 0: no hay red externa, Supabase ni proveedores.

## Qué es simulado
- **Control de propietario:** la página de prueba `src/app/dev/player-qa` (creada por `setup.sh`, nunca se commitea) asigna `u1 → a` y `u2 → b` y responde `notFound()` a cualquier otro par. Hace lo mismo que `src/app/dashboard/videos/[id]/page.tsx`, que no se modifica; su filtro real lo cubre `selectIfOwned` en `access.test.ts`.
- **Firma de Storage:** cada render del servidor devuelve `…/qa-media/{v}.mp4?token=sig-N` con N creciente. Se fuerza un fallo de firma con `fail: true` en el archivo de estado.
- **Restricción de autoplay:** un `HTMLMediaElement.prototype.play` envuelto rechaza la siguiente llamada con `NotAllowedError`.
- **Medio renovado que no carga:** Playwright aborta las peticiones del token nuevo.
- **Medios:** se generan MP4 VP9/Opus con ffmpeg, porque el Chromium de Playwright no trae H.264/AAC. No se probó H.264 real ni Samsung Internet.

## Ejecución
```bash
scripts/qa/longform-player/setup.sh
echo '{"renders":0}' > /tmp/lfp/state.json   # mkdir -p /tmp/lfp/shots antes
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:9 NEXT_PUBLIC_SUPABASE_ANON_KEY=fake SUPABASE_SERVICE_ROLE_KEY=fake \
  QA_STATE_FILE=/tmp/lfp/state.json npx next dev --webpack -p 3141 &
# Cuando http://localhost:3141/dev/player-qa?v=a&as=u1 responda 200, reinicia el estado y ejecuta:
echo '{"renders":0}' > /tmp/lfp/state.json
PLAYWRIGHT_MODULE=playwright node scripts/qa/longform-player/qa.mjs /tmp/lfp verde
# Detén el servidor y limpia:
scripts/qa/longform-player/teardown.sh && rm -rf .next
```
- `qa.mjs` es la suite VERDE: 25 comprobaciones por viewport.
- `qa-red.mjs` es la misma suite adaptada al marcado de PR170 (sin `data-testid`), para la regresión ROJO sobre `1c89146`.

Las capturas quedan en `<stateDir>/shots/` y las peticiones de red en `<stateDir>/<label>-<viewport>-requests.json`, con tokens ocultos.
