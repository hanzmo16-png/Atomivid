# DULCE — PARTE I (V2): storyboard y plan de producción

Estado: **pendiente de aprobación. Sin llamadas de pago.** Generado por `scripts/lib/dulce-part1-plan.py` desde `content/long-form/dulce-part1/script-es.json`.

- Narración estimada (inglés, Brian a speed 0.92): 8.4 min; timeline 8.5 min. Se recalcula con el audio medido.
- Planos en el montaje: 127 (media 4.0 s).

## Storyboard

| ID | Inicio | s | Bloque | Narración (intención) | Imagen (intención) | Fuente | Acción | Personajes | Proveedor | Riesgo | USD | Nota |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P1-001 | 0:00.0 | 2.6 | p01 | Durante décadas… Nuevo México | Mesa al atardecer, dron entrando | N01 | NEW |  | gpt-image-2 + Runway 10 s | bajo | 0.60 | Exterior Nuevo México: mesa y cañones al atardecer, dron lento hacia delante |
| P1-002 | 0:02.6 | 2.4 | p01 | …una historia extraordinaria | Pueblo de noche a lo lejos | N02 | NEW |  | gpt-image-2 + Runway 5 s | bajo | 0.35 | Luces de un pueblo pequeño en la llanura, noche, paneo lento |
| P1-003 | 0:05.0 | 2.6 | p01 | …oficialmente no existe | Entrada en la roca, reflectores | N03 | NEW |  | gpt-image-2 + Runway 5 s | bajo | 0.35 | Entrada de instalación excavada en la roca: valla, reflectores, puesto de guardia vacío |
| P1-004 | 0:07.6 | 2.2 | p01 | Kilómetros de túneles | Túnel interminable | N04 | NEW |  | gpt-image-2 + Runway 10 s | bajo | 0.60 | Túnel de vehículos interminable, luces que se pierden; dolly adelante |
| P1-005 | 0:09.8 | 2.1 | p01 | Siete niveles | Corte transversal: 7 niveles se encienden | G1 | NEW |  | Motion graphics (FFmpeg/ASS, sin IA) | nulo | 0.00 | Corte transversal animado: 7 niveles bajo la mesa (sin datos inventados, etiqueta 'según el relato') |
| P1-006 | 0:11.9 | 2.0 | p01 | Laboratorios | Laboratorio con pulso cian | D01-04 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Laboratorio (clip de biblioteca) con pulso y vapor; el mejor laboratorio. |
| P1-007 | 0:13.9 | 2.0 | p01 | Áreas restringidas | Puerta con luz roja | D03-06 | RECUT |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Puerta con luz roja 0–2.5 s; luego haz de linterna aparece y cámara gira. |
| P1-008 | 0:15.9 | 2.6 | p01 | …algo que nunca debió estar allí | Reptiliano en el reflejo tras Thomas | D01-07 | RECUT |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Reflejo reptiliano tras Thomas 0–3 s; luego aparece figura andando en el fondo. |
| P1-009 | 0:18.5 | 2.1 | p01 | (sigue) | Gris en el haz de la linterna, push-in | D04-01 | REANIMATE |  | Runway (reanimar still aprobado, solo cámara) | medio | 0.25 | Gris MUTA a humanoide blanco y camina; still inicial excelente. |
| P1-010 | 0:20.6 | 2.9 | p01 | …la leyenda de la Base Dulce | Thomas se aleja por el corredor | D01-01 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Corredor, Thomas de espaldas; estable. |
| P1-011 | 0:23.5 | 2.9 | p01 | …atribuido a un solo hombre | Thomas frente a las dos figuras | D01-03 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Thomas ante gris + reptiliano al fondo; estable. |
| P1-012 | 0:26.4 | 2.9 | p01 | Su nombre era Thomas Edwin Castello | Retrato de Thomas + rótulo G2 'recreación' | D07-03 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Retrato de Thomas mirando arriba; excelente identidad. |
| P1-013 | 0:29.3 | 3.1 | p01 | Y aseguró haber trabajado dentro. | Puertas del ascensor se abren + título G3 DULCE — PARTE I | D03-04 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Puertas abren a pasaje cálido; estable. |
| P1-014 | 0:32.4 | 5.5 | p02 | Castello decía haber sido especialista en seguridad | Thomas en la sala de control CCTV | N05 | NEW | Thomas | gpt-image-2 + Runway 10 s | medio | 0.60 | Sala de control de seguridad: Thomas (C1, uniforme oscuro) ante monitores CCTV; solo respira y mira |
| P1-015 | 0:37.9 | 4.1 | p02 | …lo llevó a una instalación… próxima a Dulce | Camioneta hacia la noche | D02-03 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Camioneta alejándose de noche; estable. |
| P1-016 | 0:42.0 | 4.1 | p02 | Personal con diferentes niveles de autorización | Guardia en ventanilla, alguien pasa | D08-04 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Guardia en ventanilla, alguien pasa al fondo; estable. |
| P1-017 | 0:46.1 | 2.7 | p02 | Puertas controladas | Thomas junto a la puerta de servicio | D07-05 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Thomas junto a puerta de servicio; estable. |
| P1-018 | 0:48.8 | 2.7 | p02 | Cámaras | Cámara de seguridad gira | D07-04 | RECUT |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Cámara de seguridad gira 0–3.5 s; luego asoma una cara abajo a la izquierda. |
| P1-019 | 0:51.5 | 2.7 | p02 | Sistemas de identificación | Lector de credencial, LED verde | N06 | REPLACE |  | gpt-image-2 + Runway 5 s | bajo | 0.35 | Lector de credencial en pared de hormigón, LED verde (sustituye D02-05); push-in, sin manos |
| P1-020 | 0:54.2 | 2.3 | p02 | Secretos. | Terminal con cursor | D02-06 | RECUT |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Terminal; aparece un '!' generado a mitad; usar 0–2.5 s. |
| P1-021 | 0:56.5 | 3.7 | p02 | Pero Dulce… era diferente | Thomas avanza hacia cámara | D08-01 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Thomas camina hacia cámara; estable. |
| P1-022 | 1:00.2 | 4.9 | p02 | …cuanto más descendías… menos humana | Ascensor bajando, Thomas mira la puerta | D03-03 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Interior ascensor; estable. |
| P1-023 | 1:05.1 | 6.2 | p03 | …varios niveles subterráneos | Corte transversal detallado, zonas por color | G1 (reuso) | NEW |  | Motion graphics (FFmpeg/ASS, sin IA) | nulo | 0.00 | Corte transversal animado: 7 niveles bajo la mesa (sin datos inventados, etiqueta 'según el relato') |
| P1-024 | 1:11.3 | 2.1 | p03 | …no era cuestión de tener una credencial | Credencial en lector (0–2 s) | D08-03 | RECUT |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Credencial en lector; la tarjeta desaparece tras 2 s. |
| P1-025 | 1:13.4 | 4.6 | p03 | Cada zona requería autorizaciones diferentes | Puerta blindada con franja de zona | N07 | NEW |  | gpt-image-2 + Runway 10 s | bajo | 0.60 | Puerta blindada con franja de color de zona y teclado; LED rojo parpadea |
| P1-026 | 1:18.0 | 4.6 | p03 | Había lugares… | Thomas camina por corredor | D07-01 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Thomas camina por corredor; estable. |
| P1-027 | 1:22.6 | 5.1 | p03 | …tenían prohibido conocer | Línea en el suelo y torniquete | N08 | NEW | guardia | gpt-image-2 + Runway 5 s | medio | 0.35 | Barrera: línea pintada en el suelo y torniquete; guardia inmóvil al fondo desenfocado |
| P1-028 | 1:27.7 | 4.6 | p03 | Corredores aparentemente interminables | Corredor largo, figura lejana | D07-06 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Corredor largo, figura lejana; estable. |
| P1-029 | 1:32.3 | 4.1 | p03 | …áreas técnicas | Tuberías y pasarelas | N09 | NEW |  | gpt-image-2 + Runway 10 s | bajo | 0.60 | Área técnica: tuberías, generadores, pasarela, vapor; sin personas |
| P1-030 | 1:36.4 | 6.4 | p03 | …lo más importante estaba abajo | Hueco de ascensor hacia la oscuridad | N10 | NEW |  | gpt-image-2 + Runway 10 s | bajo | 0.60 | Hueco de ascensor de carga mirando hacia abajo, luces que descienden en la oscuridad |
| P1-031 | 1:42.8 | 4.3 | p04 | No eran las puertas. Eran quienes caminaban detrás | Thomas alza la credencial hacia las figuras | D04-03 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Thomas alza credencial hacia figuras; estable. |
| P1-032 | 1:47.1 | 4.3 | p04 | …los humanos no eran los únicos ocupantes | Gris y reptiliano en el corredor | D04-02 | RECUT |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Gris + reptiliano en corredor 0–5 s; al final el reptiliano cambia. |
| P1-033 | 1:51.4 | 4.3 | p04 | …pequeños seres grises | Gris, plano medio | N11 | NEW | gris | gpt-image-2 + Runway 5 s | medio | 0.35 | Gris (G1) plano medio en sala técnica, leve giro de cabeza |
| P1-034 | 1:55.7 | 4.3 | p04 | …apariencia reptiliana | Reptiliano de perfil | N12 | NEW | reptiliano | gpt-image-2 + Runway 5 s | medio | 0.35 | Reptiliano (R1) plano medio de perfil en corredor, respira, gira apenas |
| P1-035 | 2:00.0 | 2.6 | p04 | No los describía como prisioneros | El gris se hace a un lado (0–3 s) | D04-04 | RECUT |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Gris avanza y crece/aclara; usar 0–3 s. |
| P1-036 | 2:02.6 | 5.2 | p04 | …algunos trabajaban dentro | Gris ante consola | N13 | NEW | gris | gpt-image-2 + Runway 10 s | medio | 0.60 | Gris sentado ante consola, visto de lado/espaldas, pantallas parpadean (manos ocultas) |
| P1-037 | 2:07.8 | 5.2 | p04 | Compartían áreas con personal humano | Técnico y gris en la misma mesa | N14 | NEW | técnico, gris | gpt-image-2 + Runway 10 s | alto | 0.60 | Técnico humano (T1) y gris en extremos de una mesa de laboratorio; ninguno se mueve de sitio |
| P1-038 | 2:13.0 | 3.5 | p04 | Participaban en actividades técnicas | Técnico ajusta mando junto a Thomas | D06-02 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Técnico gira mando junto a Thomas; estable. |
| P1-039 | 2:16.5 | 3.7 | p04 | …operación cotidiana… lo imposible, rutina | Reptiliano tras cristal de control | N15 | NEW | reptiliano | gpt-image-2 + Runway 5 s | medio | 0.35 | Reptiliano tras cristal de sala de control, silueta ante monitores |
| P1-040 | 2:20.2 | 2.4 | p05 | Imagina trabajar en un lugar así | Thomas primer plano (0–2.5 s) | D05-06 | RECUT |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Primer plano de Thomas 0–2.5 s; después mano a la boca y la cara cambia. |
| P1-041 | 2:22.6 | 4.4 | p05 | El primer día… | POV: gris quieto al fondo | N16 | NEW | gris | gpt-image-2 + Runway 5 s | medio | 0.35 | POV de Thomas: corredor, un gris quieto lejos en una intersección |
| P1-042 | 2:27.0 | 3.4 | p05 | …semanas… meses | Corredor en time-lapse (reencuadre + velocidad) | D07-06 (reuso) | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Corredor largo, figura lejana; estable. |
| P1-043 | 2:30.4 | 3.9 | p05 | Describe un trabajo. Turnos. | Reloj de fichar | N17 | NEW |  | gpt-image-2 + FFmpeg (movimiento de cámara) | nulo | 0.10 | Reloj de fichar y tarjetas en su rack (inserto, sin personas) |
| P1-044 | 2:34.3 | 3.9 | p05 | Procedimientos. | Thomas ajusta bisagra (0–4 s) | D02-04 | RECUT |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Thomas ajusta bisagra; manos estables 0–4 s. |
| P1-045 | 2:38.2 | 3.9 | p05 | Restricciones. | Técnico anota en portapapeles | D06-03 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Técnico escribe en portapapeles; estable. |
| P1-046 | 2:42.1 | 3.9 | p05 | Personal entrando y saliendo | Torniquetes de turno | N18 | NEW | personal | gpt-image-2 + Runway 5 s | medio | 0.35 | Torniquetes de turno: personal de espaldas desenfocado, sin cruces |
| P1-047 | 2:46.0 | 2.9 | p05 | Sistemas que debían mantenerse | Rejilla de ventilación | D03-05 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Rejilla con cinta; estable. |
| P1-048 | 2:48.9 | 5.3 | p05 | …seres que simplemente formaban parte del lugar | Gris tras cristal esmerilado | N19 | NEW | gris, personal | gpt-image-2 + Runway 10 s | medio | 0.60 | Oficina: humano teclea en primer plano; tras cristal esmerilado pasa la silueta de un gris |
| P1-049 | 2:54.2 | 4.2 | p06 | …cuando Thomas regresaba a casa | Camioneta llega a casa | D08-06 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Camioneta llega a casa de noche; estable. |
| P1-050 | 2:58.4 | 4.2 | p06 | …obligado a guardar silencio | Familia a la mesa, vista por la ventana | D12-06 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Familia vista por la ventana; estable. |
| P1-051 | 3:02.6 | 5.1 | p06 | Imagina sentarte a cenar frente a tu esposa | Familia sentada, plano maestro | D12-01 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Familia sentada a la mesa, plano maestro; estable. |
| P1-052 | 3:07.7 | 1.2 | p06 | (flash) …pasar el día en un lugar | Flash: corredor de Dulce | D01-01 (reuso) | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Corredor, Thomas de espaldas; estable. |
| P1-053 | 3:08.9 | 5.1 | p06 | …cambiaría todo lo que ella cree saber | Esposa sobre el hombro de Thomas | D12-03 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Esposa sobre el hombro de Thomas; ideal para 'Thomas callado'. |
| P1-054 | 3:14.0 | 3.4 | p06 | Mirarla hablar… De la familia. Del trabajo. | Esposa sonríe | D11-06 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Esposa sonríe; estable. |
| P1-055 | 3:17.4 | 3.4 | p06 | Del día siguiente. | Hijo mira a su madre | D10-05 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Hijo moreno con madre de espaldas; estable. |
| P1-056 | 3:20.8 | 6.3 | p06 | …otra realidad que no puedes compartir | Thomas callado a la mesa, push-in | N20 | NEW | Thomas | gpt-image-2 + Runway 10 s | medio | 0.60 | Thomas (C1) primer plano en la mesa de la cena, callado; push-in muy lento |
| P1-057 | 3:27.1 | 1.2 | p06 | (flash) otra realidad | Flash: gris y reptiliano | D04-02 (reuso) | RECUT |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Gris + reptiliano en corredor 0–5 s; al final el reptiliano cambia. |
| P1-058 | 3:28.3 | 3.4 | p06 | No porque no quieras. | Esposa, primer plano | D10-04 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Esposa, primer plano (v2 reencuadrado); estable. |
| P1-059 | 3:31.7 | 4.2 | p06 | …consecuencias. Para tu trabajo. Para ti. | Thomas en la cocina, pensativo | D09-04 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Thomas en la cocina, pensativo; identidad correcta. |
| P1-060 | 3:35.9 | 3.4 | p06 | …las personas que más quieres | Hijo habla | D11-04 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Hijo cuenta algo; estable. |
| P1-061 | 3:39.3 | 3.4 | p06 | (sigue) | Esposa habla | D11-03 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Esposa habla (v2 reencuadrado); estable. |
| P1-062 | 3:42.7 | 1.2 | p06 | (flash) | Flash: laboratorio con la silueta de Thomas | D05-01 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Silueta de Thomas observando cámaras; estable. |
| P1-063 | 3:43.9 | 4.2 | p06 | …y fingía que no sabía nada | Dibujo familiar y llaves | D12-04 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Dibujo familiar + llaves; estable. |
| P1-064 | 3:48.1 | 4.2 | p06 | A la mañana siguiente volvía a Dulce | Camioneta sale al amanecer | N21 | NEW |  | gpt-image-2 + Runway 5 s | bajo | 0.35 | Amanecer: la misma camioneta marrón sale de la casa hacia el desierto |
| P1-065 | 3:52.3 | 3.0 | p06 | Volvía a los controles. | (otro tramo) sala de control | N05 (reuso) | NEW | Thomas | gpt-image-2 + Runway 10 s | medio | 0.00 | Sala de control de seguridad: Thomas (C1, uniforme oscuro) ante monitores CCTV; solo respira y mira |
| P1-066 | 3:55.3 | 2.5 | p06 | A los corredores. | (otro tramo) corredor | D01-01 (reuso) | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Corredor, Thomas de espaldas; estable. |
| P1-067 | 3:57.8 | 2.5 | p06 | A los seres… | (otro tramo) figuras | D01-03 (reuso) | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Thomas ante gris + reptiliano al fondo; estable. |
| P1-068 | 4:00.3 | 4.3 | p06 | Y volvía a guardar silencio. | Thomas en corredor, push-in | N22 | NEW | Thomas | gpt-image-2 + Runway 10 s | medio | 0.60 | Thomas (C1) primer plano en corredor, silencio; push-in |
| P1-069 | 4:04.6 | 6.0 | p07 | Existían reglas. Conversaciones restringidas | Mampara: humanos a un lado, gris al otro | N23 | NEW | personal, gris | gpt-image-2 + Runway 10 s | alto | 0.60 | Mampara de cristal: dos técnicos humanos a un lado, un gris lejos al otro; estático |
| P1-070 | 4:10.6 | 2.0 | p07 | …no debía compartirse | Técnico tapa el portapapeles (0–2 s) | D06-05 | RECUT |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Técnico tapa portapapeles 0–2 s; después el portapapeles desaparece. |
| P1-071 | 4:12.6 | 3.0 | p07 | Preguntas que era mejor no hacer | Thomas con la radio (0–3 s) | D07-02 | RECUT |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Radio al oído; luz roja rara en la cara; usar 0–3 s. |
| P1-072 | 4:15.6 | 5.0 | p07 | …mantener precisamente ese sistema | (otro tramo) Thomas vigila monitores | N05 (reuso) | NEW | Thomas | gpt-image-2 + Runway 10 s | medio | 0.00 | Sala de control de seguridad: Thomas (C1, uniforme oscuro) ante monitores CCTV; solo respira y mira |
| P1-073 | 4:20.6 | 4.0 | p07 | …durante algún tiempo, lo hizo | Monitores CCTV | N24 | NEW |  | gpt-image-2 + FFmpeg (movimiento de cámara) | nulo | 0.10 | Banco de monitores CCTV mostrando corredores (inserto) |
| P1-074 | 4:24.6 | 7.9 | p07 | Hasta que empezó a ver cosas… | Thomas ante ventana de observación | N25 | NEW | Thomas | gpt-image-2 + Runway 10 s | medio | 0.60 | Thomas (C1) ante ventana de observación, reflejo del laboratorio en el cristal |
| P1-075 | 4:32.5 | 4.3 | p08 | Los laboratorios… | (otro tramo) laboratorio de cámaras | D01-04 (reuso) | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Laboratorio (clip de biblioteca) con pulso y vapor; el mejor laboratorio. |
| P1-076 | 4:36.8 | 4.3 | p08 | …investigación biológica y médica | Sala médica clínica | N26 | NEW |  | gpt-image-2 + Runway 10 s | bajo | 0.60 | Sala médica clínica (distinta del laboratorio de cámaras): camilla vacía, instrumental, luz blanca-verde |
| P1-077 | 4:41.1 | 3.5 | p08 | Equipamiento que no comprendía | Recipientes y luces | N27 | NEW |  | gpt-image-2 + Runway 5 s | bajo | 0.35 | Equipamiento extraño: recipientes de vidrio, cables, luces que laten |
| P1-078 | 4:44.6 | 4.3 | p08 | Cámaras y áreas de observación | Thomas observa las cámaras | D05-01 (reuso) | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Silueta de Thomas observando cámaras; estable. |
| P1-079 | 4:48.9 | 4.3 | p08 | Personal humano cerca de entidades no humanas | Técnico al microscopio, gris al lado | N28 | NEW | técnico, gris | gpt-image-2 + Runway 5 s | alto | 0.35 | Técnico humano al microscopio; un gris observa a su lado sin tocar nada |
| P1-080 | 4:53.2 | 3.5 | p08 | …existían explicaciones | Técnico entra (0–4 s) | D06-01 | RECUT |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Técnico entra por puerta; usar 0–4 s. |
| P1-081 | 4:56.7 | 2.6 | p08 | Medicina experimental. | (otro tramo) sala médica | N26 (reuso) | NEW |  | gpt-image-2 + Runway 10 s | bajo | 0.00 | Sala médica clínica (distinta del laboratorio de cámaras): camilla vacía, instrumental, luz blanca-verde |
| P1-082 | 4:59.3 | 4.3 | p08 | …alguien arriba sabía | Galería de observación | N29 | NEW | personal | gpt-image-2 + Runway 5 s | medio | 0.35 | Galería de observación desde arriba: laboratorio con figuras pequeñas |
| P1-083 | 5:03.6 | 4.7 | p08 | …no había visto los niveles inferiores | Puerta de ascensor sin botón | N30 | NEW | Thomas | gpt-image-2 + Runway 5 s | medio | 0.35 | Puerta de ascensor sin botón de llamada, nivel inferior; Thomas la mira de espaldas |
| P1-084 | 5:08.3 | 5.4 | p09 | …otros trabajadores. Comentarios. Rumores. | Sala de descanso | N31 | NEW | trabajadores | gpt-image-2 + Runway 10 s | medio | 0.60 | Sala de descanso: dos trabajadores sentados con café hablando en voz baja (plano medio, casi quietos) |
| P1-085 | 5:13.7 | 3.6 | p09 | Advertencias. | Trabajador mira de reojo | N32 | NEW | trabajador | gpt-image-2 + Runway 5 s | medio | 0.35 | Trabajador (uno) mira de reojo, advierte en silencio; primer plano |
| P1-086 | 5:17.3 | 4.5 | p09 | …no formaban parte del personal | Hombre civil en sala de retención | N33 | NEW | George | gpt-image-2 + Runway 10 s | medio | 0.60 | Por la ventanilla de una puerta: hombre civil sentado en un catre de una sala de retención |
| P1-087 | 5:21.8 | 3.6 | p09 | …especialmente importante | Thomas mira por la ventanilla | N34 | NEW | Thomas | gpt-image-2 + Runway 5 s | medio | 0.35 | Thomas (C1) mira por la ventanilla de la puerta; primer plano de perfil |
| P1-088 | 5:25.4 | 5.4 | p09 | …un hombre al que identificó como George | Retrato de George | N35 | NEW | George | gpt-image-2 + Runway 10 s | medio | 0.60 | GEORGE retrato: ~55 años, delgado, barba canosa, camisa de franela civil; levanta la vista |
| P1-089 | 5:30.8 | 4.6 | p09 | …llevado allí. Contra su voluntad. | George primer plano | N36 | NEW | George | gpt-image-2 + Runway 5 s | medio | 0.35 | George primer plano, ojos cansados; respira |
| P1-090 | 5:35.4 | 6.9 | p10 | …podía justificar muchas cosas | Thomas camina pensativo | N37 | NEW | Thomas | gpt-image-2 + Runway 10 s | medio | 0.60 | Thomas (C1) camina despacio por corredor, pensativo; dolly hacia atrás |
| P1-091 | 5:42.3 | 4.6 | p10 | …la presencia de seres… | (otro tramo) figuras en corredor | D04-02 (reuso) | RECUT |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Gris + reptiliano en corredor 0–5 s; al final el reptiliano cambia. |
| P1-092 | 5:46.9 | 5.7 | p10 | …una persona retenida contra su voluntad | (otro tramo) George | N35 (reuso) | NEW | George | gpt-image-2 + Runway 10 s | medio | 0.00 | GEORGE retrato: ~55 años, delgado, barba canosa, camisa de franela civil; levanta la vista |
| P1-093 | 5:52.6 | 6.9 | p10 | Era una cuestión moral. | Thomas en luz baja, push-in | N38 | NEW | Thomas | gpt-image-2 + Runway 10 s | medio | 0.60 | Thomas (C1) primer plano en luz baja, conflicto; push-in |
| P1-094 | 5:59.5 | 5.7 | p10 | …zonas a las que no tenía acceso | (otro tramo) puerta roja | D03-06 (reuso) | RECUT |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Puerta con luz roja 0–2.5 s; luego haz de linterna aparece y cámara gira. |
| P1-095 | 6:05.2 | 5.2 | p11 | …empezaron a mostrarle información. Documentos. | Carpeta bajo la lámpara | N39 | NEW |  | gpt-image-2 + FFmpeg (movimiento de cámara) | nulo | 0.10 | Oficina en penumbra: carpeta sobre la mesa bajo lámpara (sin manos) |
| P1-096 | 6:10.4 | 5.2 | p11 | Nombres. Personas desaparecidas. | Ficheros sin rostro, sin texto | N40 | NEW |  | gpt-image-2 + FFmpeg (movimiento de cámara) | nulo | 0.10 | Ficheros con fotos sin rostro y fichas en blanco, cenital (sin texto legible) |
| P1-097 | 6:15.6 | 4.2 | p11 | Fragmentos de una historia… | Carpeta con foto (0–4 s) | D06-06 | RECUT |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Carpeta con foto (inserto de documentos); estable 0–4 s. |
| P1-098 | 6:19.8 | 4.2 | p11 | …no estaban allí voluntariamente | (otro tramo) sala de retención | N33 (reuso) | NEW | George | gpt-image-2 + Runway 10 s | medio | 0.00 | Por la ventanilla de una puerta: hombre civil sentado en un catre de una sala de retención |
| P1-099 | 6:24.0 | 11.0 | p11 | …apareció una palabra… NIGHTMARE HALL | Corredor rojo con niebla + rótulo G4 | N41 | NEW |  | gpt-image-2 + Runway 10 s | bajo | 0.60 | Corredor inferior con niebla y luces de emergencia rojas; el fondo nunca se ve (Nightmare Hall, sin revelar) |
| P1-100 | 6:35.0 | 5.9 | p12 | …niveles más restringidos | Corte transversal: se ilumina el nivel inferior | G1 (reuso) | NEW |  | Motion graphics (FFmpeg/ASS, sin IA) | nulo | 0.00 | Corte transversal animado: 7 niveles bajo la mesa (sin datos inventados, etiqueta 'según el relato') |
| P1-101 | 6:40.9 | 1.5 | p12 | Personas. | Flash: pulso en el puente | D05-02 | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Pulso sobre puente; solo como flash. |
| P1-102 | 6:42.4 | 1.5 | p12 | Seres. | Flash: corredor rojo | N41 (reuso) | NEW |  | gpt-image-2 + Runway 10 s | bajo | 0.00 | Corredor inferior con niebla y luces de emergencia rojas; el fondo nunca se ve (Nightmare Hall, sin revelar) |
| P1-103 | 6:43.9 | 1.5 | p12 | Contención. | Flash: gris en el haz | D04-01 (reuso) | REANIMATE |  | Runway (reanimar still aprobado, solo cámara) | medio | 0.00 | Gris MUTA a humanoide blanco y camina; still inicial excelente. |
| P1-104 | 6:45.4 | 1.6 | p12 | Experimentación. | Flash: compuerta con niebla | N44 | NEW |  | gpt-image-2 + Runway 5 s | bajo | 0.35 | Compuerta blindada del nivel inferior entreabierta, niebla, luz roja (la puerta no se mueve) |
| P1-105 | 6:47.0 | 5.9 | p12 | …tuvo que tomar una decisión | (otro tramo) Thomas en el ascensor | D03-03 (reuso) | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Interior ascensor; estable. |
| P1-106 | 6:52.9 | 5.9 | p12 | …regresar a casa cada noche | (otro tramo) familia por la ventana | D12-06 (reuso) | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Familia vista por la ventana; estable. |
| P1-107 | 6:58.8 | 5.9 | p12 | O podía averiguar… | Botón del nivel más bajo se ilumina | N42 | NEW |  | gpt-image-2 + FFmpeg (movimiento de cámara) | nulo | 0.10 | Panel de ascensor: el botón del nivel más bajo se ilumina (sin manos) |
| P1-108 | 7:04.7 | 5.3 | p12 | …qué había realmente debajo | (otro tramo) puertas se abren | D03-04 (reuso) | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Puertas abren a pasaje cálido; estable. |
| P1-109 | 7:10.0 | 5.7 | p13 | …eligió bajar | Thomas desciende, luz roja | N43 | NEW | Thomas | gpt-image-2 + Runway 10 s | medio | 0.60 | Thomas (C1) dentro del ascensor bajando; luz roja sube por su cara |
| P1-110 | 7:15.7 | 4.8 | p13 | …transformó completamente su historia | Compuerta entreabierta | N44 (reuso) | NEW |  | gpt-image-2 + Runway 5 s | bajo | 0.00 | Compuerta blindada del nivel inferior entreabierta, niebla, luz roja (la puerta no se mueve) |
| P1-111 | 7:20.5 | 1.4 | p13 | Cámaras de contención. | Flash: cámaras (Parte II, solo insinuado) | D01-06 | RECUT |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Solo flash ≤1.5 s como avance; material reservado para Parte II. Cámaras casi idénticas a D01-04; repetitivo en Parte I. |
| P1-112 | 7:21.9 | 1.4 | p13 | Personas retenidas. | Flash: sala de retención | N33 (reuso) | NEW | George | gpt-image-2 + Runway 10 s | medio | 0.00 | Por la ventanilla de una puerta: hombre civil sentado en un catre de una sala de retención |
| P1-113 | 7:23.3 | 1.4 | p13 | Experimentos. | Flash: cámaras en penumbra | D01-05 | RECUT |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Solo flash ≤1.5 s como avance; material reservado para Parte II. Cámaras casi idénticas a D01-04; repetitivo en Parte I. |
| P1-114 | 7:24.7 | 1.4 | p13 | Seres que no podía identificar. | Flash: reptiliano | N12 (reuso) | NEW | reptiliano | gpt-image-2 + Runway 5 s | medio | 0.00 | Reptiliano (R1) plano medio de perfil en corredor, respira, gira apenas |
| P1-115 | 7:26.1 | 3.8 | p13 | …Nightmare Hall | (otro tramo) corredor rojo | N41 (reuso) | NEW |  | gpt-image-2 + Runway 10 s | bajo | 0.00 | Corredor inferior con niebla y luces de emergencia rojas; el fondo nunca se ve (Nightmare Hall, sin revelar) |
| P1-116 | 7:29.9 | 5.7 | p13 | …quién era realmente Thomas Edwin Castello | Archivador con carpetas vacías | N45 | NEW |  | gpt-image-2 + FFmpeg (movimiento de cámara) | nulo | 0.10 | Archivador con cajón abierto y carpetas vacías (¿existió?) |
| P1-117 | 7:35.6 | 5.7 | p13 | ¿podemos demostrar que este hombre existió? | Retrato de Thomas desaturado + G5 | D07-03 (reuso) | KEEP |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Retrato de Thomas mirando arriba; excelente identidad. |
| P1-118 | 7:41.3 | 2.0 | p13 | (pausa) | Negro breve | G7 | NEW |  | Motion graphics (FFmpeg/ASS, sin IA) | nulo | 0.00 | Tarjeta final negra: DULCE — PARTE II: NIGHTMARE HALL |
| P1-119 | 7:43.3 | 4.7 | p14 | …entraremos en Nightmare Hall | (otro tramo) corredor, más profundo | N41 (reuso) | NEW |  | gpt-image-2 + Runway 10 s | bajo | 0.00 | Corredor inferior con niebla y luces de emergencia rojas; el fondo nunca se ve (Nightmare Hall, sin revelar) |
| P1-120 | 7:48.0 | 3.8 | p14 | …qué aseguró que había visto | (otro tramo) cámaras | D01-05 (reuso) | RECUT |  | Existente (FFmpeg: in/out, reencuadre) | bajo | 0.00 | Solo flash ≤1.5 s como avance; material reservado para Parte II. Cámaras casi idénticas a D01-04; repetitivo en Parte I. |
| P1-121 | 7:51.8 | 3.8 | p14 | …las personas retenidas | (otro tramo) George | N36 (reuso) | NEW | George | gpt-image-2 + Runway 5 s | medio | 0.00 | George primer plano, ojos cansados; respira |
| P1-122 | 7:55.6 | 3.8 | p14 | …el conflicto dentro de Dulce | Luz de emergencia giratoria | N46 | NEW |  | gpt-image-2 + Runway 5 s | bajo | 0.35 | Luz giratoria de emergencia roja en corredor vacío |
| P1-123 | 7:59.4 | 5.7 | p14 | …el origen real de la leyenda | Cielo nocturno sobre la mesa | N47 | NEW |  | gpt-image-2 + Runway 10 s | bajo | 0.60 | Cielo nocturno sobre la mesa de Nuevo México, estrellas, paneo |
| P1-124 | 8:05.1 | 5.7 | p14 | …Paul Bennewitz | Equipo de radio + rótulo G6 | N48 | NEW |  | gpt-image-2 + Runway 5 s | bajo | 0.35 | Equipo de radio de los 70-80 con osciloscopio encendido en un despacho (sin persona) |
| P1-125 | 8:10.8 | 4.7 | p14 | …una posibilidad completamente diferente | Antenas contra el cielo | N49 | NEW |  | gpt-image-2 + Runway 5 s | bajo | 0.35 | Antenas en un tejado contra el cielo nocturno |
| P1-126 | 8:15.5 | 7.1 | p14 | …sino con desinformación. | Máquina de escribir, documentos tachados | N50 | NEW |  | gpt-image-2 + FFmpeg (movimiento de cámara) | nulo | 0.10 | Máquina de escribir y documentos tachados en blanco bajo lámpara |
| P1-127 | 8:22.6 | 6.0 | end | CORTE A NEGRO | DULCE — PARTE II: NIGHTMARE HALL | G7 (reuso) | NEW |  | Motion graphics (FFmpeg/ASS, sin IA) | nulo | 0.00 | Tarjeta final negra: DULCE — PARTE II: NIGHTMARE HALL |

