"""Dulce Part I V2 storyboard + budget (planning only, no API calls).
Writes content/long-form/dulce-part1/storyboard.json and docs/quality/dulce-part1/STORYBOARD.md."""
import json, math, os
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
script = json.load(open(f"{ROOT}/content/long-form/dulce-part1/script-es.json"))
WPS, TAIL = 2.2, 1.0  # Spanish documentary pace incl. pauses; breath between beats
beat_secs = {b["id"]: round(len(b["narration"].split()) / WPS + TAIL, 1) for b in script["beats"]}

# ---- V1 audit (temporal: 6 frames across each shot's edit window in master v2) ----
AUDIT = {
 "D01-01": ("KEEP", "Corredor, Thomas de espaldas; estable."),
 "D01-02": ("RECUT", "Perfil estable 0–3 s; después gesto mano-cara innecesario."),
 "D01-03": ("KEEP", "Thomas ante gris + reptiliano al fondo; estable."),
 "D01-04": ("KEEP", "Laboratorio (clip de biblioteca) con pulso y vapor; el mejor laboratorio."),
 "D01-05": ("PART-II", "Cámaras casi idénticas a D01-04; repetitivo en Parte I."),
 "D01-06": ("PART-II", "Cámaras casi idénticas a D01-04; repetitivo en Parte I."),
 "D01-07": ("RECUT", "Reflejo reptiliano tras Thomas 0–3 s; luego aparece figura andando en el fondo."),
 "D02-01": ("ABANDON", "Cocina: Thomas con linterna en casa, esposa en interruptor; historia V1."),
 "D02-02": ("ABANDON", "Mano coge llaves; acción V1 (sustituido por D12-04)."),
 "D02-03": ("KEEP", "Camioneta alejándose de noche; estable."),
 "D02-04": ("RECUT", "Thomas ajusta bisagra; manos estables 0–4 s."),
 "D02-05": ("ABANDON", "Brazo extra entrando por la derecha (ya en el still)."),
 "D02-06": ("RECUT", "Terminal; aparece un '!' generado a mitad; usar 0–2.5 s."),
 "D03-01": ("KEEP", "Radio en corredor; estable (no usado: redundante)."),
 "D03-02": ("ABANDON", "DUPLICACIÓN: dos Thomas en el ascensor."),
 "D03-03": ("KEEP", "Interior ascensor; estable."),
 "D03-04": ("KEEP", "Puertas abren a pasaje cálido; estable."),
 "D03-05": ("KEEP", "Rejilla con cinta; estable."),
 "D03-06": ("RECUT", "Puerta con luz roja 0–2.5 s; luego haz de linterna aparece y cámara gira."),
 "D04-01": ("REANIMATE", "Gris MUTA a humanoide blanco y camina; still inicial excelente."),
 "D04-02": ("RECUT", "Gris + reptiliano en corredor 0–5 s; al final el reptiliano cambia."),
 "D04-03": ("KEEP", "Thomas alza credencial hacia figuras; estable."),
 "D04-04": ("RECUT", "Gris avanza y crece/aclara; usar 0–3 s."),
 "D04-05": ("PART-II", "Hombre en cámara de contención; material de Parte II (y se parece a Thomas)."),
 "D04-06": ("PART-II", "Mano contra el cristal; Parte II."),
 "D05-01": ("KEEP", "Silueta de Thomas observando cámaras; estable."),
 "D05-02": ("KEEP", "Pulso sobre puente; solo como flash."),
 "D05-03": ("PART-II", "Hombre respirando en cámara; Parte II."),
 "D05-04": ("ABANDON", "Mano se DEFORMA en puño."),
 "D05-05": ("PART-II", "Hombre en cámara gesto de dedo; Parte II."),
 "D05-06": ("RECUT", "Primer plano de Thomas 0–2.5 s; después mano a la boca y la cara cambia."),
 "D06-01": ("RECUT", "Técnico entra por puerta; usar 0–4 s."),
 "D06-02": ("KEEP", "Técnico gira mando junto a Thomas; estable."),
 "D06-03": ("KEEP", "Técnico escribe en portapapeles; estable."),
 "D06-04": ("ABANDON", "Thomas golpea el cristal: acción V1, sin sitio en Parte I."),
 "D06-05": ("RECUT", "Técnico tapa portapapeles 0–2 s; después el portapapeles desaparece."),
 "D06-06": ("RECUT", "Carpeta con foto (inserto de documentos); estable 0–4 s."),
 "D07-01": ("KEEP", "Thomas camina por corredor; estable."),
 "D07-02": ("RECUT", "Radio al oído; luz roja rara en la cara; usar 0–3 s."),
 "D07-03": ("KEEP", "Retrato de Thomas mirando arriba; excelente identidad."),
 "D07-04": ("RECUT", "Cámara de seguridad gira 0–3.5 s; luego asoma una cara abajo a la izquierda."),
 "D07-05": ("KEEP", "Thomas junto a puerta de servicio; estable."),
 "D07-06": ("KEEP", "Corredor largo, figura lejana; estable."),
 "D08-01": ("KEEP", "Thomas camina hacia cámara; estable."),
 "D08-02": ("ABANDON", "Vaso y radio con destello de luz extraño."),
 "D08-03": ("RECUT", "Credencial en lector; la tarjeta desaparece tras 2 s."),
 "D08-04": ("KEEP", "Guardia en ventanilla, alguien pasa al fondo; estable."),
 "D08-05": ("ABANDON", "DUPLICACIÓN: dos Thomas junto a la camioneta."),
 "D08-06": ("KEEP", "Camioneta llega a casa de noche; estable."),
 "D09-01": ("ABANDON", "Mesa vacía (historia V1: familia desaparecida)."),
 "D09-02": ("ABANDON", "Vaso junto al fregadero; V1."),
 "D09-03": ("ABANDON", "Thomas se funde en sombra al abrir puerta."),
 "D09-04": ("KEEP", "Thomas en la cocina, pensativo; identidad correcta."),
 "D09-05": ("ABANDON", "Faros: la cocina cambia de iluminación entera."),
 "D09-06": ("ABANDON", "Familia en la puerta + cámara acaba en la espalda de Thomas (acción de puerta)."),
 "D10-01": ("ABANDON", "Esposa y niño intercambian posiciones; aparece un coche."),
 "D10-02": ("ABANDON", "Familia de pie, Thomas con linterna en casa."),
 "D10-03": ("ABANDON", "La cara de Thomas cambia (canoso) mientras sirve."),
 "D10-04": ("KEEP", "Esposa, primer plano (v2 reencuadrado); estable."),
 "D10-05": ("KEEP", "Hijo moreno con madre de espaldas; estable."),
 "D10-06": ("ABANDON", "Gesto de dedos: trama V1."),
 "D11-01": ("ABANDON", "Thomas come: otra cara y boca abierta al final."),
 "D11-02": ("KEEP", "Lámpara de porche (no usado: redundante)."),
 "D11-03": ("KEEP", "Esposa habla (v2 reencuadrado); estable."),
 "D11-04": ("KEEP", "Hijo cuenta algo; estable."),
 "D11-05": ("ABANDON", "Brazo se ESTIRA de forma imposible."),
 "D11-06": ("KEEP", "Esposa sonríe; estable."),
 "D12-01": ("KEEP", "Familia sentada a la mesa, plano maestro; estable."),
 "D12-02": ("ABANDON", "Manos flotan y se deforman."),
 "D12-03": ("KEEP", "Esposa sobre el hombro de Thomas; ideal para 'Thomas callado'."),
 "D12-04": ("KEEP", "Dibujo familiar + llaves; estable."),
 "D12-05": ("ABANDON", "Exterior casa: aparece una figura en la puerta."),
 "D12-06": ("KEEP", "Familia vista por la ventana; estable."),
}

