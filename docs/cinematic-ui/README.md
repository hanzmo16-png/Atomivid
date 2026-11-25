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

**COSMOS es producción propia de ATOMIVID generada con IA**, autorizada por Hans el 2026-11-24 («si necesitas un proveedor de pago … tienes mi autorización»). Gasto total: **USD 5,34**.
- **Imágenes clave:** FLUX 1.1 Pro Ultra (fal.ai), 9 candidatas (USD 0,54). Elegidas: `kf-land-d` (horizontal: nave de frente, nebulosa, planeta anillado a la derecha) y `kf-port-a` (vertical: planeta arriba, nave en el centro, espacio libre abajo). Se descartaron las que tenían texto en el casco, barras negras o el planeta detrás del titular.
- **Animación:** Veo 3.1 Fast vía fal.ai, 1080p, 8 s, sin audio. Por orientación, un clip con movimiento libre de cámara (image-to-video) y uno de bucle exacto (primer y último fotograma = imagen clave). 4 clips, USD 4,80. La clave directa de Google ya no ofrece modelos Veo (404 / ListModels vacío, sin cobro).
- **Montaje** (`scripts/cinematic/encode-ambient.sh`): clip libre completo + fundido de 1,5 s hacia el tramo 3–8 s del clip de bucle, que acaba en la imagen clave = primer fotograma ⇒ **bucle de 11,5 s sin salto** (PSNR de la costura 28,7 dB en horizontal, igual o mejor que entre fotogramas consecutivos).
- **Clips maestros** (Veo 1080p, 4 × 8 s, ~25 MB): fuera del árbol para no engordar el repositorio; están en el historial de esta rama (commit `6ef9eb02`, `ops/cinematic-bg/out/vid-*.mp4`).
- **Reproducible:** `ops/cinematic-bg/job.json` + `scripts/cinematic/paid-ambient.mjs` (tope de gasto en el job, sin reintentos). El workflow de GitHub que lo ejecutaba (`cinematic-bg-paid.yml`) se retiró antes del merge: está en el historial de esta rama y solo debe restaurarse con una nueva autorización de gasto. Los informes con identificadores de petición están en `ops/cinematic-bg/out/report-*.json`.

| Archivo | Tamaño |
|---|---|
| `cosmos-landscape.mp4` (1280×720, H.264, 11,5 s) | 2,67 MB |
| `cosmos-portrait.mp4` (720×1280) | 2,20 MB |
| `cosmos-landscape.webm` / `cosmos-portrait.webm` (VP9, los que usa Chrome) | 1,75 / 1,46 MB |
| Pósteres JPEG | 74–94 KB |

La escena 3D propia «VANGUARD» (`scripts/cinematic/vanguard-scene.html` + `render-ambient.cjs`, USD 0) queda como alternativa sin coste.

**Fotos de los estudios.** `studio-moderno.jpg` y `studio-calido.jpg` son copias reducidas (≈ 45 KB) de las fotos propias de `public/podcast/estudios`.

**Añadir un ambiente** (Ocean Deep, Thermopylae u otro fragmento propio autorizado):
1. Recorta 6–12 s.
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