## Auditoría V1 (73 planos)

| Plano | Veredicto | Nota |
|---|---|---|
| D01-01 | KEEP | Corredor, Thomas de espaldas; estable. |
| D01-02 | RECUT | Perfil estable 0–3 s; después gesto mano-cara innecesario. |
| D01-03 | KEEP | Thomas ante gris + reptiliano al fondo; estable. |
| D01-04 | KEEP | Laboratorio (clip de biblioteca) con pulso y vapor; el mejor laboratorio. |
| D01-05 | PART-II | Cámaras casi idénticas a D01-04; repetitivo en Parte I. |
| D01-06 | PART-II | Cámaras casi idénticas a D01-04; repetitivo en Parte I. |
| D01-07 | RECUT | Reflejo reptiliano tras Thomas 0–3 s; luego aparece figura andando en el fondo. |
| D02-01 | ABANDON | Cocina: Thomas con linterna en casa, esposa en interruptor; historia V1. |
| D02-02 | ABANDON | Mano coge llaves; acción V1 (sustituido por D12-04). |
| D02-03 | KEEP | Camioneta alejándose de noche; estable. |
| D02-04 | RECUT | Thomas ajusta bisagra; manos estables 0–4 s. |
| D02-05 | ABANDON | Brazo extra entrando por la derecha (ya en el still). |
| D02-06 | RECUT | Terminal; aparece un '!' generado a mitad; usar 0–2.5 s. |
| D03-01 | KEEP | Radio en corredor; estable (no usado: redundante). |
| D03-02 | ABANDON | DUPLICACIÓN: dos Thomas en el ascensor. |
| D03-03 | KEEP | Interior ascensor; estable. |
| D03-04 | KEEP | Puertas abren a pasaje cálido; estable. |
| D03-05 | KEEP | Rejilla con cinta; estable. |
| D03-06 | RECUT | Puerta con luz roja 0–2.5 s; luego haz de linterna aparece y cámara gira. |
| D04-01 | REANIMATE | Gris MUTA a humanoide blanco y camina; still inicial excelente. |
| D04-02 | RECUT | Gris + reptiliano en corredor 0–5 s; al final el reptiliano cambia. |
| D04-03 | KEEP | Thomas alza credencial hacia figuras; estable. |
| D04-04 | RECUT | Gris avanza y crece/aclara; usar 0–3 s. |
| D04-05 | PART-II | Hombre en cámara de contención; material de Parte II (y se parece a Thomas). |
| D04-06 | PART-II | Mano contra el cristal; Parte II. |
| D05-01 | KEEP | Silueta de Thomas observando cámaras; estable. |
| D05-02 | KEEP | Pulso sobre puente; solo como flash. |
| D05-03 | PART-II | Hombre respirando en cámara; Parte II. |
| D05-04 | ABANDON | Mano se DEFORMA en puño. |
| D05-05 | PART-II | Hombre en cámara gesto de dedo; Parte II. |
| D05-06 | RECUT | Primer plano de Thomas 0–2.5 s; después mano a la boca y la cara cambia. |
| D06-01 | RECUT | Técnico entra por puerta; usar 0–4 s. |
| D06-02 | KEEP | Técnico gira mando junto a Thomas; estable. |
| D06-03 | KEEP | Técnico escribe en portapapeles; estable. |
| D06-04 | ABANDON | Thomas golpea el cristal: acción V1, sin sitio en Parte I. |
| D06-05 | RECUT | Técnico tapa portapapeles 0–2 s; después el portapapeles desaparece. |
| D06-06 | RECUT | Carpeta con foto (inserto de documentos); estable 0–4 s. |
| D07-01 | KEEP | Thomas camina por corredor; estable. |
| D07-02 | RECUT | Radio al oído; luz roja rara en la cara; usar 0–3 s. |
| D07-03 | KEEP | Retrato de Thomas mirando arriba; excelente identidad. |
| D07-04 | RECUT | Cámara de seguridad gira 0–3.5 s; luego asoma una cara abajo a la izquierda. |
| D07-05 | KEEP | Thomas junto a puerta de servicio; estable. |
| D07-06 | KEEP | Corredor largo, figura lejana; estable. |
| D08-01 | KEEP | Thomas camina hacia cámara; estable. |
| D08-02 | ABANDON | Vaso y radio con destello de luz extraño. |
| D08-03 | RECUT | Credencial en lector; la tarjeta desaparece tras 2 s. |
| D08-04 | KEEP | Guardia en ventanilla, alguien pasa al fondo; estable. |
| D08-05 | ABANDON | DUPLICACIÓN: dos Thomas junto a la camioneta. |
| D08-06 | KEEP | Camioneta llega a casa de noche; estable. |
| D09-01 | ABANDON | Mesa vacía (historia V1: familia desaparecida). |
| D09-02 | ABANDON | Vaso junto al fregadero; V1. |
| D09-03 | ABANDON | Thomas se funde en sombra al abrir puerta. |
| D09-04 | KEEP | Thomas en la cocina, pensativo; identidad correcta. |
| D09-05 | ABANDON | Faros: la cocina cambia de iluminación entera. |
| D09-06 | ABANDON | Familia en la puerta + cámara acaba en la espalda de Thomas (acción de puerta). |
| D10-01 | ABANDON | Esposa y niño intercambian posiciones; aparece un coche. |
| D10-02 | ABANDON | Familia de pie, Thomas con linterna en casa. |
| D10-03 | ABANDON | La cara de Thomas cambia (canoso) mientras sirve. |
| D10-04 | KEEP | Esposa, primer plano (v2 reencuadrado); estable. |
| D10-05 | KEEP | Hijo moreno con madre de espaldas; estable. |
| D10-06 | ABANDON | Gesto de dedos: trama V1. |
| D11-01 | ABANDON | Thomas come: otra cara y boca abierta al final. |
| D11-02 | KEEP | Lámpara de porche (no usado: redundante). |
| D11-03 | KEEP | Esposa habla (v2 reencuadrado); estable. |
| D11-04 | KEEP | Hijo cuenta algo; estable. |
| D11-05 | ABANDON | Brazo se ESTIRA de forma imposible. |
| D11-06 | KEEP | Esposa sonríe; estable. |
| D12-01 | KEEP | Familia sentada a la mesa, plano maestro; estable. |
| D12-02 | ABANDON | Manos flotan y se deforman. |
| D12-03 | KEEP | Esposa sobre el hombro de Thomas; ideal para 'Thomas callado'. |
| D12-04 | KEEP | Dibujo familiar + llaves; estable. |
| D12-05 | ABANDON | Exterior casa: aparece una figura en la puerta. |
| D12-06 | KEEP | Familia vista por la ventana; estable. |