# ---- New assets (generated once, can serve several slots) ----
# kind: img+rw5 / img+rw10 (gpt-image-2 still + Runway gen4_turbo), img+ff (still + FFmpeg camera move), gfx (motion graphic, free), rw5 (reanimate approved still)
NEW = {
 "N01": ("img+rw10", "Exterior Nuevo México: mesa y cañones al atardecer, dron lento hacia delante", [], "bajo"),
 "N02": ("img+rw5",  "Luces de un pueblo pequeño en la llanura, noche, paneo lento", [], "bajo"),
 "N03": ("img+rw5",  "Entrada de instalación excavada en la roca: valla, reflectores, puesto de guardia vacío", [], "bajo"),
 "N04": ("img+rw10", "Túnel de vehículos interminable, luces que se pierden; dolly adelante", [], "bajo"),
 "N05": ("img+rw10", "Sala de control de seguridad: Thomas (C1, uniforme oscuro) ante monitores CCTV; solo respira y mira", ["Thomas"], "medio"),
 "N06": ("img+rw5",  "Lector de credencial en pared de hormigón, LED verde (sustituye D02-05); push-in, sin manos", [], "bajo"),
 "N07": ("img+rw10", "Puerta blindada con franja de color de zona y teclado; LED rojo parpadea", [], "bajo"),
 "N08": ("img+rw5",  "Barrera: línea pintada en el suelo y torniquete; guardia inmóvil al fondo desenfocado", ["guardia"], "medio"),
 "N09": ("img+rw10", "Área técnica: tuberías, generadores, pasarela, vapor; sin personas", [], "bajo"),
 "N10": ("img+rw10", "Hueco de ascensor de carga mirando hacia abajo, luces que descienden en la oscuridad", [], "bajo"),
 "N11": ("img+rw5",  "Gris (G1) plano medio en sala técnica, leve giro de cabeza", ["gris"], "medio"),
 "N12": ("img+rw5",  "Reptiliano (R1) plano medio de perfil en corredor, respira, gira apenas", ["reptiliano"], "medio"),
 "N13": ("img+rw10", "Gris sentado ante consola, visto de lado/espaldas, pantallas parpadean (manos ocultas)", ["gris"], "medio"),
 "N14": ("img+rw10", "Técnico humano (T1) y gris en extremos de una mesa de laboratorio; ninguno se mueve de sitio", ["técnico", "gris"], "alto"),
 "N15": ("img+rw5",  "Reptiliano tras cristal de sala de control, silueta ante monitores", ["reptiliano"], "medio"),
 "N16": ("img+rw5",  "POV de Thomas: corredor, un gris quieto lejos en una intersección", ["gris"], "medio"),
 "N17": ("img+ff",   "Reloj de fichar y tarjetas en su rack (inserto, sin personas)", [], "nulo"),
 "N18": ("img+rw5",  "Torniquetes de turno: personal de espaldas desenfocado, sin cruces", ["personal"], "medio"),
 "N19": ("img+rw10", "Oficina: humano teclea en primer plano; tras cristal esmerilado pasa la silueta de un gris", ["gris", "personal"], "medio"),
 "N20": ("img+rw10", "Thomas (C1) primer plano en la mesa de la cena, callado; push-in muy lento", ["Thomas"], "medio"),
 "N21": ("img+rw5",  "Amanecer: la misma camioneta marrón sale de la casa hacia el desierto", [], "bajo"),
 "N22": ("img+rw10", "Thomas (C1) primer plano en corredor, silencio; push-in", ["Thomas"], "medio"),
 "N23": ("img+rw10", "Mampara de cristal: dos técnicos humanos a un lado, un gris lejos al otro; estático", ["personal", "gris"], "alto"),
 "N24": ("img+ff",   "Banco de monitores CCTV mostrando corredores (inserto)", [], "nulo"),
 "N25": ("img+rw10", "Thomas (C1) ante ventana de observación, reflejo del laboratorio en el cristal", ["Thomas"], "medio"),
 "N26": ("img+rw10", "Sala médica clínica (distinta del laboratorio de cámaras): camilla vacía, instrumental, luz blanca-verde", [], "bajo"),
 "N27": ("img+rw5",  "Equipamiento extraño: recipientes de vidrio, cables, luces que laten", [], "bajo"),
 "N28": ("img+rw5",  "Técnico humano al microscopio; un gris observa a su lado sin tocar nada", ["técnico", "gris"], "alto"),
 "N29": ("img+rw5",  "Galería de observación desde arriba: laboratorio con figuras pequeñas", ["personal"], "medio"),
 "N30": ("img+rw5",  "Puerta de ascensor sin botón de llamada, nivel inferior; Thomas la mira de espaldas", ["Thomas"], "medio"),
 "N31": ("img+rw10", "Sala de descanso: dos trabajadores sentados con café hablando en voz baja (plano medio, casi quietos)", ["trabajadores"], "medio"),
 "N32": ("img+rw5",  "Trabajador (uno) mira de reojo, advierte en silencio; primer plano", ["trabajador"], "medio"),
 "N33": ("img+rw10", "Por la ventanilla de una puerta: hombre civil sentado en un catre de una sala de retención", ["George"], "medio"),
 "N34": ("img+rw5",  "Thomas (C1) mira por la ventanilla de la puerta; primer plano de perfil", ["Thomas"], "medio"),
 "N35": ("img+rw10", "GEORGE retrato: ~55 años, delgado, barba canosa, camisa de franela civil; levanta la vista", ["George"], "medio"),
 "N36": ("img+rw5",  "George primer plano, ojos cansados; respira", ["George"], "medio"),
 "N37": ("img+rw10", "Thomas (C1) camina despacio por corredor, pensativo; dolly hacia atrás", ["Thomas"], "medio"),
 "N38": ("img+rw10", "Thomas (C1) primer plano en luz baja, conflicto; push-in", ["Thomas"], "medio"),
 "N39": ("img+ff",   "Oficina en penumbra: carpeta sobre la mesa bajo lámpara (sin manos)", [], "nulo"),
 "N40": ("img+ff",   "Ficheros con fotos sin rostro y fichas en blanco, cenital (sin texto legible)", [], "nulo"),
 "N41": ("img+rw10", "Corredor inferior con niebla y luces de emergencia rojas; el fondo nunca se ve (Nightmare Hall, sin revelar)", [], "bajo"),
 "N42": ("img+ff",   "Panel de ascensor: el botón del nivel más bajo se ilumina (sin manos)", [], "nulo"),
 "N43": ("img+rw10", "Thomas (C1) dentro del ascensor bajando; luz roja sube por su cara", ["Thomas"], "medio"),
 "N44": ("img+rw5",  "Compuerta blindada del nivel inferior entreabierta, niebla, luz roja (la puerta no se mueve)", [], "bajo"),
 "N45": ("img+ff",   "Archivador con cajón abierto y carpetas vacías (¿existió?)", [], "nulo"),
 "N46": ("img+rw5",  "Luz giratoria de emergencia roja en corredor vacío", [], "bajo"),
 "N47": ("img+rw10", "Cielo nocturno sobre la mesa de Nuevo México, estrellas, paneo", [], "bajo"),
 "N48": ("img+rw5",  "Equipo de radio de los 70-80 con osciloscopio encendido en un despacho (sin persona)", [], "bajo"),
 "N49": ("img+rw5",  "Antenas en un tejado contra el cielo nocturno", [], "bajo"),
 "N50": ("img+ff",   "Máquina de escribir y documentos tachados en blanco bajo lámpara", [], "nulo"),
 "G1": ("gfx", "Corte transversal animado: 7 niveles bajo la mesa (sin datos inventados, etiqueta 'según el relato')", [], "nulo"),
 "G2": ("gfx", "Rótulo 'Thomas Edwin Castello — recreación'", [], "nulo"),
 "G3": ("gfx", "Título DULCE — PARTE I sobre imagen en movimiento", [], "nulo"),
 "G4": ("gfx", "Rótulo NIGHTMARE HALL / El Pasillo de las Pesadillas", [], "nulo"),
 "G5": ("gfx", "Pregunta '¿Existió Thomas Castello?' sobre retrato desaturado", [], "nulo"),
 "G6": ("gfx", "Rótulo 'Paul Bennewitz' (sin retrato: no recreamos a una persona real)", [], "nulo"),
 "G7": ("gfx", "Tarjeta final negra: DULCE — PARTE II: NIGHTMARE HALL", [], "nulo"),
}
RW4 = {"D04-01": "Still aprobado (gris en el haz de linterna): solo push-in de cámara, 5 s."}

