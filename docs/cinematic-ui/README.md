# Cinematic UI Experience 1.0

Rediseño de la entrada a ATOMIVID: portada `/dashboard` con fondo de video real, sistema visual premium, tarjetas de estudios, galería de producciones y navegación inferior en el teléfono. Referencia: issue #314.

Solo cambia la capa de presentación y navegación. No toca autenticación, suscripciones, créditos, Stripe, Supabase, motores, proveedores, trabajos en curso ni rutas.

## Qué hay

| Pieza | Archivo |
|---|---|
| Catálogo de ambientes | `src/components/cinematic/ambients.ts` |
| Fondo de video | `src/components/cinematic/CinematicBackground.tsx` |
| Portada | `src/components/cinematic/CinematicHero.tsx` |
| Estudios | `src/components/cinematic/StudioCards.tsx` + `studios.ts` |
| Galería | `src/components/cinematic/Showcase.tsx` + `showcase.ts` |
| Dock móvil | `src/components/cinematic/MobileDock.tsx` |
| Tokens y vidrio | `src/app/globals.css` (bloque «Cinematic UI 1.0») |

**Catálogo de ambientes.** Hay cinco: COSMOS, EPIC HISTORY, OCEAN DEEP, DARK MYSTERY y FUTURE WORLD.
- Solo se carga uno a la vez.
- Un ambiente sin material propio no finge video: muestra solo su degradado.

**Fondo de video.** Es un `<video>` silencioso, en bucle, en línea y sin controles.
- Póster: el servidor lo pinta con `<picture>`, sin esperar a JavaScript.
- Video: se monta después de `load`, cuando el navegador está libre.
- Pausa cuando la portada sale de pantalla o la pestaña se oculta.
- Con «reducir movimiento», ahorro de datos o 2G no hay video: queda el póster.
- Si el video falla, queda el póster.
- Al desmontar libera el archivo.

**Portada.** «Tu imaginación. Sin límites.» La llamada «¿Qué historia vamos a crear hoy?» baja a `#crear`, el selector real que abre cada flujo.

**Estudios.** Tienen las mismas rutas y los mismos permisos que el resto de la app. Sin acceso, la tarjeta dice «Disponible pronto» y no tiene enlace. Command Center solo aparece para el dueño.

**Galería.** Muestra solo producciones terminadas de la propia cuenta, con las URLs ya firmadas por el servidor.
- El título es el tema real; el género sale del formato y estilo guardados.
- La duración se mide del archivo. Si no se puede medir, no se muestra.

**Dock móvil.** Inicio, Estudios, Crear, Biblioteca y Perfil.
- Es `sticky` y va al final de la página: nunca tapa el último contenido.
- Solo aparece en Inicio y Plan. Dentro de los estudios no se muestra, porque tienen sus propias barras fijas de acción.

## Material audiovisual

**COSMOS es producción propia, con gasto USD 0 y sin material de terceros.** La escena es determinista: `scripts/cinematic/cosmos-scene.html` dibuja cada fotograma solo en función del tiempo, y todo el movimiento es periódico en 8 s, así que el bucle no tiene corte. Se renderiza con Chromium y se codifica con ffmpeg:

```bash
node scripts/cinematic/render-ambient.cjs cosmos public/cinematic
```

| Archivo | Tamaño |
|---|---|
| `cosmos-landscape.mp4` (1280×720, H.264, 8 s) | 1,28 MB |
| `cosmos-portrait.mp4` (720×1280) | 1,12 MB |
| `.webm` (VP9) | 0,53–0,57 MB |
| Pósteres JPEG | ≈ 32 KB |

**Fotos de los estudios.** `studio-moderno.jpg` y `studio-calido.jpg` son copias reducidas (≈ 45 KB) de las fotos propias de `public/podcast/estudios`.

**Añadir un ambiente** (Ocean Deep, Thermopylae u otro fragmento propio autorizado):
1. Recorta 6–10 s.
2. Genera `<id>-landscape.(mp4|webm)`, `<id>-portrait.(mp4|webm)` y los dos pósteres en `public/cinematic`.
3. En `ambients.ts`, cambia `media: null` por `own("<id>", segundos, "procedencia")`.

`cinematic.test.ts` comprueba que los archivos existen, que pesan entre 0,3 y 3 MB y que la procedencia está declarada.

## Pruebas

| Prueba | Comando |
|---|---|
| Unitarias | `node --import tsx --test src/components/cinematic/cinematic.test.ts` (incluida en `npm run test:unit`) |
| E2E en navegador (6 resoluciones, video real, pausa, póster, fallo de carga, 2G, dock, CLS) | `E2E_BASE=… E2E_OUT=… node scripts/harness/e2e/cinematic/cinematic-e2e.cjs` |
| Rendimiento antes/después | `PERF_BEFORE=… PERF_AFTER=… node scripts/harness/e2e/cinematic/perf.cjs` |

## Rollback

Revertir el commit (o el merge) de esta rama. No hay migraciones ni datos nuevos. Los archivos de `public/cinematic` dejan de usarse al revertir.