## Assets nuevos

| ID | Tipo | Descripción | Personajes | Riesgo |
|---|---|---|---|---|
| N01 | img+rw10 | Exterior Nuevo México: mesa y cañones al atardecer, dron lento hacia delante |  | bajo |
| N02 | img+rw5 | Luces de un pueblo pequeño en la llanura, noche, paneo lento |  | bajo |
| N03 | img+rw5 | Entrada de instalación excavada en la roca: valla, reflectores, puesto de guardia vacío |  | bajo |
| N04 | img+rw10 | Túnel de vehículos interminable, luces que se pierden; dolly adelante |  | bajo |
| N05 | img+rw10 | Sala de control de seguridad: Thomas (C1, uniforme oscuro) ante monitores CCTV; solo respira y mira | Thomas | medio |
| N06 | img+rw5 | Lector de credencial en pared de hormigón, LED verde (sustituye D02-05); push-in, sin manos |  | bajo |
| N07 | img+rw10 | Puerta blindada con franja de color de zona y teclado; LED rojo parpadea |  | bajo |
| N08 | img+rw5 | Barrera: línea pintada en el suelo y torniquete; guardia inmóvil al fondo desenfocado | guardia | medio |
| N09 | img+rw10 | Área técnica: tuberías, generadores, pasarela, vapor; sin personas |  | bajo |
| N10 | img+rw10 | Hueco de ascensor de carga mirando hacia abajo, luces que descienden en la oscuridad |  | bajo |
| N11 | img+rw5 | Gris (G1) plano medio en sala técnica, leve giro de cabeza | gris | medio |
| N12 | img+rw5 | Reptiliano (R1) plano medio de perfil en corredor, respira, gira apenas | reptiliano | medio |
| N13 | img+rw10 | Gris sentado ante consola, visto de lado/espaldas, pantallas parpadean (manos ocultas) | gris | medio |
| N14 | img+rw10 | Técnico humano (T1) y gris en extremos de una mesa de laboratorio; ninguno se mueve de sitio | técnico, gris | alto |
| N15 | img+rw5 | Reptiliano tras cristal de sala de control, silueta ante monitores | reptiliano | medio |
| N16 | img+rw5 | POV de Thomas: corredor, un gris quieto lejos en una intersección | gris | medio |
| N17 | img+ff | Reloj de fichar y tarjetas en su rack (inserto, sin personas) |  | nulo |
| N18 | img+rw5 | Torniquetes de turno: personal de espaldas desenfocado, sin cruces | personal | medio |
| N19 | img+rw10 | Oficina: humano teclea en primer plano; tras cristal esmerilado pasa la silueta de un gris | gris, personal | medio |
| N20 | img+rw10 | Thomas (C1) primer plano en la mesa de la cena, callado; push-in muy lento | Thomas | medio |
| N21 | img+rw5 | Amanecer: la misma camioneta marrón sale de la casa hacia el desierto |  | bajo |
| N22 | img+rw10 | Thomas (C1) primer plano en corredor, silencio; push-in | Thomas | medio |
| N23 | img+rw10 | Mampara de cristal: dos técnicos humanos a un lado, un gris lejos al otro; estático | personal, gris | alto |
| N24 | img+ff | Banco de monitores CCTV mostrando corredores (inserto) |  | nulo |
| N25 | img+rw10 | Thomas (C1) ante ventana de observación, reflejo del laboratorio en el cristal | Thomas | medio |
| N26 | img+rw10 | Sala médica clínica (distinta del laboratorio de cámaras): camilla vacía, instrumental, luz blanca-verde |  | bajo |
| N27 | img+rw5 | Equipamiento extraño: recipientes de vidrio, cables, luces que laten |  | bajo |
| N28 | img+rw5 | Técnico humano al microscopio; un gris observa a su lado sin tocar nada | técnico, gris | alto |
| N29 | img+rw5 | Galería de observación desde arriba: laboratorio con figuras pequeñas | personal | medio |
| N30 | img+rw5 | Puerta de ascensor sin botón de llamada, nivel inferior; Thomas la mira de espaldas | Thomas | medio |
| N31 | img+rw10 | Sala de descanso: dos trabajadores sentados con café hablando en voz baja (plano medio, casi quietos) | trabajadores | medio |
| N32 | img+rw5 | Trabajador (uno) mira de reojo, advierte en silencio; primer plano | trabajador | medio |
| N33 | img+rw10 | Por la ventanilla de una puerta: hombre civil sentado en un catre de una sala de retención | George | medio |
| N34 | img+rw5 | Thomas (C1) mira por la ventanilla de la puerta; primer plano de perfil | Thomas | medio |
| N35 | img+rw10 | GEORGE retrato: ~55 años, delgado, barba canosa, camisa de franela civil; levanta la vista | George | medio |
| N36 | img+rw5 | George primer plano, ojos cansados; respira | George | medio |
| N37 | img+rw10 | Thomas (C1) camina despacio por corredor, pensativo; dolly hacia atrás | Thomas | medio |
| N38 | img+rw10 | Thomas (C1) primer plano en luz baja, conflicto; push-in | Thomas | medio |
| N39 | img+ff | Oficina en penumbra: carpeta sobre la mesa bajo lámpara (sin manos) |  | nulo |
| N40 | img+ff | Ficheros con fotos sin rostro y fichas en blanco, cenital (sin texto legible) |  | nulo |
| N41 | img+rw10 | Corredor inferior con niebla y luces de emergencia rojas; el fondo nunca se ve (Nightmare Hall, sin revelar) |  | bajo |
| N42 | img+ff | Panel de ascensor: el botón del nivel más bajo se ilumina (sin manos) |  | nulo |
| N43 | img+rw10 | Thomas (C1) dentro del ascensor bajando; luz roja sube por su cara | Thomas | medio |
| N44 | img+rw5 | Compuerta blindada del nivel inferior entreabierta, niebla, luz roja (la puerta no se mueve) |  | bajo |
| N45 | img+ff | Archivador con cajón abierto y carpetas vacías (¿existió?) |  | nulo |
| N46 | img+rw5 | Luz giratoria de emergencia roja en corredor vacío |  | bajo |
| N47 | img+rw10 | Cielo nocturno sobre la mesa de Nuevo México, estrellas, paneo |  | bajo |
| N48 | img+rw5 | Equipo de radio de los 70-80 con osciloscopio encendido en un despacho (sin persona) |  | bajo |
| N49 | img+rw5 | Antenas en un tejado contra el cielo nocturno |  | bajo |
| N50 | img+ff | Máquina de escribir y documentos tachados en blanco bajo lámpara |  | nulo |
| G1 | gfx | Corte transversal animado: 7 niveles bajo la mesa (sin datos inventados, etiqueta 'según el relato') |  | nulo |
| G2 | gfx | Rótulo 'Thomas Edwin Castello — recreación' |  | nulo |
| G3 | gfx | Título DULCE — PARTE I sobre imagen en movimiento |  | nulo |
| G4 | gfx | Rótulo NIGHTMARE HALL / El Pasillo de las Pesadillas |  | nulo |
| G5 | gfx | Pregunta '¿Existió Thomas Castello?' sobre retrato desaturado |  | nulo |
| G6 | gfx | Rótulo 'Paul Bennewitz' (sin retrato: no recreamos a una persona real) |  | nulo |
| G7 | gfx | Tarjeta final negra: DULCE — PARTE II: NIGHTMARE HALL |  | nulo |