# ---- Storyboard: (beat, source, seconds, narration cue, visual intent) ----
S = []
def add(beat, src, sec, cue, visual):
    S.append({"beat": beat, "src": src, "sec": sec, "cue": cue, "visual": visual})
# p01 Hook: trailer rhythm, ~2.5-3.5 s per shot
add("p01","N01",3.0,"Durante décadas… Nuevo México","Mesa al atardecer, dron entrando")
add("p01","N02",2.8,"…una historia extraordinaria","Pueblo de noche a lo lejos")
add("p01","N03",3.0,"…oficialmente no existe","Entrada en la roca, reflectores")
add("p01","N04",2.6,"Kilómetros de túneles","Túnel interminable")
add("p01","G1",2.4,"Siete niveles","Corte transversal: 7 niveles se encienden")
add("p01","D01-04",2.0,"Laboratorios","Laboratorio con pulso cian")
add("p01","D03-06",2.0,"Áreas restringidas","Puerta con luz roja")
add("p01","D01-07",3.0,"…algo que nunca debió estar allí","Reptiliano en el reflejo tras Thomas")
add("p01","D04-01",2.4,"(sigue)","Gris en el haz de la linterna, push-in")
add("p01","D01-01",3.4,"…la leyenda de la Base Dulce","Thomas se aleja por el corredor")
add("p01","D01-03",3.4,"…atribuido a un solo hombre","Thomas frente a las dos figuras")
add("p01","D07-03",3.4,"Su nombre era Thomas Edwin Castello","Retrato de Thomas + rótulo G2 'recreación'")
add("p01","D03-04",3.6,"Y aseguró haber trabajado dentro.","Puertas del ascensor se abren + título G3 DULCE — PARTE I")
# p02
add("p02","N05",6.0,"Castello decía haber sido especialista en seguridad","Thomas en la sala de control CCTV")
add("p02","D02-03",4.5,"…lo llevó a una instalación… próxima a Dulce","Camioneta hacia la noche")
add("p02","D08-04",4.5,"Personal con diferentes niveles de autorización","Guardia en ventanilla, alguien pasa")
add("p02","D07-05",3.0,"Puertas controladas","Thomas junto a la puerta de servicio")
add("p02","D07-04",3.0,"Cámaras","Cámara de seguridad gira")
add("p02","N06",3.0,"Sistemas de identificación","Lector de credencial, LED verde")
add("p02","D02-06",2.5,"Secretos.","Terminal con cursor")
add("p02","D08-01",4.0,"Pero Dulce… era diferente","Thomas avanza hacia cámara")
add("p02","D03-03",5.4,"…cuanto más descendías… menos humana","Ascensor bajando, Thomas mira la puerta")
# p03
add("p03","G1",6.0,"…varios niveles subterráneos","Corte transversal detallado, zonas por color")
add("p03","D08-03",2.0,"…no era cuestión de tener una credencial","Credencial en lector (0–2 s)")
add("p03","N07",4.5,"Cada zona requería autorizaciones diferentes","Puerta blindada con franja de zona")
add("p03","D07-01",4.5,"Había lugares…","Thomas camina por corredor")
add("p03","N08",5.0,"…tenían prohibido conocer","Línea en el suelo y torniquete")
add("p03","D03-04",3.5,"Los ascensores conectaban…","(otro tramo) puertas de ascensor")
add("p03","D07-06",4.5,"Corredores aparentemente interminables","Corredor largo, figura lejana")
add("p03","N09",4.0,"…áreas técnicas","Tuberías y pasarelas")
add("p03","N10",6.2,"…lo más importante estaba abajo","Hueco de ascensor hacia la oscuridad")
# p04
add("p04","D04-03",5.0,"No eran las puertas. Eran quienes caminaban detrás","Thomas alza la credencial hacia las figuras")
add("p04","D04-02",5.0,"…los humanos no eran los únicos ocupantes","Gris y reptiliano en el corredor")
add("p04","N11",5.0,"…pequeños seres grises","Gris, plano medio")
add("p04","N12",5.0,"…apariencia reptiliana","Reptiliano de perfil")
add("p04","D04-04",3.0,"No los describía como prisioneros","El gris se hace a un lado (0–3 s)")
add("p04","N13",6.0,"…algunos trabajaban dentro","Gris ante consola")
add("p04","N14",6.0,"Compartían áreas con personal humano","Técnico y gris en la misma mesa")
add("p04","D06-02",4.0,"Participaban en actividades técnicas","Técnico ajusta mando junto a Thomas")
add("p04","N15",4.3,"…operación cotidiana… lo imposible, rutina","Reptiliano tras cristal de control")
# p05
add("p05","D05-06",2.5,"Imagina trabajar en un lugar así","Thomas primer plano (0–2.5 s)")
add("p05","N16",4.5,"El primer día…","POV: gris quieto al fondo")
add("p05","D07-06",3.5,"…semanas… meses","Corredor en time-lapse (reencuadre + velocidad)")
add("p05","N17",4.0,"Describe un trabajo. Turnos.","Reloj de fichar")
add("p05","D02-04",4.0,"Procedimientos.","Thomas ajusta bisagra (0–4 s)")
add("p05","D06-03",4.0,"Restricciones.","Técnico anota en portapapeles")
add("p05","N18",4.0,"Personal entrando y saliendo","Torniquetes de turno")
add("p05","D03-05",3.0,"Sistemas que debían mantenerse","Rejilla de ventilación")
add("p05","N19",5.5,"…seres que simplemente formaban parte del lugar","Gris tras cristal esmerilado")
# p06 family: FAMILIA → SECRETO → FAMILIA → DULCE → FAMILIA
add("p06","D08-06",5.0,"…cuando Thomas regresaba a casa","Camioneta llega a casa")
add("p06","D12-06",5.0,"…obligado a guardar silencio","Familia a la mesa, vista por la ventana")
add("p06","D12-01",6.0,"Imagina sentarte a cenar frente a tu esposa","Familia sentada, plano maestro")
add("p06","D01-01",1.2,"(flash) …pasar el día en un lugar","Flash: corredor de Dulce")
add("p06","D12-03",6.0,"…cambiaría todo lo que ella cree saber","Esposa sobre el hombro de Thomas")
add("p06","D11-06",4.0,"Mirarla hablar… De la familia. Del trabajo.","Esposa sonríe")
add("p06","D10-05",4.0,"Del día siguiente.","Hijo mira a su madre")
add("p06","N20",7.5,"…otra realidad que no puedes compartir","Thomas callado a la mesa, push-in")
add("p06","D04-02",1.2,"(flash) otra realidad","Flash: gris y reptiliano")
add("p06","D10-04",4.0,"No porque no quieras.","Esposa, primer plano")
add("p06","D09-04",5.0,"…consecuencias. Para tu trabajo. Para ti.","Thomas en la cocina, pensativo")
add("p06","D11-04",4.0,"…las personas que más quieres","Hijo habla")
add("p06","D11-03",4.0,"(sigue)","Esposa habla")
add("p06","D05-01",1.2,"(flash)","Flash: laboratorio con la silueta de Thomas")
add("p06","D12-04",5.0,"…y fingía que no sabía nada","Dibujo familiar y llaves")
add("p06","N21",5.0,"A la mañana siguiente volvía a Dulce","Camioneta sale al amanecer")
add("p06","N05",3.5,"Volvía a los controles.","(otro tramo) sala de control")
add("p06","D01-01",3.0,"A los corredores.","(otro tramo) corredor")
add("p06","D01-03",3.0,"A los seres…","(otro tramo) figuras")
add("p06","N22",5.1,"Y volvía a guardar silencio.","Thomas en corredor, push-in")
# p07
add("p07","N23",6.0,"Existían reglas. Conversaciones restringidas","Mampara: humanos a un lado, gris al otro")
add("p07","D06-05",2.0,"…no debía compartirse","Técnico tapa el portapapeles (0–2 s)")
add("p07","D07-02",3.0,"Preguntas que era mejor no hacer","Thomas con la radio (0–3 s)")
add("p07","N07",4.0,"…sin la autorización correspondiente","(otro tramo) LED rojo en puerta blindada")
add("p07","N05",5.0,"…mantener precisamente ese sistema","(otro tramo) Thomas vigila monitores")
add("p07","N24",4.0,"…durante algún tiempo, lo hizo","Monitores CCTV")
add("p07","N25",7.9,"Hasta que empezó a ver cosas…","Thomas ante ventana de observación")
# p08
add("p08","D01-04",5.0,"Los laboratorios…","(otro tramo) laboratorio de cámaras")
add("p08","N26",5.0,"…investigación biológica y médica","Sala médica clínica")
add("p08","N27",4.0,"Equipamiento que no comprendía","Recipientes y luces")
add("p08","D05-01",5.0,"Cámaras y áreas de observación","Thomas observa las cámaras")
add("p08","N28",5.0,"Personal humano cerca de entidades no humanas","Técnico al microscopio, gris al lado")
add("p08","D06-01",4.0,"…existían explicaciones","Técnico entra (0–4 s)")
add("p08","N26",3.0,"Medicina experimental.","(otro tramo) sala médica")
add("p08","N29",5.0,"…alguien arriba sabía","Galería de observación")
add("p08","N30",5.5,"…no había visto los niveles inferiores","Puerta de ascensor sin botón")
# p09
add("p09","N31",6.0,"…otros trabajadores. Comentarios. Rumores.","Sala de descanso")
add("p09","N32",4.0,"Advertencias.","Trabajador mira de reojo")
add("p09","N33",5.0,"…no formaban parte del personal","Hombre civil en sala de retención")
add("p09","N34",4.0,"…especialmente importante","Thomas mira por la ventanilla")
add("p09","N35",6.0,"…un hombre al que identificó como George","Retrato de George")
add("p09","N36",5.1,"…llevado allí. Contra su voluntad.","George primer plano")
# p10
add("p10","N37",6.0,"…podía justificar muchas cosas","Thomas camina pensativo")
add("p10","N09",3.0,"Secretos. Investigación. Tecnología.","(otro tramo) área técnica")
add("p10","D04-02",4.0,"…la presencia de seres…","(otro tramo) figuras en corredor")
add("p10","N35",5.0,"…una persona retenida contra su voluntad","(otro tramo) George")
add("p10","N38",6.0,"Era una cuestión moral.","Thomas en luz baja, push-in")
add("p10","D03-06",5.0,"…zonas a las que no tenía acceso","(otro tramo) puerta roja")
add("p10","N10",4.8,"(sigue)","(otro tramo) hueco hacia abajo")
# p11
add("p11","N39",5.0,"…empezaron a mostrarle información. Documentos.","Carpeta bajo la lámpara")
add("p11","N40",5.0,"Nombres. Personas desaparecidas.","Ficheros sin rostro, sin texto")
add("p11","D06-06",4.0,"Fragmentos de una historia…","Carpeta con foto (0–4 s)")
add("p11","N38",5.0,"…comenzó a sospechar","(otro tramo) Thomas en conflicto")
add("p11","N33",4.0,"…no estaban allí voluntariamente","(otro tramo) sala de retención")
add("p11","N41",10.6,"…apareció una palabra… NIGHTMARE HALL","Corredor rojo con niebla + rótulo G4")
# p12
add("p12","G1",5.0,"…niveles más restringidos","Corte transversal: se ilumina el nivel inferior")
add("p12","N25",4.0,"…todavía no comprendía","(otro tramo) Thomas ante el cristal")
add("p12","D05-02",1.3,"Personas.","Flash: pulso en el puente")
add("p12","N41",1.3,"Seres.","Flash: corredor rojo")
add("p12","D04-01",1.3,"Contención.","Flash: gris en el haz")
add("p12","N44",1.4,"Experimentación.","Flash: compuerta con niebla")
add("p12","N10",4.0,"…mucho más allá","(otro tramo) hueco")
add("p12","D03-03",5.0,"…tuvo que tomar una decisión","(otro tramo) Thomas en el ascensor")
add("p12","D12-06",5.0,"…regresar a casa cada noche","(otro tramo) familia por la ventana")
add("p12","N42",5.0,"O podía averiguar…","Botón del nivel más bajo se ilumina")
add("p12","D03-04",4.5,"…qué había realmente debajo","(otro tramo) puertas se abren")
# p13
add("p13","N43",6.0,"…eligió bajar","Thomas desciende, luz roja")
add("p13","N44",5.0,"…transformó completamente su historia","Compuerta entreabierta")
add("p13","D01-06",1.5,"Cámaras de contención.","Flash: cámaras (Parte II, solo insinuado)")
add("p13","N33",1.5,"Personas retenidas.","Flash: sala de retención")
add("p13","D01-05",1.5,"Experimentos.","Flash: cámaras en penumbra")
add("p13","N12",1.5,"Seres que no podía identificar.","Flash: reptiliano")
add("p13","N41",4.0,"…Nightmare Hall","(otro tramo) corredor rojo")
add("p13","N45",6.0,"…quién era realmente Thomas Edwin Castello","Archivador con carpetas vacías")
add("p13","D07-03",6.0,"¿podemos demostrar que este hombre existió?","Retrato de Thomas desaturado + G5")
add("p13","G7",2.1,"(pausa)","Negro breve")
# p14
add("p14","N41",5.0,"…entraremos en Nightmare Hall","(otro tramo) corredor, más profundo")
add("p14","D01-05",4.0,"…qué aseguró que había visto","(otro tramo) cámaras")
add("p14","N36",4.0,"…las personas retenidas","(otro tramo) George")
add("p14","N46",4.0,"…el conflicto dentro de Dulce","Luz de emergencia giratoria")
add("p14","N47",6.0,"…el origen real de la leyenda","Cielo nocturno sobre la mesa")
add("p14","N48",6.0,"…Paul Bennewitz","Equipo de radio + rótulo G6")
add("p14","N49",5.0,"…una posibilidad completamente diferente","Antenas contra el cielo")
add("p14","N50",7.5,"…sino con desinformación.","Máquina de escribir, documentos tachados")
add("end","G7",6.0,"CORTE A NEGRO","DULCE — PARTE II: NIGHTMARE HALL")

