# Reel «Medieval oscuro» — Mantener el rumbo

Estado: **preparado, no producido.** Hans aprobó la estética de la muestra de 8 s
(armaduras detalladas, tonos oscuros y desaturados, atmósfera cinematográfica,
movimiento corporal). Este reel no repite esa muestra. El presupuesto de
US$2,06 pertenecía solo a la muestra y no se reutiliza aquí. Producir exige
una autorización nueva con su propio tope (ver «Presupuesto»).

- Guion: `script.json` (fijo; sin llamada a Claude).
- Ejecución: `scripts/medieval-reel.ts`, con el workflow `medieval-reel.yml` en tres modos:
  - `plan`: sin gasto;
  - `rehearsal`: ensayo simulado, sin gasto;
  - `run`: gasto real, con `confirm=GASTAR`.
- Pipeline: el mismo de producto (`directed-reel.ts`), con dos parámetros nuevos y opcionales:
  - `animationFraming: "fill"`;
  - `narrationSpeed`.

  Por defecto el producto sigue igual: encuadre «fit» y la misma clave de caché.

## 1. Guion (original, sin citas atribuidas)

1. Nadie le prometió un camino fácil. Aun así, tomó las riendas y avanzó sin dudar.
2. El viento golpeaba de frente y la cuesta no acababa, pero siguió, paso a paso.
3. Cuando el cansancio lo derribó, clavó la espada en la tierra y volvió a levantarse.
4. Mantener el rumbo no es no caer nunca. Es levantarse cada vez y seguir adelante.

El guion tiene 60 palabras, 15 por escena. El límite de una escena animada es de 15 palabras:
con una estimación conservadora de 2,2 palabras/s más 0,8 s de fundido, 15 palabras ocupan 7,6 s, dentro de un clip de 8 s.

## 2. Escenas y acción

Dirección: Medieval oscuro · Acción · música enérgica («driving») · ritmo dinámico · animación IA.
Todas las escenas usan el mismo sujeto recurrente: *knight in weathered steel plate armor, great helm and dark cloak, with his black warhorse*.
El entorno es fijo: camino de montaña pedregoso entre muros medievales en ruinas, bajo un cielo gris y pesado.

| # | Energía | Acción visible (una por escena) | Primer fotograma | Estado final sostenido |
|---|---|---|---|---|
| 1 | media | el caballero arranca al caballo del reposo a un paso firme | montado, caballo quieto, riendas en mano, un casco delantero levantado | caballo y jinete avanzan, enteros en cuadro, levantando polvo |
| 2 | media | sube un paso por la ladera tirando del caballo contra el viento | de pie en la ladera, inclinado contra el viento, caballo debajo | un paso más arriba, el caballo lo sigue, capa al viento |
| 3 | baja | se incorpora desde una rodilla apoyándose en la espada | arrodillado, manos en la empuñadura clavada, cabeza baja | de pie, espada al costado, mirando al frente |
| 4 | media | cabalga por la cresta hacia el castillo lejano | montado y quieto al borde de la cresta, castillo en el horizonte | caballo y jinete avanzan hacia el castillo, enteros en cuadro |

El sujeto recurrente no dice «riding»: la biblia de continuidad lo repite en cada escena, y en las escenas 2 y 3 el caballero va a pie.
Solo se permiten efectos mencionados: polvo en las escenas 1, 3 y 4; viento en la escena 2. Fuego, humo, niebla, lluvia y personajes nuevos se excluyen explícitamente.

### Duración, ajustada a la narración real antes de pagar

- A un ritmo típico de 2,5 palabras/s, la narración dura unos 24 s, más 0,5 s de cola.
- El script sintetiza **primero la voz** (con caché), mide los tiempos reales por palabra y aplica el mismo cálculo que el pipeline:
  - tramos alineados;
  - fundido con la escena siguiente;
  - mínimo visible por energía más 0,3 s de cierre.
- Si el total queda por debajo de 25 s, desacelera hacia 28 s:
  - nunca por debajo de ×0,9;
  - sin que ninguna escena deje de caber.
- Si una escena supera el clip de 8 s, acelera lo justo, con un máximo de ×1,15.
  Si hace falta más, **se detiene antes de pagar imágenes y clips.**
- Con 2,5 palabras/s el resultado es ×0,9, unos 27 s y unos 6,8 s por escena: todas caben en el clip de 8 s con margen.
- La velocidad es un parámetro de la llamada a ElevenLabs. La voz «Hans podcast» no se clona ni se modifica: se usa su `voice_id` existente, validado igual que en el producto (propietaria, estado `ready`, no eliminada).
- Si su ritmo natural ya da 25–28 s, no hay ajuste y la voz se sintetiza una sola vez.

## 3. Encuadre 9:16 sin bandas borrosas

