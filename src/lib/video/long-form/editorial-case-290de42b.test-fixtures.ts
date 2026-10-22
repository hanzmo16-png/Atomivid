/** Real production case (job 290de42b, codes 839857e1 → 65f25654): the final unapproved draft of «Marco aurelio y los
 * secretos del estoicismo», copied verbatim from the read-only diagnosis (scripts/diag/editorial-case.ts). Both later
 * reviews had no blocking finding; only the creative-direction passage check stopped it. */
export const CASE_290DE42B_NARRATIONS = [
  "En un campamento militar junto al río Danubio, en algún momento durante esas campañas, un hombre escribe de noche, a solas. Afuera hay guerra contra las tribus germánicas y una plaga que ya ha cruzado media Europa occidental. Ese hombre es el emperador de Roma. Y lo que escribe en ese cuaderno no tiene título, no está dirigido a nadie, no fue pensado para publicarse. Siglos después, lo conocemos como 'Meditaciones' — pero ese nombre se lo pusimos nosotros, no él. Lo que sí sabemos, porque ha quedado documentado, es que esas páginas se escribieron precisamente en esos campamentos militares, entre batallas. Así que la primera pregunta que vale la pena hacerse no es qué dice ese libro, sino por qué un emperador en medio de una guerra interminable sentía la necesidad de escribirse notas a sí mismo cada noche. Esa pregunta es la que vamos a seguir.",
  "Para entender esa necesidad hay que retroceder un poco. Como heredero del trono, Marco Aurelio estudió griego y latín con tutores de prestigio, entre ellos Herodes Ático y Marco Cornelio Frontón, pensados para formar a un orador, no a un filósofo. Pero entre esos maestros aparece otro nombre menos conocido: Quinto Junio Rústico, quien le presentó los escritos del estoico Epicteto. Marco Aurelio se lo agradecería años después, en sus propias páginas. No podemos fechar con precisión el momento exacto en que esa lectura se volvió central en su vida. Lo que sí queda documentado es el hilo: de ahí en adelante, la filosofía que había sido materia de estudio empezaría, con el tiempo, a convertirse en algo que usaría para sobrevivir noche tras noche.",
  "Marco Aurelio gobernó Roma entre el año 161 y el 180 después de Cristo. Y el retrato que solemos imaginar —el filósofo sereno sobre el trono— no coincide con los años reales de su reinado. Desde el 166 hasta su muerte, las guerras fueron prácticamente continuas, interrumpidas apenas por una tregua de tres años entre el 175 y el 178. Durante los últimos quince años de su gobierno, pasó más tiempo en las fronteras germánicas, junto al Danubio, que en Roma. A eso se sumó una plaga que devastó buena parte de Europa occidental mientras él libraba esa guerra. Ni siquiera su vida personal quedó al margen: entre el 170 y el 175, su esposa Faustina lo acompañó en esas mismas campañas. El emperador filósofo, entonces, no escribió sobre la calma desde la calma. La escribió desde el frente.",
  "Y aquí está el matiz que cambia cómo hay que leer el texto: ese cuaderno no se escribió como una teoría preparada de antemano, sino en medio del caos que describe. Eso convierte el estoicismo de Marco Aurelio en algo distinto de un sistema abstracto para admirar a distancia: era una herramienta en uso. Una de las fuentes consultadas llega a calificar su reinado como el comienzo de una crisis más amplia del imperio — pero ese fragmento aparece incompleto, así que no podemos confirmar si esa lectura es compartida entre historiadores o minoritaria. Lo que sí es verificable es más simple, y quizás más revelador: la filosofía no lo salvó de la guerra ni de la plaga. Solo le dio una forma de atravesarlas sin perderse.",
  "Eso es, en el fondo, lo que responde a la pregunta inicial. Marco Aurelio no escribía para enseñar serenidad a nadie; escribía para practicarla él mismo, en privado, sin público ni pulido literario, lo que ayuda a explicar por qué el texto suena más a nota urgente que a discurso filosófico. El 'secreto' del estoicismo que practicó no es una fórmula de felicidad que podamos copiar íntegra: esa es nuestra lectura, no un hecho que las fuentes documenten directamente. Lo que sí queda documentado es un hombre gobernando un imperio en guerra que, cada noche, se sentaba a escribirse a sí mismo para seguir funcionando al día siguiente. Si tuvieras que escribirte una nota a ti mismo esta noche, en medio de tu propia versión de guerra o plaga, ¿qué tan distinta sonaría de las suyas? Si quieres seguir abriendo cuadernos históricos como este, hay más para explorar.",
];