# ---- Derive actions, providers, risk, cost ----
IMG_EXP, IMG_MAX = 0.10, 0.30      # gpt-image-2 medium w/ refs: V1 ledger avg 0.096, reserve 0.30
RW = {"rw5": 0.25, "rw10": 0.50}   # Runway gen4_turbo USD 0.05/s
used_first = {}
for i, s in enumerate(S):
    src = s["src"]; first = src not in used_first; used_first.setdefault(src, i)
    if src in AUDIT:
        act = AUDIT[src][0]
        s.update(origin="V1", note=AUDIT[src][1])
        if act == "PART-II": act = "RECUT"; s["note"] = "Solo flash ≤1.5 s como avance; material reservado para Parte II. " + AUDIT[src][1]
        s["action"] = act
        s["provider"] = "Runway (reanimar still aprobado, solo cámara)" if act == "REANIMATE" else "Existente (FFmpeg: in/out, reencuadre)"
        s["risk"] = "bajo" if act in ("KEEP", "RECUT") else "medio"
        s["chars"] = ""
    else:
        kind, desc, chars, risk = NEW[src]
        s.update(origin="NEW", note=desc, chars=", ".join(chars), risk=risk)
        s["action"] = "NEW" if src.startswith("N") or src.startswith("G") else "NEW"
        if src == "N06": s["action"] = "REPLACE"
        s["provider"] = {"img+rw5": "gpt-image-2 + Runway 5 s", "img+rw10": "gpt-image-2 + Runway 10 s", "img+ff": "gpt-image-2 + FFmpeg (movimiento de cámara)", "gfx": "Motion graphics (FFmpeg/ASS, sin IA)"}[kind]
    s["reuse"] = not first
