# «Texto a voz» para podcast (episodios largos y música)

Ampliación de «Texto a voz» (PR #16, ver `docs/VOICES.md`). Rama
`claude/tts-podcast`, apilada sobre `claude/voices-medieval-tts`.

**Nada de esto está activo.** Código, migración 0022, pruebas gratuitas y
documentación. No se aplicó la migración, no se cambió configuración
compartida, no se generó audio pagado y no se cambió el plan de ElevenLabs.

## 1. Qué hace

- **Episodios largos (piloto)**: hasta la capacidad técnica de 60.000
  caracteres por pieza, solo para las cuentas del piloto y con límites
  explícitos. Los usuarios generales siguen con 3.000 por pieza y 6.000 al
  mes.
- **Estimaciones en el formulario**: palabras, caracteres, duración
  aproximada como rango (120–140 palabras por minuto con pausas breves,
  identificada como estimación), consumo frente al máximo por pieza y a lo
  que queda del mes y, para el piloto, el saldo del servicio de voz y la
  reserva para el resto de Atomivid. El audio nunca se recorta, acelera ni
  rellena para llegar a una duración.
- **Voz**: el mismo selector (catálogo o «Mi voz» propia, con la propiedad
  comprobada en el servidor y en el worker). La voz «Hans podcast» se usa
  como cualquier voz propia; nada de esto la clona, borra ni prueba.
- **Música opcional**: Sin música, Suspenso o Documental
  (`TTS_MUSIC_ENABLED`).
- **Archivos**: sin música, la narración (`…-narracion.mp3`); con música,
  además el podcast con música (`…-podcast-con-musica.mp3`). Los dos se
  reproducen y descargan desde la misma pieza del historial. En Storage se
  guardan como `tts/<id>/narracion.mp3` y `tts/<id>/podcast-con-musica.mp3`
  (las piezas anteriores conservan su `audio.mp3`).
- **Mezcla independiente**: si la mezcla falla, la narración queda lista y
  se conserva. «Preparar mezcla», «Reintentar con» y «Cambiar música» usan
  la narración guardada: nunca vuelven a sintetizar la voz.

## 2. Límites: tres capas separadas (`src/lib/tts/limits.ts`)

| Capa | Valor | Dónde se aplica |
|---|---|---|
| Capacidad técnica por pieza | 60.000 caracteres (`TTS_TECHNICAL_MAX_CHARS`) | CHECK de `tts_jobs.script` (0022), validación del servidor. No es una cuota. |
| Usuarios generales | 3.000 por pieza, 6.000 por mes (sin cambios) | Servidor + disparador mensual (0021) + CHECK por pieza (0022) |
| Piloto de episodios largos | Solo con `TTS_LONG_PILOT_EMAILS`/`_USER_IDS` **y** `TTS_LONG_PILOT_MAX_CHARS_PER_PIECE` **y** `TTS_LONG_PILOT_MAX_CHARS_PER_MONTH`. Sin alguno de ellos, la cuenta usa los límites generales. | Servidor + base (límite por pieza y mensual guardados en la fila) |
| Un episodio largo a la vez | Como máximo uno en cola o en proceso en toda la cuenta | Índice único parcial `tts_jobs_one_active_long_pilot` (0022) |
| Saldo real del proveedor | Consulta gratuita antes de gastar | Al crear (episodio largo) y en el worker |

### Concurrencia con Reel, Avatar y Long Form

Esos productos consumen la misma cuenta de ElevenLabs **sin reservar
caracteres**, así que no hay una reserva compartida que garantice el
saldo; esta implementación no la promete. Lo que sí hace un episodio largo:

1. No empieza si hay videos generándose (`video_requests` en `processing`
   con render iniciado hace menos de 6 h) o si no puede comprobarlo.
2. Exige saldo ≥ lo que falta de la pieza + otras piezas de «Texto a voz»
   en curso + una reserva para el resto del producto
   (`TTS_PROVIDER_RESERVE_CHARS`, 3.000 por defecto).
3. Vuelve a consultar el saldo cada 8 fragmentos sintetizados. Si bajó, se
   detiene antes de agotarlo. Lo generado se conserva y «Reanudar» no lo
   vuelve a cobrar.
4. Solo hay un episodio largo activo a la vez (índice único parcial).

Un Reel que empiece durante un episodio no se bloquea. El margen y la
comprobación periódica reducen el riesgo, pero no lo eliminan.

## 3. Generación, reanudación y tiempo

- Segmentación y contexto entre fragmentos sin cambios (≤ 900 caracteres;
  `previous_text`/`next_text`). Pausas de 650 ms entre párrafos y de 180 ms
  entre oraciones. Cada borde lleva un fundido de 8/15 ms para evitar
  clics, y un nivelado suave igualar volúmenes: solo actúa si un fragmento
  se aparta más de 1,5 dB de la mediana, y con un tope de ±3 dB.
- Cada fragmento pasa por la caché de voz durable y el registro de gasto.
  Al reanudar, lo ya generado se reutiliza sin cobrarse. Un fragmento en
  estado incierto detiene la pieza en vez de repetirse.
- Doble clic: `client_request_id` único. Doble ejecución: reclamo
  condicional (`queued → processing`), grupo de concurrencia del workflow y
  reclamo propio de la mezcla (`mix_status pending → processing`).
- **Presupuesto de tiempo**: el worker solo se detiene entre fragmentos,
  cuando no queda tiempo para el siguiente o para unir, y deja la pieza
  «pausada» con «Reanudar». Una reanudación a la que solo le falta unir
  une siempre (evita pausas en bucle). `TTS_WORKER_BUDGET_SECONDS` vale 11
  min por defecto, que cabe en el `tts.yml` registrado hoy (paso de 15
  min); el `tts.yml` de esta rama sube a 45 min (paso de 52, trabajo de
  60).
- **Tiempos medidos** en la validación local de 45 min: unir y masterizar
  la narración tarda ≈ 107 s; mezclar y masterizar, ≈ 207 s. La síntesis
  real no se midió (sin gasto): con ~58 fragmentos a 6–10 s cada uno serían
  ≈ 6–10 min. Con el `tts.yml` registrado hoy, un episodio de 45 min se
  pausaría al menos una vez; con el de esta rama cabe en una ejecución.
- Tamaño: la tasa del MP3 baja por escalones (128 → 64 kbps) para no pasar
  de 47 MiB por archivo. El límite demostrado de Storage es 50 MiB, ver
  `output-policy.ts`. Con 45 min se mantiene en 128 kbps (≈ 38 MB).

## 4. Música (`src/lib/tts/music-beds.ts`)

- **Opciones**: Sin música, Suspenso y Documental. Hay dos fondos por
  estado de ánimo. El fondo es fijo por pieza y se registra en
  `music_track_id`.
- **Procedencia y licencia**: los fondos los **compone este código**
  (síntesis determinista, sin muestras de terceros), así que son obra
  propia de Atomivid, sin atribución, con uso comercial y publicación
  permitidos. Se registran en `MUSIC_BEDS` (fuente, licencia, atribución).
- **Por qué no se usan las 20 pistas de Eleven Music del banco de Reels**:
  - sus términos para planes de pago restringen algunos usos comerciales
    (TV o radio fuera de internet, cine, anuncios, bibliotecas musicales);
  - al menos una fuente secundaria menciona restricciones de «streaming»;
  - no fue posible leer la fuente primaria desde este entorno
    (elevenlabs.io bloqueado), así que su uso en podcasts publicados no
    quedó comprobado.

  Las 2 pistas de Pixabay son corporativas o motivacionales, no suspenso ni
  documental. Tampoco se pudieron descargar pistas CC0 (bancos bloqueados
  en este entorno). No se contrató ni generó música de pago.
- **Calidad**:
  - **Verificado por código**: bucle sin costura, sin recorte y niveles.
  - **Visto**: espectrogramas con los cambios de acorde y las subidas de
    tensión.
  - **Escuchado**: nadie los ha escuchado todavía. Los fondos y extractos
    están en la evidencia para que Hans los juzgue antes de activar.
- **Mezcla** (`podcast-audio.ts`, parámetros en `MIX`):
  1. Entra la música con un fundido de 3 s.
  2. A los 3,5 s baja 14 dB durante 2,5 s.
  3. La voz empieza a los 6 s.
  4. La música queda 20 LU por debajo de la voz durante toda la narración
     (y con −4 dB en 2,2 kHz, la zona de inteligibilidad).
  5. Al terminar la voz, sube en 2,5 s, se mantiene 3 s y sale con un
     fundido de 5 s.

  El fondo se prolonga repitiendo su bucle perfecto. Sin efectos de sonido
  ni controles avanzados.
- **Sonoridad** (recomendación AES para podcast):
  - narración mono a −19 LUFS (equivale a −16 en estéreo);
  - mezcla estéreo a −16 LUFS;
  - pico real ≤ −1,5 dBTP en ambas, verificado sobre el MP3 final.

## 5. Masterización compartida (defecto documentado)

**No afecta a esta entrega.** El podcast no usa `audio-master.ts`; usa su
propio `masterToMp3`, que siempre corrige desde el original sin pérdida y
verifica el MP3 final en un bucle acotado.

La causa de la prueba intermitente
`audio-master.test.ts › masterización con margen…` está reproducida con
semillas fijas (1, 2, 3, 10, 12 del mismo ruido rosa con transitorios):

1. En la segunda pasada, `loudnorm` con `linear=true` no puede aplicar la
   ganancia lineal (el pico medido + la ganancia superaría el techo) y cae
   a **modo dinámico**. Resultado: −17,4 LUFS en la semilla 12, en vez de
   −16; en el barrido, entre −17,4 y −17,9.
2. La pasada correctiva de pico **vuelve a codificar AAC sobre el AAC ya
   codificado** y no vuelve a verificar. El sobrepico nuevo no está
   acotado: en la semilla 12 pasó de −1,21 a −0,81 dBTP después de corregir
   −0,42 dB, y en la semilla 10 quedó en −1,21. Ambos superan −1,5.

El mismo tipo de señal pasa en las cinco semillas con la masterización del
podcast (`podcast.test.ts`).

La corrección natural para `audio-master.ts` es aplicar la corrección desde
la entrada sin pérdida y verificar en bucle. **No se aplicó**: esa ruta
(`truePeakMarginDb`) la usa Long Form, y cambiarla altera Reel, Avatar o
Long Form. Requiere autorización propia y volver a validar esos productos.
La prueba intermitente sigue como estaba (sin relajar ni elegir semillas).

## 6. Consumo estimado

Caracteres por palabra ≈ 6,0 (medido en el texto de validación: 35.502 /
5.908). Cuenta Starter de 38.002 caracteres por período; costo según el
registro de la app (US$0,10 por 1.000 caracteres, el mismo que usa el
registro de gasto).

| Episodio | Palabras (120–140 ppm) | Caracteres | % del período | Costo registrado | Tope del registro del worker |
|---|---|---|---|---|---|
| 30 min | 3.600–4.200 (típ. 3.900) | 21.600–25.200 (típ. ≈ 23.400) | 57–66 % | US$2,16–2,52 (típ. 2,34) | 1,2 × costo + 0,01 |
| 45 min | 5.400–6.300 (típ. 5.850) | 32.400–37.800 (típ. ≈ 35.100) | 85–99 % | US$3,24–3,78 (típ. 3,51) | 1,2 × costo + 0,01 |

**Saldo**: la última lectura (solo lectura, run 36269569261, 2026-09-26
20:27 UTC) daba 23.114 de 38.002 usados, **14.888 disponibles**. Se renueva
el 2026-10-16 03:08 UTC y no se puede ampliar. Después hubo una clonación
(frase de prueba de 81 caracteres) y una pieza corta de Hans, así que el
saldo actual es algo menor; no se pudo leer desde este entorno.

- Hoy no cabe ni un episodio de 30 min ni uno de 45.
- Tras la renovación, uno de 30 min cabe con la reserva (≈ 26.400 de
  38.002) y deja ≈ 11.600 para todo lo demás.
- Uno de 45 min típico más la reserva (≈ 38.100) **no cabe en Starter**, ni
  siquiera con el período completo. Requiere más caracteres, que es una
  decisión de plan de Hans; aquí no se cambió nada.

**Límites propuestos para el piloto**:

```
TTS_LONG_PILOT_EMAILS=hanzmo16@gmail.com
TTS_LONG_PILOT_MAX_CHARS_PER_PIECE=25000   # ≈ 30–35 min
TTS_LONG_PILOT_MAX_CHARS_PER_MONTH=25000
TTS_PROVIDER_RESERVE_CHARS=3000            # por defecto
```

Con un plan mayor, 40.000 cubriría 45 min.

## 7. Validación gratuita (proveedores simulados, audio local)

- `src/lib/tts/podcast.test.ts` (22 pruebas, en `test:unit`) cubre:
  - los límites por capa y que el piloto exija límites explícitos;
  - las estimaciones;
  - doble envío y un episodio largo a la vez;
  - el rechazo sin saldo;
  - videos en curso;
  - la reserva y otras piezas en curso;
  - el saldo que baja a mitad y se reanuda sin repetir síntesis;
  - la pausa por tiempo y la reanudación sin repetir síntesis;
  - la mezcla y su fallo sin perder la narración;
  - «cambiar música» sin sintetizar, rechazado para otra usuaria;
  - la masterización acotada en 5 semillas;
  - voz y música con habla sintética: voz ≥ 15 dB sobre la música,
    entrada y salida graduales, sin huecos ni recorte;
  - el bucle sin costura;
  - la migración 0022 aditiva.
- `scripts/podcast-local-validation.ts` (también en
  `e2e-fixture-evidence.yml`) prueba un episodio equivalente a 45 min.
  Resultados:
  - 5.908 palabras, 35.502 caracteres, 58 fragmentos;
  - 3 ejecuciones: pausa por tiempo en el fragmento 18, luego un fallo
    rechazado sin cobro en la llamada 31, luego termina;
  - 59 llamadas, 58 fragmentos: la única repetida es la rechazada, que no
    se cobra;
  - narración de 2.399,8 s, igual a la esperada;
  - mezcla de 2.417,2 s, igual a la narración + 17,3 s;
  - narración −19,0 LUFS / −3,6 dBTP; mezcla −16,0 LUFS / −3,1 dBTP;
  - 0 muestras recortadas;
  - voz sobre música entre 19,4 y 20,4 dB en los 40 minutos medidos;
  - costuras del bucle de 0,01 dB, frente a una variación normal de
    1,9 dB (p99);
  - silencio final −50 dB;
  - 38,4 y 38,7 MB (128 kbps).

  La «voz» es habla sintética de prueba (formantes con ritmo silábico), no
  voz real. La duración real con ElevenLabs depende de la voz.

## 8. Activación (cada paso requiere autorización)

1. **Migración 0022** en el Supabase compartido con producción:
   `apply-supabase-migration.yml` con `ref=claude/tts-podcast` y
   `migration_file=0022_tts_podcast.sql`.
   - Aditiva: amplía el CHECK del guion y agrega columnas con valores por
     defecto, CHECK nuevos y un índice parcial.
   - El worker fijado hoy (0a53459) y la app de PR #16 siguen funcionando
     igual: no leen las columnas nuevas y sus filas toman los valores por
     defecto.
2. **Volver a registrar `tts.yml`** en la rama por defecto, fijado al
   commit revisado de esta rama y con los tiempos nuevos (60/52 min,
   `TTS_WORKER_BUDGET_SECONDS=2700`). Solo después de 0022: el worker nuevo
   lee las columnas nuevas. Afecta a toda pieza de «Texto a voz» (la
   narración pasa a nivelarse y masterizarse).
3. **Preview de `claude/tts-podcast`** (variables solo para esa rama):
   - las mismas de la rama de voces (`TEXT_TO_SPEECH_ENABLED`,
     `MY_VOICE_ENABLED` y su lista, `GH_WORKER_*`, `NEXT_PUBLIC_SITE_URL`,
     Supabase del mismo proyecto);
   - `TTS_MUSIC_ENABLED=true`;
   - las del piloto solo cuando se aprueben episodios largos.
4. **Prueba real breve con música**: ver sección 9.
5. **Episodio largo real**: aparte, con autorización propia, después de la
   renovación (o con más caracteres) y con los límites del piloto.

## 9. Primera prueba real breve con música (propuesta, no ejecutada)

- **Texto**: ≤ 1.100 caracteres (≈ 180 palabras, ≈ 1,3–1,5 min estimados).
- **Voz**: «Hans podcast», o una del catálogo. No se clona nada.
- **Música**: Documental (o Suspenso); luego «Cambiar música» al otro
  estado de ánimo, que no vuelve a sintetizar.
- **Límites**: cabe en los generales; no necesita el piloto.
- **Costo estimado**: ≈ US$0,11 (1.100 caracteres a US$0,10 por 1.000). Es
  ≈ 7 % del saldo disponible. Mezclar y cambiar de música no cuesta nada.
- **Tope propuesto: US$0,15.** El registro de gasto del worker ya la limita
  a 1,2 × 0,11 + 0,01 ≈ US$0,142.
- **Requisitos previos**: pasos 1–3 de la sección 8.
