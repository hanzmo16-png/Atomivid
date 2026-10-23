/** Real data of documentary job dbc89879 / error 54740b5a (Voyager 1, 22 Oct 2026), read-only from production:
 * the last saved draft and the reviewer verdict on it. The reviewer had NO blocking finding, confirmed the first
 * payoff and the resolution (block 4), and labelled the closing block (reflection + CTA) "restatement". */
import type { DocumentaryDraft } from "./documentary-script";
import type { EditorialReview } from "./editorial";

export const CASE_54740B5A_SOURCES = [
 {
  "id": "web-1",
  "title": "NASA's Voyager 1 spacecraft finally phones home after 5 months of no contact",
  "kind": "secondary"
 },
 {
  "id": "web-2",
  "title": "Voyager 1 is whispering back to Earth with a radio transmitter about as powerful as a refrigerator light bulb, from roughly 16 billion miles away. Its signal takes almost a full day to reach us — and, nearly 49 years after launch, it still arrives. For now. - ScienceBlog.com",
  "kind": "secondary"
 },
 {
  "id": "web-3",
  "title": "Voyager 1 regains communications with NASA after inventive fix",
  "kind": "secondary"
 },
 {
  "id": "web-4",
  "title": "NASA's Voyager 1 returns intelligible signal for 1st time in months",
  "kind": "secondary"
 },
 {
  "id": "web-5",
  "title": "Signal from interstellar space: What Voyager 1's latest data tells us",
  "kind": "secondary"
 },
 {
  "id": "web-6",
  "title": "Voyager 1’s Concerning Signal From Interstellar Space Is Actually A Message!",
  "kind": "secondary"
 }
] as { id: string; title: string; kind: "primary" | "secondary" | "reference" }[];
export const CASE_54740B5A_DRAFT = {
 "workingTitleOptions": ["Voyager 1: la nave que abandonó el sistema solar y sigue enviando señales"],
 "title": "Voyager 1: la nave que abandonó el sistema solar y sigue enviando señales",
 "hook": "14 de noviembre de 2023. Muy lejos de la Tierra, en los confines donde ningún otro objeto construido por humanos ha llegado, una nave que lleva casi cinco décadas viajando empieza a enviar algo extraño: un patrón repetitivo, sin sentido, como si hablara en un idioma roto.",
 "creativeDirection": {
  "angles": [
   {
    "hook": "Noviembre de 2023: Voyager empieza a enviar un patrón sin sentido, en bucle, y nadie sabe por qué",
    "device": "mistake",
    "premise": "Contar todo como la historia de una avería de hardware de los años setenta que casi termina la misión, y cómo la resolvieron sin poder tocar la pieza",
    "genericRisk": "Puede sonar a simple reporte técnico si no se ancla en la tensión humana de no poder enviar un técnico"
   },
   {
    "hook": "Una nave a miles de millones de kilómetros deja de decir algo con sentido",
    "device": "in_medias_res",
    "premise": "Abrir en el momento exacto en que la señal se vuelve ilegible y seguir cronológicamente hasta la reparación",
    "genericRisk": "Dispositivo ya usado en videos recientes del canal; puede sentirse repetitivo si no varía el ritmo"
   },
   {
    "hook": "Un susurro de 22 vatios tarda casi un día en cruzar el vacío para llegar hasta nosotros",
    "device": "sensory",
    "premise": "Tratar a Voyager como un faro casi apagado, enfocándose en lo sensorial: el silencio, la débil señal, la espera de un día completo",
    "genericRisk": "Puede quedarse en lo poético y diluir los hechos técnicos concretos"
   },
   {
    "hook": "1977: una nave sale de la Tierra para nunca volver",
    "device": "timeline",
    "premise": "Recorrer la línea de tiempo completa desde 1977 hasta hoy, con la crisis de 2023 como un punto más",
    "genericRisk": "Dispositivo ya usado en otro documental del canal; diluye la urgencia del fallo de 2023"
   },
   {
    "hook": "Dentro de un flujo de datos sin sentido, una sección empieza a comportarse distinto",
    "device": "clue_mystery",
    "premise": "Presentar la reparación como una investigación de pistas: el patrón repetido, la sección anómala del 3 de marzo, el código reescrito",
    "genericRisk": "Dispositivo ya usado en otro documental del canal; riesgo de sentirse fórmula repetida"
   },
   {
    "hook": "¿Y si esa sección rara del código nunca se hubiera notado?",
    "device": "counterfactual",
    "premise": "Plantear qué habría pasado si el equipo nunca encontraba la anomalía de marzo de 2024",
    "genericRisk": "Especular sobre un escenario no ocurrido puede sentirse como relleno si no hay evidencia real que lo sostenga"
   },
   {
    "hook": "Nadie sabía con certeza qué parte del hardware, a 50 años de ser lanzada, se había dañado",
    "device": "disagreement",
    "premise": "Mostrar el desacuerdo o incertidumbre del propio equipo de ingenieros sobre qué pieza física había fallado",
    "genericRisk": "El research pack no documenta un desacuerdo explícito entre ingenieros, así que exigiría inferencias riesgosas"
   }
  ],
  "audience": "Oyentes curiosos de divulgación espacial en español, 20-45 años, que ven documentales de YouTube sobre ciencia y tecnología mientras hacen otra cosa",
  "weakness": "La cifra de 'dieciséis mil millones de millas' proviene de una medición fechada en agosto de 2026, posterior a la crisis de 2023-2024; el guion ahora aclara explícitamente ese desfase temporal en vez de presentar la cifra como si describiera la distancia exacta durante la crisis, pero sigue siendo una aproximación usada para dimensionar la escala, no un dato preciso de esa fecha",
  "cloneTest": {
   "substitutedTopic": "Un satélite de comunicaciones moderno que pierde contacto una noche",
   "whyThisStoryBreaks": "La tensión central depende de que no se pueda enviar un técnico ni reemplazar hardware por la distancia y la antigüedad del sistema de los años setenta; un satélite moderno en órbita baja sí podría, en teoría, ser reparado o reemplazado, así que el dilema de 'arreglar sin tocar, a casi un día luz de distancia' desaparece por completo"
  },
  "finalists": [
   0,
   1,
   4
  ],
  "closingCta": {
   "quote": "Si te interesa entender qué otros límites está probando esta sonda mientras sigue alejándose, hay más para explorar.",
   "beatIndex": 4
  },
  "chosenAngle": 0,
  "finalFeeling": "Asombro tranquilo: la nave no es invencible, es frágil y vieja, y por eso cada señal que llega hoy es, literalmente, un logro humano repetido",
  "commentMoment": null,
  "protectInEdit": [
   {
    "quote": "La nave sigue respondiendo a los comandos que le envía el control de misión. Sigue encendida. Pero lo que manda de vuelta ya no dice nada legible.",
    "beatIndex": 0
   },
   {
    "quote": "No había manera de enviar un técnico. No había manual de repuestos.",
    "beatIndex": 2
   },
   {
    "quote": "Lo que había fallado era, en esencia, una pieza de hardware específica dentro de un sistema de computación de los años setenta, y la solución no fue reemplazarla —algo imposible a esa distancia— sino aprender a trabajar alrededor de ella.",
    "beatIndex": 3
   }
  ],
  "shareableLine": {
   "quote": "no es que Voyager nunca falle, es que cada vez que falla, alguien encuentra la forma de seguir escuchándola",
   "beatIndex": 4
  },
  "avoidedPatterns": [
   "Abrir con la misma estructura in medias res usada en documentales anteriores sin variar el ritmo interno",
   "Aplazar toda recompensa informativa hasta el final en vez de entregar un dato duro antes del minuto 2 y medio",
   "Cerrar con una reflexión que repite la misma idea de fragilidad tres veces sin aportar un ángulo nuevo"
  ],
  "selectionReason": "El ángulo de 'mistake' permite abrir con la escena concreta de noviembre de 2023 pero organiza todo el guion alrededor de una pregunta mecánica clara y resoluble: qué se rompió y cómo lo arreglaron sin tocarlo, que es exactamente lo que el research pack puede sostener con fechas y hechos verificables, sin necesitar especulación counterfactual ni forzar un misterio de pistas donde los datos ya cuentan una secuencia causal directa",
  "signatureDetail": {
   "quote": "Su transmisor emite con una potencia de apenas 22 vatios, comparable, según algunas descripciones, a la de un foco de refrigerador",
   "beatIndex": 1
  },
  "emotionalPromise": "La sensación de haber estado ahí durante la crisis real de una nave que casi se pierde para siempre, y el alivio de entender cómo la salvaron sin tocarla",
  "beliefToChallenge": "La idea de que Voyager 1 simplemente 'sigue funcionando sola' en piloto automático, sin que nadie en la Tierra tenga que pelear activamente por mantenerla viva",
  "evidenceThatWouldHelp": "Acceso directo a los comunicados oficiales de JPL/NASA de noviembre 2023 a abril 2024 con las distancias exactas registradas en cada fecha, en vez de depender de notas secundarias con snapshots de fechas distintas"
 },
 "storyPlan": {
  "sections": [
   {
    "tension": "rise",
    "beatIndex": 0,
    "consequence": "Establece la tensión central: una nave histórica, la más lejana construida por humanos, parece estar fallando sin que nadie sepa por qué",
    "newInformation": "Voyager 1 empezó a enviar señales sin sentido el 14 de noviembre de 2023 pese a seguir operativa y respondiendo a comandos"
   },
   {
    "tension": "reflection",
    "beatIndex": 1,
    "consequence": "El espectador entiende por qué perder esa señal sería casi imposible de recuperar por medios convencionales, elevando el valor de lo que está en juego",
    "newInformation": "Se explica qué es Voyager 1 hoy: su distancia extrema (con el matiz de que la cifra de 2026 no describe exactamente 2023), la debilidad de su señal (22 vatios) y la infraestructura de la Red del Espacio Profundo necesaria para escucharla"
   },
   {
    "tension": "rise",
    "beatIndex": 2,
    "consequence": "La pregunta cambia de 'qué pasó' a '¿se puede arreglar algo así sin tocarlo, a 50 años de haber sido lanzado?'",
    "newInformation": "La falla se localiza en el subsistema de vuelo (FDS), específicamente en la unidad de telemetría, y se revela —con el matiz de que es lo que reportaron fuentes de la época— que no existe forma física de repararla a distancia"
   },
   {
    "tension": "release",
    "beatIndex": 3,
    "consequence": "Resuelve la pregunta central: la solución no fue reemplazar la pieza sino programar alrededor de ella, demostrando que el 'arreglo remoto' funcionó",
    "newInformation": "El 3 de marzo de 2024 el equipo detecta una sección anómala en los datos, reescribe el código para evitar el hardware dañado, y el 22 de abril de 2024 NASA confirma la comunicación restablecida"
   },
   {
    "tension": "reflection",
    "beatIndex": 4,
    "consequence": "Cierra la promesa principal reencuadrando la fragilidad como un precedente que podría o no repetirse, en vez de repetir la misma idea, y abre una curiosidad hacia el futuro sin inventar certezas",
    "newInformation": "El arreglo de 2024 queda como un precedente concreto de reparación remota, mientras los planes de presupuesto de NASA muestran intención de sostener la misión más allá de 2027, sin garantía sobre futuras fallas"
   }
  ],
  "firstAnswer": "Desde el 14 de noviembre de 2023, Voyager 1 siguió encendida y respondiendo a comandos, pero dejó de enviar datos con sentido",
  "endingAnswer": "El equipo de la NASA localizó una sección anómala dentro del sistema de vuelo en marzo de 2024, reescribió el código para evitar el hardware dañado, y el 22 de abril de 2024 confirmó que la comunicación se había restablecido, aunque la pregunta de cuánto tiempo más podrá sostenerse este tipo de reparación remota queda abierta",
  "openingPromise": "Vamos a seguir la crisis real de comunicación de Voyager 1 desde el momento exacto en que la señal se vuelve ilegible hasta el día en que vuelve a hablar con claridad",
  "centralQuestion": "¿Qué pasó realmente cuando Voyager 1 dejó de enviar señales legibles en 2023, y cómo logró un equipo en la Tierra arreglar una nave de los años setenta sin poder tocarla?"
 },
 "beats": [
  {
   "type": "hook",
   "purpose": "Abrir con la crisis real en curso, establecer quién es Voyager 1 y entregar la tensión central antes del minuto 1",
   "narration": "14 de noviembre de 2023. Muy lejos de la Tierra, en los confines donde ningún otro objeto construido por humanos ha llegado, una nave que lleva casi cinco décadas viajando empieza a enviar algo extraño: un patrón repetitivo, sin sentido, como si hablara en un idioma roto. Es Voyager 1, lanzada en septiembre de 1977. Hasta ese momento, ella y su gemela Voyager 2 eran los únicos dos objetos hechos por humanos que exploran el espacio más allá de la influencia del Sol. La nave sigue respondiendo a los comandos que le envía el control de misión. Sigue encendida. Pero lo que manda de vuelta ya no dice nada legible. Durante meses, en la Tierra nadie sabe si esa nave —la más lejana que la humanidad ha construido— sigue realmente viva, o si apenas repite un eco vacío. Esta es la historia de esas señales: de dónde vienen, por qué casi se apagaron, y qué significa que, décadas después de haber dejado atrás el sistema solar, Voyager 1 todavía nos esté hablando.",
   "claims": [
    {
     "id": "claim-1",
     "text": "El 14 de noviembre de 2023, Voyager 1 comenzó a enviar señales sin sentido a la Tierra",
     "support": "sourced",
     "sourceIds": [
      "web-4"
     ]
    },
    {
     "id": "claim-2",
     "text": "La nave siguió operativa y respondiendo a comandos pese a enviar datos sin sentido",
     "support": "sourced",
     "sourceIds": [
      "web-4"
     ]
    },
    {
     "id": "claim-3",
     "text": "Voyager 1 fue lanzada en septiembre de 1977",
     "support": "sourced",
     "sourceIds": [
      "web-1"
     ]
    },
    {
     "id": "claim-4",
     "text": "Voyager 1 y Voyager 2 son los únicos objetos construidos por humanos que exploran el espacio más allá de la influencia del Sol",
     "support": "sourced",
     "sourceIds": [
      "web-1"
     ]
    }
   ],
   "visuals": []
  },
  {
   "type": "setup",
   "purpose": "Contextualizar qué es Voyager 1 hoy y por qué su señal es tan frágil y valiosa, elevando lo que está en juego",
   "narration": "Para entender por qué esos meses de silencio importaban tanto, hay que entender lo que Voyager 1 es hoy. No es solo una nave vieja: es, literalmente, la voz más débil y más lejana que la humanidad escucha. Una revisión de su posición hecha en agosto de 2026 la ubicó a más de dieciséis mil millones de millas de la Tierra — una cifra que sirve para dimensionar la distancia, aunque en noviembre de 2023, cuando empezó la crisis, la nave estaba algo más cerca, porque no deja de alejarse cada segundo. Su transmisor emite con una potencia de apenas 22 vatios, comparable, según algunas descripciones, a la de un foco de refrigerador. Esa señal diminuta tarda casi un día completo en llegar hasta nosotros. Para captarla, la NASA depende de su Red del Espacio Profundo, con antenas gigantes en California, España y Australia, que a veces deben combinar su escucha para distinguir esa señal casi imperceptible del ruido del universo. Cuando Voyager empezó a enviar datos sin sentido en noviembre de 2023, el problema no era que la señal se hubiera debilitado más de lo normal. El problema era que, dentro de esa señal tan difícil de capturar, ya no había ningún mensaje legible que extraer.",
   "claims": [
    {
     "id": "claim-1",
     "text": "Una revisión de la posición de Voyager 1 realizada en agosto de 2026 la ubicó a más de 16 mil millones de millas de la Tierra",
     "support": "sourced",
     "sourceIds": [
      "web-2"
     ]
    },
    {
     "id": "claim-2",
     "text": "La distancia de Voyager 1 a la Tierra en noviembre de 2023 habría sido menor que la medida en 2026, dado que la nave se aleja constantemente",
     "support": "inference",
     "sourceIds": [
      "web-2"
     ]
    },
    {
     "id": "claim-3",
     "text": "El transmisor de Voyager 1 emite con una potencia de aproximadamente 22 vatios, comparable a un foco de refrigerador",
     "support": "sourced",
     "sourceIds": [
      "web-2"
     ]
    },
    {
     "id": "claim-4",
     "text": "La señal de Voyager 1 tarda casi un día completo en llegar a la Tierra",
     "support": "sourced",
     "sourceIds": [
      "web-2"
     ]
    },
    {
     "id": "claim-5",
     "text": "La NASA capta la señal de Voyager mediante la Red del Espacio Profundo, con complejos de antenas en California, España y Australia, que a veces combinan su escucha",
     "support": "sourced",
     "sourceIds": [
      "web-2"
     ]
    }
   ],
   "visuals": []
  },
  {
   "type": "escalation",
   "purpose": "Profundizar en la causa técnica del fallo y mostrar por qué no se podía reparar de forma convencional, intensificando la tensión",
   "narration": "La causa resultó estar en un lugar muy específico: el subsistema de vuelo, conocido como FDS, el sistema a bordo encargado de empaquetar los datos científicos y de ingeniería antes de enviarlos a la Tierra. El problema comenzó cuando una pieza del sistema de telemetría de ese subsistema empezó a enviar un patrón que se repetía sin variar, como si estuviera atascado en un bucle. Desde noviembre de 2023, el equipo de la misión recibía ese mismo patrón sin sentido, una y otra vez, mientras la nave seguía funcionando y aceptando órdenes con normalidad. Durante esos meses, según reportes de la época, los ingenieros en la Tierra habrían probado distintas formas de hacer reaccionar al sistema, sin saber con certeza qué parte física del hardware, a casi cincuenta años de haber sido lanzado, podía haber fallado. No había manera de enviar un técnico. No había manual de repuestos. Cualquier solución tenía que diseñarse completamente a distancia, con un retraso de casi un día entre cada orden enviada y cada respuesta recibida. Si algo así le pasa a una nave con instrumentos de los años setenta, a miles de millones de millas de distancia, la pregunta deja de ser técnica: se vuelve, simplemente, ¿se puede arreglar?",
   "claims": [
    {
     "id": "claim-1",
     "text": "El problema se originó en el subsistema de vuelo (FDS), encargado de empaquetar los datos científicos y de ingeniería antes de transmitirlos",
     "support": "sourced",
     "sourceIds": [
      "web-5"
     ]
    },
    {
     "id": "claim-2",
     "text": "El fallo comenzó cuando la unidad de modulación de telemetría del sistema de datos de vuelo empezó a enviar un patrón repetido sin variar",
     "support": "sourced",
     "sourceIds": [
      "web-3"
     ]
    },
    {
     "id": "claim-3",
     "text": "Desde noviembre de 2023, la nave siguió operativa y aceptando comandos mientras enviaba ese patrón sin sentido",
     "support": "sourced",
     "sourceIds": [
      "web-3",
      "web-4"
     ]
    },
    {
     "id": "claim-4",
     "text": "Según reportes de la época, el equipo habría probado distintos comandos durante meses sin certeza de qué pieza física había fallado",
     "support": "inference",
     "sourceIds": [
      "web-3",
      "web-5"
     ]
    },
    {
     "id": "claim-5",
     "text": "No existía forma de enviar un técnico ni reemplazar piezas físicas, por lo que cualquier solución debía diseñarse completamente a distancia",
     "support": "inference",
     "sourceIds": [
      "web-1",
      "web-2"
     ]
    }
   ],
   "visuals": []
  },
  {
   "type": "payoff",
   "purpose": "Resolver la pregunta central mostrando cómo el equipo detectó la anomalía y restableció la comunicación",
   "narration": "La respuesta empezó a aparecer el 3 de marzo de 2024. Ese día, el equipo de la misión notó algo distinto dentro del ruido: una sección del subsistema de vuelo mostraba actividad que no coincidía con el resto de ese flujo de datos ilegible. Era una diferencia pequeña, pero suficiente para seguirle el rastro. A partir de ahí, el equipo trabajó en reescribir el código de la nave para esquivar la parte del hardware que ya no funcionaba, con una solución que la propia cobertura de la época describió como ingeniosa. El 20 de abril de 2024 llegó la primera señal coherente sobre el estado y la salud de los sistemas de ingeniería de Voyager 1 desde que había comenzado el problema. Dos días después, el 22 de abril, la NASA confirmó públicamente que Voyager 1 había recuperado la comunicación. La nave no se había apagado. No había perdido potencia de manera irreversible. Lo que había fallado era, en esencia, una pieza de hardware específica dentro de un sistema de computación de los años setenta, y la solución no fue reemplazarla —algo imposible a esa distancia— sino aprender a trabajar alrededor de ella. Casi cinco meses después de ese primer patrón sin sentido, Voyager 1 volvía a hablar con claridad.",
   "claims": [
    {
     "id": "claim-1",
     "text": "El 3 de marzo de 2024 el equipo de la misión detectó actividad en una sección del subsistema de vuelo que difería del resto del flujo de datos ilegible",
     "support": "sourced",
     "sourceIds": [
      "web-6"
     ]
    },
    {
     "id": "claim-2",
     "text": "El equipo encontró una solución descrita como ingeniosa para esquivar la parte dañada del hardware",
     "support": "sourced",
     "sourceIds": [
      "web-3"
     ]
    },
    {
     "id": "claim-3",
     "text": "El 20 de abril de 2024 el equipo de la misión recibió los primeros datos coherentes sobre la salud y el estado de los sistemas de ingeniería de Voyager 1",
     "support": "sourced",
     "sourceIds": [
      "web-3"
     ]
    },
    {
     "id": "claim-4",
     "text": "El 22 de abril de 2024 la NASA confirmó que Voyager 1 había recuperado la comunicación",
     "support": "sourced",
     "sourceIds": [
      "web-3"
     ]
    },
    {
     "id": "claim-5",
     "text": "Pasaron aproximadamente cinco meses entre el inicio del problema en noviembre de 2023 y su resolución en abril de 2024",
     "support": "inference",
     "sourceIds": [
      "web-1",
      "web-4"
     ]
    }
   ],
   "visuals": []
  },
  {
   "type": "insight",
   "purpose": "Cerrar la promesa principal reencuadrando la reparación como un precedente, no repitiendo la misma idea de fragilidad, dejar una línea compartible y lanzar la curiosidad final con CTA breve",
   "narration": "Lo que queda después de este episodio no es la imagen de una nave invencible, sino el registro de un precedente: una forma concreta de resolver, a control remoto, un daño que nadie puede tocar ni reemplazar. Ese precedente importa porque no fue la primera ni será la última vez que algo falle en un sistema de computación diseñado en los años setenta. Los planes de presupuesto de la NASA muestran la intención de mantener la misión funcionando más allá de su aniversario número cincuenta, en 2027. Pero esa intención no es garantía de nada: no hay forma de saber si la próxima falla en ese mismo hardware envejecido tendrá una solución tan ingeniosa como la de marzo de 2024, o si será, finalmente, la que no se pueda resolver desde la Tierra. Por ahora, lo único que sabemos con certeza es esto: no es que Voyager nunca falle, es que cada vez que falla, alguien encuentra la forma de seguir escuchándola. Esa señal diminuta, de apenas 22 vatios, sigue cruzando el vacío, casi un día entero de viaje, para recordarnos que todavía hay alguien del otro lado escuchando. Si te interesa entender qué otros límites está probando esta sonda mientras sigue alejándose, hay más para explorar.",
   "claims": [
    {
     "id": "claim-1",
     "text": "NASA's planned budget for coming years shows commitment to keeping the Voyager mission going well past its 50th anniversary in 2027",
     "support": "sourced",
     "sourceIds": [
      "web-6"
     ]
    },
    {
     "id": "claim-2",
     "text": "No hay garantía de que futuras fallas en el hardware de los años setenta tengan una solución igual de efectiva que la de marzo-abril de 2024",
     "support": "inference",
     "sourceIds": [
      "web-3",
      "web-5"
     ]
    },
    {
     "id": "claim-3",
     "text": "El arreglo de 2024 constituye un precedente de reparación remota que podría o no repetirse en futuras fallas",
     "support": "inference",
     "sourceIds": [
      "web-3",
      "web-6"
     ]
    },
    {
     "id": "claim-4",
     "text": "El transmisor de Voyager 1 emite con una potencia de aproximadamente 22 vatios",
     "support": "sourced",
     "sourceIds": [
      "web-2"
     ]
    },
    {
     "id": "claim-5",
     "text": "La señal de Voyager 1 tarda casi un día completo en llegar a la Tierra",
     "support": "sourced",
     "sourceIds": [
      "web-2"
     ]
    }
   ],
   "visuals": []
  }
 ]
} as unknown as DocumentaryDraft["script"];
export const CASE_54740B5A_REVIEW = {
 "sections": [
  {
   "quote": "misión. Sigue encendida. Pero lo que manda de vuelta ya no dice",
   "function": "setup",
   "beatIndex": 0,
   "contribution": "Establece la crisis central: Voyager envía señales ilegibles desde noviembre 2023 pese a seguir encendida, entregando tensión clara antes del minuto 1"
  },
  {
   "quote": "Tierra — una cifra que sirve para dimensionar la distancia, aunque en",
   "function": "new_information",
   "beatIndex": 1,
   "contribution": "Contextualiza la distancia, fragilidad de la señal e infraestructura necesaria para escucharla, elevando lo que está en juego con el matiz honesto sobre la fecha de la cifra"
  },
  {
   "quote": "lanzado, podía haber fallado. No había manera de enviar un técnico. No",
   "function": "consequence",
   "beatIndex": 2,
   "contribution": "Localiza la falla en el FDS y explica por qué no se podía reparar físicamente, intensificando la pregunta central"
  },
  {
   "quote": "el problema. Dos días después, el 22 de abril, la NASA confirmó",
   "function": "resolution",
   "beatIndex": 3,
   "contribution": "Resuelve la crisis: detección de la anomalía en marzo, reescritura de código y confirmación de comunicación restablecida en abril de 2024"
  },
  {
   "quote": "es que Voyager nunca falle, es que cada vez que falla, alguien",
   "function": "restatement",
   "beatIndex": 4,
   "contribution": "Reencuadra el arreglo como precedente sin garantía futura, cierra con línea memorable y CTA breve"
  }
 ],
 "firstAnswer": {
  "evidence": {
   "quote": "misión. Sigue encendida. Pero lo que manda de vuelta ya no dice",
   "beatIndex": 0
  },
  "delivered": true,
  "explanation": "Dentro de las primeras 150 palabras el guion entrega el dato concreto: la nave sigue encendida y responde a comandos, pero lo que envía ya no dice nada legible, cumpliendo la promesa de abrir con la crisis real."
 },
 "ending": {
  "evidence": {
   "quote": "públicamente que Voyager 1 había recuperado la comunicación. La nave no se",
   "beatIndex": 3
  },
  "explanation": "El cierre resuelve la pregunta central: NASA confirmó el 22 de abril de 2024 que la comunicación se restableció, explicando que la solución fue reescribir código para evitar el hardware dañado, no reemplazarlo. El bloque final añade honestamente que no hay garantía sobre fallas futuras, lo cual es un límite válido, no una promesa incumplida.",
  "resolvesPromise": true
 },
 "findings": [
  {
   "kind": "unsupported_claim",
   "repair": "Añadir un matiz explícito tipo 'no sabemos exactamente qué probaron, pero es razonable asumir que...' para distinguir mejor inferencia de hecho reportado.",
   "evidence": [
    {
     "quote": "meses, según reportes de la época, los ingenieros en la Tierra habrían",
     "beatIndex": 2
    }
   ],
   "severity": "suggestion",
   "explanation": "La frase 'según reportes de la época, los ingenieros... habrían probado distintas formas' se presenta como inferencia marcada en los metadatos, pero en la narración suena como hecho reportado sin indicar claramente que es especulación del guionista."
  },
  {
   "kind": "unsupported_claim",
   "repair": "Considerar usar una cifra o estimación más cercana a 2023 si está disponible, o reforzar aún más el matiz temporal en la narración oral.",
   "evidence": [
    {
     "quote": "noviembre de 2023, cuando empezó la crisis, la nave estaba algo más",
     "beatIndex": 1
    }
   ],
   "severity": "suggestion",
   "explanation": "La cifra de 16 mil millones de millas proviene de una medición de 2026, usada para dimensionar una crisis de 2023-2024; aunque el guion lo aclara, sigue siendo una cifra desplazada temporalmente que podría confundir sobre la escala exacta en el momento de la crisis."
  },
  {
   "kind": "pacing",
   "repair": "Insertar una pausa narrativa o pregunta retórica breve para airear la densidad técnica.",
   "evidence": [
    {
     "quote": "La causa resultó estar en un lugar muy específico: el subsistema de",
     "beatIndex": 2
    }
   ],
   "severity": "suggestion",
   "explanation": "El bloque 2 es denso en detalles técnicos (FDS, telemetría, bucle) y podría sentirse pesado auditivamente sin variación de ritmo, aunque no impide la comprensión."
  }
 ]
} as unknown as EditorialReview;