t = 0.0
for i, s in enumerate(S):
    s["id"] = f"P1-{i+1:03d}"; s["start"] = round(t, 1); t += s["sec"]
    s["from"] = S[i-1]["visual"] if i else "(abre el episodio)"
    s["to"] = S[i+1]["visual"] if i + 1 < len(S) else "(fin)"
total = t

# Unique generations and cost
gen = {}
for s in S:
    src = s["src"]
    if src in NEW and NEW[src][0] != "gfx": gen[src] = NEW[src][0]
    if src in RW4: gen[src] = "rw5"
images = [k for k, v in gen.items() if v.startswith("img")]
rw5 = [k for k, v in gen.items() if v.endswith("rw5")]
rw10 = [k for k, v in gen.items() if v.endswith("rw10")]
A = round(len(images) * IMG_EXP, 2); Amax = round(len(images) * IMG_MAX, 2)
B = round(len(rw5) * .25 + len(rw10) * .5, 2)
voice_chars = sum(len(b["narration"]) for b in script["beats"]) + len(script["endCard"])
C = round(voice_chars * 0.0003 * 1.25, 2)  # repo rate estimate + 25% retakes
D = round(len(images) * .5 * IMG_EXP + B * .35, 2)
E = round(A + B + C + D, 2)
F = round(Amax * 2 + B * 1.8 + C * 1.6, 2)
for s in S:
    k = s["src"]; v = gen.get(k)
    if s["reuse"] or not v: s["cost"] = 0.0
    else: s["cost"] = round((IMG_EXP if v.startswith("img") else 0) + (.25 if v.endswith("rw5") else .5 if v.endswith("rw10") else 0), 2)