export const CASE_290DE42B_DIRECTION = {
  angles: [
    { hook: "Un emperador escribe a solas en medio de la guerra un cuaderno que nunca pensó publicar.", device: "in_medias_res", premise: "Abrir en el campamento del Danubio mientras escribe de noche, sin saber que será leído dos mil años después.", genericRisk: "Puede sonar a cualquier biografía de 'detrás del mito' si no se ancla en el detalle documental concreto." },
    { hook: "La imagen serena del emperador filósofo no coincide con los años reales de su reinado.", device: "contradiction", premise: "Explotar la paradoja central: el filósofo de la calma gobernó quince años de guerra casi ininterrumpida.", genericRisk: "Quedarse en frase motivacional vacía si no se sostiene con fechas y hechos verificables." },
    { hook: "Un maestro del que casi nadie habla cambió el rumbo filosófico de un futuro emperador.", device: "character_case", premise: "Seguir el hilo de Quinto Junio Rústico, el maestro casi anónimo que le presentó a Epicteto.", genericRisk: "Convertirse en una lista de tutores sin tensión narrativa real." },
    { hook: "Algunos historiadores sitúan aquí el comienzo de la crisis del imperio romano.", device: "thesis", premise: "Plantear como tesis histórica que su reinado marcó el inicio de una crisis más amplia del imperio.", genericRisk: "Sonar a clase de historia institucional sin gancho emocional para el espectador casual." },
    { hook: "El estoicismo que circula en redes sociales no se parece al que escribió este hombre.", device: "myth_evidence", premise: "Contrastar el estoicismo de autoayuda moderno con lo que realmente practicaba Marco Aurelio en el frente.", genericRisk: "Tema ya muy trillado en internet; riesgo alto de sonar repetitivo y poco original." },
    { hook: "Una línea de tiempo exacta entre el trono, la guerra y el cuaderno.", device: "timeline", premise: "Reconstruir año a año su reinado, de 161 a 180, cruzado con la escritura del libro.", genericRisk: "Dispositivo ya usado recientemente en esta cuenta (Luna, Salamis); sensación de fórmula repetida." },
    { hook: "Qué pasaría si estas páginas nunca hubieran sobrevivido al tiempo.", device: "counterfactual", premise: "Plantear el experimento mental de qué habría pasado si el cuaderno se hubiera perdido o destruido.", genericRisk: "Especulación sin anclaje factual claro, puede sentirse gratuito." },
  ],
  audience: "Oyentes de documentales de historia y filosofía práctica en YouTube, interesados en figuras como Marco Aurelio pero cansados del estoicismo convertido en frases de autoayuda genéricas.",
  weakness: "Todo el research pack proviene de fuentes secundarias de divulgación general (blogs y portales), no de ediciones académicas o filológicas de Meditaciones; además, el fragmento clave sobre la 'crisis' del reinado aparece cortado en la fuente, por lo que no se puede confirmar si esa calificación es una posición consensuada o minoritaria entre historiadores.",
  cloneTest: { substitutedTopic: "Nelson Mandela y las cartas que escribió en prisión", whyThisStoryBreaks: "El detalle que sostiene esta historia —que el texto más citado sobre calma estoica se escribió literalmente en campamentos militares activos, durante una guerra de quince años y una plaga simultánea, documentado por varias fuentes— es específico de Marco Aurelio. Con Mandela cambiaría el escenario, la filosofía de fondo y la pregunta central sobre si la escritura precede o surge dentro de la crisis; no es un simple cambio de nombre, cambia la causalidad completa del guion." },
  finalists: [0, 1, 4],
  closingCta: { quote: "Si quieres seguir abriendo cuadernos históricos como este, hay más para explorar.", beatIndex: 4 },
  chosenAngle: 1,
  finalFeeling: "Respeto sobrio: no admiración heroica, sino la sensación de haber visto a un hombre concreto sosteniéndose noche tras noche.",
  commentMoment: { quote: "Si tuvieras que escribirte una nota a ti mismo esta noche, en medio de tu propia versión de guerra o plaga, ¿qué tan distinta sonaría de las suyas?", beatIndex: 4 },
  protectInEdit: [
    { quote: "Lo que escribe en ese cuaderno no tiene título, no está dirigido a nadie, no fue pensado para publicarse.", beatIndex: 0 },
    { quote: "ese fragmento aparece incompleto, así que no podemos confirmar si esa lectura es compartida entre historiadores o minoritaria.", beatIndex: 3 },
    { quote: "esa es nuestra lectura, no un hecho que las fuentes documenten directamente.", beatIndex: 4 },
  ],
  shareableLine: { quote: "La filosofía no lo salvó de la guerra ni de la plaga. Solo le dio una forma de atravesarlas sin perderse.", beatIndex: 3 },
  avoidedPatterns: [
    "Abrir siempre con un hallazgo espectacular tipo crimen o conspiración, como en los guiones de Gucci y Bigfoot.",
    "Usar una línea de tiempo cronológica pura como único motor narrativo, como en los guiones de la Luna y Salamis.",
    "Cerrar con una pregunta puramente especulativa sin entregar una respuesta sostenida por evidencia, como en el cierre de Bigfoot y Salamis.",
  ],
  selectionReason: "La contradicción entre la imagen pública del 'emperador filósofo sereno' y los años reales de guerra, plaga y pérdida es la que mejor entrega información nueva en cada bloque, se sostiene con los datos concretos del research pack y evita tanto el cliché de autoayuda como la repetición de dispositivos usados en videos recientes de la cuenta.",
  signatureDetail: { quote: "Siglos después, lo conocemos como 'Meditaciones' — pero ese nombre se lo pusimos nosotros, no él.", beatIndex: 0 },
  emotionalPromise: "La sensación de haber entendido algo real detrás de un meme filosófico: que ese libro famoso no nació de la calma, sino de la supervivencia.",
  beliefToChallenge: "La idea de que Marco Aurelio escribió un manual de serenidad desde la paz y la distancia del poder.",
  evidenceThatWouldHelp: "Acceso a ediciones críticas de Meditaciones con aparato filológico sobre dónde y cuándo se escribió cada libro, y a historiografía especializada sobre la llamada crisis del siglo III para verificar si encuadrar el reinado de Marco Aurelio como su inicio es una posición consensuada o minoritaria entre historiadores.",
};
/** Pass-0/1 drafts carried this protectInEdit[2]: a genuine paraphrase that is NOT in their narration (relaxed match false). */
export const CASE_290DE42B_PARAPHRASE = "Ese cuaderno no se escribió antes de la crisis, como una teoría preparada para enfrentarla. Se escribió durante ella.";
/** The account had five previous scripts; their openings differ from this one (only the count matters to these checks). */
export const CASE_290DE42B_HISTORY = Array.from({ length: 5 }, (_, i) => ({ topic: `Guion previo ${i + 1}`, opening: `Apertura distinta ${i + 1}`, ending: "Cierre", structure: [] }));