La muestra aprobada usó «fit»: una ilustración 2:3 dentro de 9:16, con bandas borrosas arriba y abajo.
El reel usa **«fill»**:
- la ilustración (1024×1536) se recorta al centro a 1080×1920, sin bandas; se pierde un 7,8 % del ancho por cada lado;
- el prompt de la imagen lo sabe: cabezas, cascos, manos, extremidades, cabezas y cascos del caballo y armas deben quedar dentro del 80 % central del ancho, con aire alrededor;
- el sujeto ocupa los tres cuartos superiores y el cuarto inferior queda libre para los subtítulos;
- el prompt del clip pide mantener cada cabeza, mano, extremidad y casco dentro del cuadro durante todo el plano y prohíbe añadir bandas o bordes.

Evidencia del ensayo (`encuadre-fill.png`), con una imagen 2:3 sintética:
- sale en 1080×1920;
- las marcas del 5 % exterior desaparecen;
- el sujeto del 80 % central queda entero;
- la fila superior es imagen, no una banda.

Las pruebas unitarias cubren lo mismo, y «fit» sigue igual.

## 4. ¿Reutilizar el clip aprobado? No

No se incluye, por cinco motivos:
- Está en «fit», con bandas. Llenar 9:16 exigiría ampliarlo un 18,5 % y recortar los lados, lo que baja la nitidez y arriesga cortar las patas del caballo.
- Su banda superior se mueve.
- Cambia de muros intactos a ruinas dentro del plano.
- El diseño del caballero no está atado a la biblia de continuidad de este reel.
- Su acción duplicaría la de la escena 1.

La escena 1 ocupa ese lugar con el mismo tipo de acción, ya en «fill».

## 5. Música y audio

- La pista es **pixabay-266030**, «Instrumental music - powerful, motivational», de Huynhhoa89.
  - Licencia: Pixabay Content License.
  - Fuente: https://pixabay.com/music/build-up-scenes-instrumental-music-powerful-motivational-266030/
  - Obtenida el 2026-09-15.
  - Figura en `src/lib/providers/music/manifest.ts`.
  - Es la primera candidata de «driving» para este reel.
- El script deja la biblioteca con **esa sola pista** antes de producir. Si no se puede descargar, se detiene antes de gastar y no pasa a las pistas de Eleven Music, cuya licencia no se ha verificado en su fuente primaria. Al terminar, comprueba que la pista usada es esa.
- El audio que genera Veo **se descarta**: el render usa `OffthreadVideo … muted`, así que no compite con la narración.
- Mezcla estándar: música a 0,10 bajo la voz y a 0,35 en los silencios. Masterizado de loudness con control de picos.

## 6. Presupuesto y tope único propuesto

| Concepto | Cálculo | USD |
|---|---|---|
| Imágenes base (gpt-image-2, 1024×1536, medium) | 4 × 0,07 reservados (medido: 0,0574) | 0,28 |
| Clips Veo 3.1 Fast, 1080p, 8 s | 4 × 8 s × 0,12 | 3,84 |
| Voz (324 caracteres, ElevenLabs) | 2 síntesis como máximo × 0,039 reservado | 0,08 |
| Margen de recuperación | 1 imagen + 1 clip | 1,03 |
| **Total máximo** | | **5,23** |

- **Tope único propuesto: US$5,30**, en el registro durable propio `samples/medieval-reel`.
- Gasto típico sin incidencias: unos US$4,10.
- Topes por tipo dentro del total: imágenes 0,35 (5 como máximo) y clips 4,80 (5 como máximo).
- Cada operación pagada se reserva antes de llamar y se liquida después.
- **Sin reintentos automáticos.** El margen de recuperación solo cubre relanzar el workflow una vez tras un rechazo definitivo de una imagen o de un clip. Lo ya pagado se reutiliza: imágenes, voz y clips guardados.
- Una operación incierta bloquea hasta revisarla (`acknowledge`).

## 7. Qué recibe Hans

- `Atomivid-Medieval-Reel-01.mp4`: 1080×1920, unos 27 s, H.264 High nivel 4.1, yuv420p, faststart y 28 MiB como máximo. Se adjunta directamente y abre en el teléfono.
- Fotogramas de inicio, medio y final de cada escena, y una hoja de contacto.
- Las 4 ilustraciones base, las 4 imágenes de entrada 9:16 y los 4 clips.
- Informe con duración, velocidad de voz, pista y loudness, y el registro de gasto.

## 8. Comprobaciones gratuitas hechas

- `tsc` y `lint` limpios; pruebas de `animation` y `narration-fit`.
- `MODE=plan`:
  - disponibilidad correcta;
  - 4 clips de 8 s, US$3,84 dentro del tope de animación;
  - prompts con «fill»;
  - pista fijada primera.
- `MODE=rehearsal`, simulado, con render real de Remotion:
  - 1080×1920;
  - duración igual a la planificada;
  - movimiento dentro de las 4 escenas;
  - subtítulos en el cuarto inferior;
  - evidencia del recorte «fill»;
  - copia de entrega en nivel 4.1.
- No verificado sin credenciales, se comprueba en `plan` del workflow: que «Hans podcast» existe y está lista, que la pista se descarga del bucket y el estado del registro.
- Riesgos que el ensayo no puede medir:
  - la fidelidad de Veo a cada acción;
  - la coherencia del caballero entre las 4 escenas;
  - que Veo respete el cuarto inferior.

  Se revisan en los fotogramas antes de entregar.