from collections import Counter
v1_used = sorted({s["src"] for s in S if s["origin"] == "V1"})
v1_act = Counter(AUDIT[k][0] for k in v1_used)
summary = {
 "estimatedNarrationSeconds": round(sum(beat_secs.values()), 1), "timelineSeconds": round(total, 1),
 "slots": len(S), "uniqueV1Used": len(v1_used), "v1UsedByAction": dict(v1_act),
 "slotActions": dict(Counter(s["action"] for s in S)),
 "newGenerations": {"images": len(images), "runway5s": len(rw5), "runway10s": len(rw10), "ffmpegStillMoves": len([k for k,v in gen.items() if v=="img+ff"]), "graphics": len([k for k in NEW if NEW[k][0]=="gfx"])},
 "reanimate": sorted(RW4), "abandoned": sorted(k for k,(a,_) in AUDIT.items() if a=="ABANDON"),
 "partII": sorted(k for k,(a,_) in AUDIT.items() if a=="PART-II"),
 "unusedGood": sorted(k for k,(a,_) in AUDIT.items() if a in("KEEP","RECUT") and k not in v1_used),
 "budget": {"A_images": A, "A_images_worst": Amax, "B_animation": B, "C_voice": C, "voiceChars": voice_chars, "D_retries": D, "E_expected": E, "F_worstCase": F},
}
out = {"summary": summary, "beatSeconds": beat_secs, "audit": {k: {"verdict": a, "note": n} for k,(a,n) in AUDIT.items()},
       "newAssets": {k: {"kind": v[0], "description": v[1], "characters": v[2], "deformationRisk": v[3]} for k,v in NEW.items()}, "shots": S}