/** The rest of the same real draft (title, hook, story plan, claims) and its research sources, verbatim from the diagnosis. */
export const CASE_290DE42B_SOURCES = [
  { id: "web-1", title: "Emperador Marco Aurelio: biografía, los estoicos, Meditaciones", kind: "secondary" as const },
  { id: "web-2", title: "Marco Aurelio, el emperador filósofo: las reglas que guiaron su poder y su serenidad", kind: "secondary" as const },
  { id: "web-3", title: "Marco Aurelio y sus «Meditaciones»: todas las claves del estoicismo", kind: "secondary" as const },
  { id: "web-4", title: "Marco Aurelio: el filósofo emperador estoico - Red Historia", kind: "secondary" as const },
  { id: "web-5", title: "Marco Aurelio Meditaciones BIBLIOTECA DIGITAL MINERD DOMINICANA LEE", kind: "secondary" as const },
  { id: "web-6", title: "Meditaciones de Marco Aurelio: Reflexiones sobre el Estoicismo y el Imperio - Studocu", kind: "secondary" as const },
];
const c = (id: string, text: string, support: "sourced" | "inference" | "unverified", sourceIds: string[]) => ({ id, text, support, sourceIds });
export const CASE_290DE42B_BEATS = [
  { type: "hook", purpose: "Abrir con una acción concreta y entregar el primer dato útil antes de los 150 palabras: el cuaderno no tenía título ni intención de publicarse.", claims: [
    c("claim-1", "Meditaciones fue escrita durante las campañas militares de Marco Aurelio en campamentos junto al Danubio.", "sourced", ["web-4"]),
    c("claim-2", "El texto no tiene un título propio de Marco Aurelio; el nombre 'Meditaciones' es una denominación posterior y común, no original.", "sourced", ["web-1"]),
    c("claim-3", "Durante este período hubo una gran plaga que afectó a Europa occidental mientras Marco Aurelio hacía campaña contra las tribus germánicas.", "sourced", ["web-2"])] },
  { type: "setup", purpose: "Retroceder brevemente a la formación de Marco Aurelio y establecer el origen documentado de su giro hacia el estoicismo, conectando rápido con la pregunta de supervivencia.", claims: [
    c("claim-1", "Marco Aurelio estudió griego y latín, y entre sus tutores estuvieron Herodes Ático y Marco Cornelio Frontón.", "sourced", ["web-1"]),
    c("claim-2", "Su maestro Quinto Junio Rústico le presentó la obra del estoico Epicteto, algo que Marco Aurelio agradece en Meditaciones.", "sourced", ["web-2"]),
    c("claim-3", "No es posible fechar con precisión el momento exacto en que el estoicismo se volvió central en su vida.", "inference", ["web-2"])] },
  { type: "escalation", purpose: "Mostrar la realidad material de su reinado para construir la contradicción central: guerra casi continua, no gobierno sereno.", claims: [
    c("claim-1", "Marco Aurelio reinó entre el año 161 y el 180 d.C.", "sourced", ["web-3", "web-4"]),
    c("claim-2", "Las guerras fueron prácticamente continuas desde el 166 hasta su muerte en el 180, con una tregua de tres años entre el 175 y el 178.", "sourced", ["web-6"]),
    c("claim-3", "Durante los últimos quince años de su reinado pasó más tiempo en las fronteras germánicas que en Roma.", "sourced", ["web-4"]),
    c("claim-4", "Entre el 170 y el 175, Faustina acompañó a Marco Aurelio en sus campañas.", "sourced", ["web-1"])] },
  { type: "insight", purpose: "Reencuadrar el estoicismo de Marco Aurelio como práctica en tiempo real, no teoría previa, condensando la idea sin repetir la afirmación factual del bloque anterior, y marcando honestamente el límite de la evidencia sobre la 'crisis' del reinado.", claims: [
    c("claim-1", "Meditaciones se escribió durante las campañas militares de Marco Aurelio, no antes de ellas.", "sourced", ["web-4"]),
    c("claim-2", "Una fuente consultada califica el gobierno de Marco Aurelio como el comienzo de una crisis más amplia para el imperio, en un fragmento que aparece incompleto.", "sourced", ["web-6"]),
    c("claim-3", "No es posible determinar, a partir de las fuentes consultadas, si esa calificación de 'crisis' es una posición consensuada o minoritaria entre historiadores.", "unverified", [])] },
  { type: "payoff", purpose: "Resolver la pregunta central antes del CTA, explicando por qué el carácter íntimo del texto es su verdadero valor, marcando explícitamente la interpretación como tal, e incluir una invitación a comentar y un CTA breve.", claims: [
    c("claim-1", "El carácter íntimo y sin pulir del texto, escrito en privado y sin intención de publicación, ayuda a explicar su resonancia posterior.", "inference", ["web-1", "web-4"]),
    c("claim-2", "La idea de que el estoicismo de Marco Aurelio no es una 'fórmula' extraíble de felicidad es una interpretación propia, no un hecho documentado en las fuentes.", "inference", [])] },
].map((b, i) => ({ ...b, narration: CASE_290DE42B_NARRATIONS[i] }));
export const CASE_290DE42B_DRAFT = {
  creativeDirection: CASE_290DE42B_DIRECTION,
  title: "El cuaderno secreto que Marco Aurelio escribió en medio de la guerra",
  workingTitleOptions: ["El cuaderno secreto que Marco Aurelio escribió en medio de la guerra"],
  hook: "En un campamento militar junto al río Danubio, en algún momento durante esas campañas, un hombre escribe de noche, a solas. Afuera hay guerra contra las tribus germánicas y una plaga que ya ha cruzado media Europa occidental. Ese hombre es el emperador de Roma. Y lo que escribe en ese cuaderno no tiene título, no está dirigido a nadie, no fue pensado para publicarse.",
  storyPlan: {
    sections: [
      { tension: "rise" as const, beatIndex: 0, consequence: "Obliga a preguntarse por qué un emperador necesitaba escribirse notas a sí mismo en medio de una guerra.", newInformation: "El cuaderno conocido como Meditaciones fue escrito en campamentos militares del Danubio, sin título y sin intención de publicación." },
      { tension: "reflection" as const, beatIndex: 1, consequence: "Establece que el giro hacia el estoicismo tiene un origen documentado, aunque no fechable con precisión, y conecta rápido con la idea de supervivencia.", newInformation: "Su formación retórica se vio desviada por Quinto Junio Rústico, quien le presentó a Epicteto." },
      { tension: "rise" as const, beatIndex: 2, consequence: "Derriba la imagen de un gobierno sereno y plantea el contraste central del video.", newInformation: "Su reinado real (161-180) estuvo marcado por guerra casi continua desde 166, quince años en la frontera germánica y una plaga simultánea." },
      { tension: "release" as const, beatIndex: 3, consequence: "Reencuadra el estoicismo como práctica en tiempo real, no teoría previa, y marca honestamente el límite de la evidencia disponible, sin repetir la idea factual del bloque anterior.", newInformation: "El cuaderno se escribió durante esas campañas, no antes; una fuente lo vincula al inicio de una crisis más amplia del imperio, pero ese fragmento está incompleto." },
      { tension: "reflection" as const, beatIndex: 4, consequence: "Cierra la pregunta central con una conclusión sostenida por los hechos narrados y deja una invitación concreta a seguir explorando.", newInformation: "La resonancia del texto viene de su carácter íntimo y sin pulir; la idea de una 'fórmula' extraíble se marca explícitamente como lectura propia, no como hecho documentado." },
    ],
    firstAnswer: "El libro que llamamos Meditaciones no tiene título propio ni fue escrito para publicarse: es un cuaderno personal, y ese nombre se lo pusimos después.",
    endingAnswer: "El estoicismo de Marco Aurelio no fue una filosofía de retiro contemplativo, sino una herramienta usada noche tras noche dentro del caos real de la guerra, la plaga y la pérdida; por eso el texto suena a nota urgente y no a discurso, y por eso sigue resonando.",
    openingPromise: "Vamos a entrar al cuaderno privado de un emperador en guerra para entender qué era realmente el estoicismo que practicaba, más allá de la imagen serena que heredamos de él.",
    centralQuestion: "¿Por qué el texto más citado sobre serenidad estoica fue escrito por un hombre en medio de guerra constante y plaga, sin intención de que nadie más lo leyera?",
  },
  beats: CASE_290DE42B_BEATS,
};
