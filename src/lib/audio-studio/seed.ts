import type { MusicConfig } from "./model";

/**
 * Primer episodio de Audio Podcast Studio: guion original de Atomivid sobre estoicismo y desarrollo personal.
 * Se carga como proyecto editable; no se sintetiza hasta que exista una autorización de gasto posterior.
 * Las ideas de Epicteto, Séneca y Marco Aurelio se presentan con palabras propias (no son citas textuales).
 */
export const SEED_EPISODE: {
  title: string; voice: string; targetMinutes: number; budgetUsd: number; music: MusicConfig; notes: string; script: string;
} = {
  title: "El día que entiendes que no puedes controlarlo todo",
  voice: "es-latam-m-profesional",
  targetMinutes: 18,
  budgetUsd: 6,
  music: { mode: "inteligente", mood: "reflexiva", volume: 16, ducking: true, intro: true, outro: true },
  notes: "Voz masculina profesional, español latinoamericano. Ritmo pausado, silencios breves entre secciones. Música de fondo inteligente: entra bajo la voz y sube solo en las transiciones.",
  script: `## Apertura

Hay un momento en la vida que casi nadie elige, pero que a casi todos nos llega. Puede llegar en un hospital, en una oficina, en la mitad de una discusión o en la cocina de tu casa a las tres de la mañana. Es el momento en que entiendes, de golpe, que no puedes controlarlo todo.

Al principio se siente como una derrota. Como si alguien te quitara el volante en plena carretera. Pasaste años creyendo que, si te esforzabas lo suficiente, si planificabas cada detalle, si te preocupabas lo bastante, podrías evitar que las cosas salieran mal. Y un día descubres que no. Que la persona que amas toma sus propias decisiones. Que tu cuerpo tiene sus propios tiempos. Que la economía, el clima, la opinión de los demás y el pasado no te piden permiso.

Bienvenido a este episodio. Hoy vamos a hablar de ese día. Del día en que dejas de pelear contra lo que no depende de ti y empiezas, por fin, a ocuparte de lo que sí. Vamos a hacerlo de la mano de una escuela de pensamiento que tiene más de dos mil años y que sigue sorprendentemente viva: el estoicismo.

No vas a necesitar saber nada de filosofía. Solo te voy a pedir una cosa: que mientras escuchas, pienses en una situación concreta de tu vida que hoy te quita el sueño. Tenla presente. Vamos a volver a ella al final.

## Una escuela nacida en un pórtico

El estoicismo nació en Atenas, alrededor del año trescientos antes de nuestra era. Su fundador, Zenón de Citio, era un comerciante que, según la tradición, perdió todo su cargamento en un naufragio. Llegó a la ciudad sin nada, entró a una librería, empezó a leer sobre Sócrates y cambió el rumbo de su vida. Años después enseñaba en un pórtico pintado, una columnata pública llamada Stoa. De ahí viene la palabra estoico.

Fíjate en el detalle: la escuela que nos enseña a convivir con lo que no controlamos empezó con un hombre que lo perdió todo en el mar. No es una filosofía de escritorio. Es una filosofía de náufragos.

Siglos más tarde, tres personas muy distintas le dieron su forma más conocida. Epicteto, que nació esclavo y llegó a ser maestro. Séneca, que fue consejero de un emperador y uno de los hombres más ricos de Roma. Y Marco Aurelio, que fue emperador él mismo y escribía de noche, en medio de guerras y epidemias, notas privadas para recordarse cómo vivir.

Un esclavo, un millonario y un emperador. Tres vidas que no podrían ser más diferentes, y sin embargo los tres llegaron a la misma conclusión: la paz no depende de lo que te pasa, sino de cómo respondes a lo que te pasa.

## La dicotomía del control

Epicteto empezaba sus lecciones con una idea tan sencilla que parece obvia, y tan profunda que podemos pasar la vida entera aprendiéndola. Decía, más o menos, así: hay cosas que dependen de nosotros y cosas que no dependen de nosotros.

Dependen de nosotros nuestros juicios, nuestras intenciones, nuestros deseos, nuestras acciones. Lo que decidimos pensar sobre lo que ocurre. Lo que elegimos hacer a continuación. No dependen de nosotros el cuerpo, la reputación, el dinero, los cargos, lo que hacen y piensan los demás, y en general todo lo que no es obra nuestra.

Escúchalo otra vez, despacio. Tu reputación no depende de ti. Lo que la gente piensa de ti está en la cabeza de la gente. Tú puedes actuar con honestidad, puedes trabajar bien, puedes ser amable. Eso sí te pertenece. Pero la conclusión que saque otra persona no está en tus manos.

Cuando lo entiendes, algo se afloja en el pecho. Porque te das cuenta de cuánta energía has gastado intentando gobernar un territorio que nunca fue tuyo.

Ahora bien, hay que tener cuidado con esta idea, porque se malinterpreta con facilidad. La dicotomía del control no te dice que no te importe nada. No te dice que te quedes quieto. Te dice dónde poner el esfuerzo. Es una brújula, no una excusa.

## El arquero

Los estoicos tenían una imagen preciosa para explicar esto. La imagen del arquero.

Un arquero puede elegir su arco. Puede entrenar durante años. Puede estudiar el viento, cuidar su postura, respirar antes de soltar la cuerda. Todo eso depende de él. Pero una vez que la flecha sale, ya no le pertenece. Una ráfaga de viento puede desviarla. El blanco puede moverse. Alguien puede cruzarse.

Entonces, ¿cuál es el verdadero objetivo del arquero? Los estoicos respondían algo que suena extraño la primera vez: el objetivo no es dar en el blanco. El objetivo es disparar bien. Dar en el blanco es algo que uno desea, que uno prefiere, pero que no controla del todo.

Piensa en lo que esto cambia. Si tu felicidad depende de dar en el blanco, vivirás ansioso, porque siempre habrá viento. Si tu satisfacción depende de haber disparado bien, de haber hecho tu parte con todo lo que tenías, entonces puedes dormir tranquilo incluso en los días en que la flecha no llega.

Esto se aplica a una entrevista de trabajo, a una conversación difícil, a un negocio, a la crianza de un hijo. Prepárate. Haz tu mejor esfuerzo. Y luego suelta la flecha.

## Por qué nos aferramos

Si la idea es tan clara, ¿por qué nos cuesta tanto vivirla? ¿Por qué seguimos intentando controlarlo todo?

Una razón es el miedo. Controlar nos da la ilusión de seguridad. Si reviso el teléfono de mi pareja, si repaso mil veces el correo antes de enviarlo, si imagino todos los escenarios posibles, siento que estoy evitando el dolor. En realidad, casi siempre lo estoy adelantando. Sufro hoy por algo que tal vez nunca ocurra.

Séneca lo dijo de una forma que sigue siendo exacta: sufrimos más en la imaginación que en la realidad. Muchas de nuestras angustias son ensayos de desgracias que no llegan.

Otra razón es el orgullo. Nos cuesta aceptar que somos pequeños frente a la vida. Preferimos culparnos de todo antes que admitir que muchas cosas simplemente nos superan. Hay una forma de soberbia escondida en la frase: si hubiera hecho las cosas mejor, esto no habría pasado. A veces es verdad. Pero muchas otras veces no. A veces hiciste todo bien y aun así perdiste.

Y la tercera razón es la costumbre. Vivimos en una cultura que nos promete que todo se puede optimizar, medir, corregir. Que con la aplicación correcta, el hábito correcto y la rutina correcta, la vida debería obedecer. Y cuando no obedece, creemos que fallamos nosotros.

## La práctica de la mañana

Marco Aurelio tenía una costumbre que hoy podríamos llamar un ensayo mental. Cada mañana se recordaba que durante el día iba a encontrarse con personas impacientes, desagradecidas, arrogantes o injustas. No lo hacía para amargarse. Lo hacía para no ser tomado por sorpresa.

Si sabes que el tráfico existe, el tráfico no te arruina el día. Si sabes que alguien en la reunión va a interrumpirte, puedes decidir de antemano cómo vas a responder. Ese pequeño ejercicio convierte una reacción automática en una elección consciente.

Te propongo probarlo mañana. Antes de mirar el teléfono, tómate un minuto. Pregúntate: ¿qué cosas de hoy no dependen de mí? Nómbralas. El clima, el humor de mi jefe, la respuesta que estoy esperando. Y luego pregúntate: ¿qué sí depende de mí? Mi tono de voz. Mi puntualidad. La calidad de mi trabajo. La forma en que voy a tratar a la primera persona que me encuentre.

Un minuto. Nada más. Pero ese minuto cambia el lugar desde el que empiezas el día.

## Aceptar no es rendirse

Llegamos a la parte más delicada. Cuando hablamos de aceptar lo que no controlamos, mucha gente escucha resignación. Escucha: aguántate, no protestes, no cambies nada. Y eso no es estoicismo.

Los estoicos fueron personas profundamente activas. Séneca escribió, gobernó y aconsejó. Marco Aurelio dirigió un imperio en tiempos durísimos. Epicteto enseñó a cientos de alumnos. Ninguno de ellos se quedó sentado esperando.

La aceptación estoica funciona en dos tiempos. Primero aceptas la realidad tal como es en este momento, sin pelearte con ella. Lo que pasó, pasó. El diagnóstico es el que es. La decisión del otro ya está tomada. Discutir con el presente es como discutir con la lluvia: te mojas igual, pero además te cansas.

Y luego, desde esa aceptación, actúas. Con la cabeza fría. Con la energía que ya no gastas en negar lo evidente. Aceptar es el punto de partida, no el punto final.

Imagina a dos personas que reciben la misma mala noticia. La primera pasa semanas repitiendo que no es justo, que no debería haber pasado, que no puede ser. La segunda también siente el golpe, también llora, pero en algún momento se dice: esto es lo que hay; ahora, ¿qué hago con esto? Las dos sienten dolor. Solo una de ellas está en condiciones de construir algo.

## Las emociones no son el enemigo

Otro malentendido frecuente es pensar que ser estoico significa no sentir. Que el ideal es una persona fría, que no se inmuta, que no llora. Tampoco es así.

Los estoicos distinguían entre la primera reacción y el juicio que viene después. La primera reacción es casi automática: el salto del corazón ante una mala noticia, el calor en la cara ante un insulto, el nudo en la garganta ante una pérdida. Eso no lo elegimos y no hay nada de qué avergonzarse.

Lo que sí podemos trabajar es lo que viene un instante después. El relato que nos contamos. Si alguien me ignora en una reunión, la primera punzada es inevitable. Pero luego puedo decirme: me desprecia, siempre me pasa lo mismo, nadie me valora. O puedo decirme: no sé qué le pasa hoy, voy a buscar el momento de hablarlo. La emoción inicial fue la misma. El sufrimiento posterior, completamente distinto.

Epicteto lo resumía en una idea que podríamos parafrasear así: no nos perturban las cosas, sino las opiniones que tenemos sobre las cosas. Entre lo que ocurre y lo que sentimos hay un espacio pequeño. En ese espacio vive nuestra libertad.

## El ejercicio de la perspectiva

Hay un ejercicio que Marco Aurelio practicaba y que hoy los psicólogos han vuelto a descubrir. Consiste en mirar tu problema desde lejos. Muy lejos.

Imagina que te elevas por encima de tu casa. Ves el techo, la calle, el barrio. Sigues subiendo y ves tu ciudad entera, con millones de personas que en este momento también tienen preocupaciones, amores, miedos y planes. Subes más y ves el país, el continente, el planeta girando lentamente en la oscuridad. Ahora vuelve a mirar tu problema desde ahí arriba.

No se trata de decirte que tu problema no importa. Importa. Pero cuando lo ves en su verdadero tamaño, deja de ocupar todo el cielo. Recuperas proporción. Y con proporción, se piensa mejor.

Este ejercicio también sirve con el tiempo. Pregúntate: ¿esto que hoy me angustia, me importará dentro de cinco años? ¿Dentro de diez? Algunas cosas sí. La mayoría, no. Y saberlo te permite elegir en qué batallas gastar tu energía.

## Lo que nunca te pueden quitar

Volvamos a Epicteto, porque su historia personal le da peso a todo lo que decía. Fue esclavo durante buena parte de su juventud. Según una tradición antigua, quedó cojo por el maltrato de su amo. No eligió su origen, ni su cuerpo, ni su condición.

Y sin embargo, este hombre que no era dueño ni de sus propias piernas enseñó que había algo que nadie podía arrebatarle: su capacidad de decidir cómo responder. Podían encadenar su cuerpo, decía, pero no su voluntad.

Piensa en lo que significa que esa idea venga de alguien así. No es un consejo motivacional dicho desde la comodidad. Es la conclusión de alguien que vivió la falta de control en su forma más extrema y encontró, aun ahí, un territorio propio.

Tú también tienes ese territorio. Puede que hoy no controles tu salud, ni tu trabajo, ni la decisión de alguien que quieres. Pero sigues decidiendo cómo vas a tratarte esta noche. Si vas a pedir ayuda. Si vas a dar el siguiente paso, aunque sea pequeño. Ese territorio es tuyo, y es más grande de lo que parece.

## Una historia cotidiana

Déjame contarte una escena que quizá te resulte familiar. Una mujer, a la que vamos a llamar Clara, espera desde hace días la respuesta de una empresa donde hizo la mejor entrevista de su vida. Revisa el correo cada diez minutos. Repasa mentalmente cada frase que dijo. Se pregunta si sonrió demasiado o demasiado poco. Duerme mal. Discute con su hermano por una tontería. Su semana entera gira alrededor de una decisión que ya no está en sus manos.

Un domingo por la tarde, cansada, se sienta y hace el ejercicio de las dos columnas. En la primera escribe: la decisión de la empresa, el número de candidatos, el presupuesto que tengan, el humor de quien revise los currículos. En la segunda escribe: seguir enviando solicitudes, preparar mejor la próxima entrevista, llamar a su hermano para pedirle perdón, salir a caminar.

La respuesta de la empresa tardó otra semana en llegar. Pero Clara ya no la esperó de la misma manera. Hizo lo que estaba en la segunda columna. Y, pasara lo que pasara con ese puesto, recuperó algo que había perdido sin darse cuenta: su propia semana.

## Tres preguntas para cuando todo se desborda

Quiero dejarte algo práctico. Tres preguntas que puedes hacerte cuando sientas que la vida se te escapa de las manos.

La primera: ¿qué parte de esto depende de mí? No todo. Solo una parte. Encuéntrala. A veces es enorme, a veces es diminuta, como decidir respirar hondo antes de contestar un mensaje. Pero siempre hay una parte.

La segunda: ¿qué haría aquí una persona sabia, serena y justa? No tienes que ser esa persona. Solo imaginarla. Es sorprendente cuántas veces sabemos exactamente qué haría alguien sereno, aunque nosotros estemos lejos de sentirnos así.

La tercera: ¿qué puedo soltar hoy? Una expectativa, una discusión que ya no tiene sentido, una preocupación que llevo semanas cargando sin poder hacer nada con ella. Soltar no es olvidar. Es dejar de cargar con las manos lo que solo puedes sostener con el corazón.

Escríbelas en un papel, en la pantalla de tu teléfono, en la puerta del refrigerador. No hace falta memorizarlas. Solo tenerlas cerca para el día en que las necesites.

## La libertad del otro lado

Hay algo que nadie te cuenta del día en que entiendes que no puedes controlarlo todo. Al principio duele, sí. Pero si te quedas el tiempo suficiente con esa verdad, empieza a sentirse como alivio.

Porque si no puedes controlarlo todo, tampoco eres responsable de todo. No tienes que sostener el mundo sobre tus hombros. No tienes que adivinar cada desenlace ni evitar cada caída. Puedes dedicarte a lo único que de verdad te pertenece: tu manera de estar en la vida.

Séneca escribía que la vida no es corta, sino que la desperdiciamos. Una de las formas más comunes de desperdiciarla es gastarla en el intento imposible de controlar lo incontrolable. Cada hora que dedicas a preocuparte por lo que no depende de ti es una hora que le quitas a lo que sí.

Y lo que sí depende de ti es muchísimo. Cómo hablas a las personas que quieres. Qué haces con tus mañanas. A qué le dices que sí y a qué le dices que no. Qué aprendes de tus errores. Cómo te levantas después de cada golpe.

## Cierre

Al principio de este episodio te pedí que pensaras en una situación concreta que hoy te quita el sueño. Vuelve a ella ahora.

Divídela en dos columnas. En una, lo que no depende de ti. Míralo con honestidad y, si puedes, con un poco de compasión. Esa columna no es tu trabajo. En la otra, lo que sí depende de ti. Elige una sola cosa de esa columna. Una. Y hazla mañana.

Eso es todo. No necesitas transformar tu vida en una noche. Los estoicos no buscaban la perfección; buscaban el progreso. Cada día un poco más de claridad. Cada día un poco menos de lucha contra la lluvia.

El día que entiendes que no puedes controlarlo todo no es el día en que pierdes el control. Es el día en que, por fin, empiezas a usarlo bien.

Gracias por acompañarme. Respira hondo. Y recuerda: dispara bien, y luego suelta la flecha.`,
};