os.makedirs(f"{ROOT}/content/long-form/dulce-part1", exist_ok=True)
json.dump(out, open(f"{ROOT}/content/long-form/dulce-part1/storyboard.json", "w"), ensure_ascii=False, indent=2)
print(json.dumps(summary, ensure_ascii=False, indent=1))

# ---- Markdown export ----
def fm(x): return f"{int(x//60)}:{x%60:04.1f}"
L = [f"# DULCE — PARTE I (V2): storyboard y plan de producción", "",
     "Estado: **pendiente de aprobación. Sin llamadas de pago.** Generado por `scripts/lib/dulce-part1-plan.py` desde `content/long-form/dulce-part1/script-es.json`.", "",
     f"- Narración estimada: {summary['estimatedNarrationSeconds']/60:.1f} min ({WPS} palabras/s + pausas); timeline {summary['timelineSeconds']/60:.1f} min. Se recalcula con el audio medido.",
     f"- Planos en el montaje: {summary['slots']} (media {summary['timelineSeconds']/summary['slots']:.1f} s).", "",
     "## Storyboard", "", "| ID | Inicio | s | Bloque | Narración (intención) | Imagen (intención) | Fuente | Acción | Personajes | Proveedor | Riesgo | USD | Nota |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
for s in S:
    L.append(f"| {s['id']} | {fm(s['start'])} | {s['sec']} | {s['beat']} | {s['cue']} | {s['visual']} | {s['src']}{' (reuso)' if s['reuse'] else ''} | {s['action']} | {s['chars']} | {s['provider']} | {s['risk']} | {s['cost']:.2f} | {s['note']} |")
L += ["", "## Auditoría V1 (73 planos)", "", "| Plano | Veredicto | Nota |", "|---|---|---|"]
L += [f"| {k} | {a} | {n} |" for k,(a,n) in AUDIT.items()]
L += ["", "## Assets nuevos", "", "| ID | Tipo | Descripción | Personajes | Riesgo |", "|---|---|---|---|---|"]
L += [f"| {k} | {v[0]} | {v[1]} | {', '.join(v[2])} | {v[3]} |" for k,v in NEW.items()]
L += ["", "## Resumen", "", "```json", json.dumps(summary, ensure_ascii=False, indent=1), "```"]
os.makedirs(f"{ROOT}/docs/quality/dulce-part1", exist_ok=True)
open(f"{ROOT}/docs/quality/dulce-part1/STORYBOARD.md", "w").write("\n".join(L) + "\n")