## Resumen

```json
{
 "estimatedNarrationSeconds": 502.0,
 "language": "en-US",
 "speed": 0.92,
 "timelineSeconds": 508.6,
 "slots": 127,
 "droppedRepeats": 7,
 "uniqueV1Used": 45,
 "v1UsedByAction": {
  "KEEP": 29,
  "PART-II": 2,
  "RECUT": 13,
  "REANIMATE": 1
 },
 "slotActions": {
  "NEW": 66,
  "KEEP": 39,
  "RECUT": 19,
  "REANIMATE": 2,
  "REPLACE": 1
 },
 "newGenerations": {
  "images": 50,
  "runway5s": 22,
  "runway10s": 22,
  "ffmpegStillMoves": 7,
  "graphics": 7
 },
 "reanimate": [
  "D04-01"
 ],
 "abandoned": [
  "D02-01",
  "D02-02",
  "D02-05",
  "D03-02",
  "D05-04",
  "D06-04",
  "D08-02",
  "D08-05",
  "D09-01",
  "D09-02",
  "D09-03",
  "D09-05",
  "D09-06",
  "D10-01",
  "D10-02",
  "D10-03",
  "D10-06",
  "D11-01",
  "D11-05",
  "D12-02",
  "D12-05"
 ],
 "partII": [
  "D01-05",
  "D01-06",
  "D04-05",
  "D04-06",
  "D05-03",
  "D05-05"
 ],
 "unusedGood": [
  "D01-02",
  "D03-01",
  "D11-02"
 ],
 "budget": {
  "A_images": 5.0,
  "A_images_worst": 15.0,
  "B_animation": 16.5,
  "C_voice": 2.76,
  "voiceChars": 7369,
  "D_retries": 8.27,
  "E_expected": 32.53,
  "F_worstCase": 64.12
 }
}
```
