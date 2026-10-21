/** Fixtures deterministas (tema neutral: huracanes del Caribe). Fuente de hechos: NOAA. Sin personas reales identificables. */
import { DISCLAIMER, gapFor, type Conversation, type Turn } from "@/lib/podcast/v2/conversation";

const NOAA = "https://www.nhc.noaa.gov/climo/";
export const SUBTOPICS = [
  { t: "el agua caliente del océano", f: "Los huracanes necesitan agua de mar de al menos veintiséis grados para formarse.", h: "Quizás por eso las temporadas recientes se sienten más largas." },
  { t: "la temporada oficial", f: "La temporada atlántica va del primero de junio al treinta de noviembre.", h: "Tal vez la gente se relaja demasiado en junio." },
  { t: "la escala Saffir-Simpson", f: "La escala Saffir-Simpson clasifica los huracanes en cinco categorías según el viento sostenido.", h: "Me pregunto si la escala comunica bien el peligro del agua." },
  { t: "la marejada ciclónica", f: "La marejada ciclónica suele causar más daño que el viento en la costa.", h: "En el fondo, el agua es la parte que menos se entiende." },
  { t: "el ojo del huracán", f: "En el ojo del huracán el cielo puede despejarse y el viento casi desaparece.", h: "Ese silencio engaña a mucha gente." },
  { t: "los nombres de las tormentas", f: "La Organización Meteorológica Mundial mantiene listas rotativas de nombres.", h: "Al final, un nombre hace que la tormenta se recuerde." },
  { t: "los pronósticos de trayectoria", f: "El cono de pronóstico muestra la trayectoria probable del centro, no el tamaño de la tormenta.", h: "Quizás el cono necesita una explicación más clara." },
  { t: "la intensificación rápida", f: "Se llama intensificación rápida cuando el viento sube treinta nudos o más en veinticuatro horas.", h: "Eso deja muy poco tiempo para reaccionar." },
  { t: "los manglares", f: "Los manglares reducen la energía de las olas que llegan a la costa.", h: "Tal vez protegerlos sea la defensa más barata." },
  { t: "la preparación en casa", f: "Las guías oficiales recomiendan agua y comida para al menos tres días.", h: "Me pregunto cuántas familias lo tienen listo hoy." },
  { t: "los satélites", f: "Los satélites geoestacionarios vigilan el Atlántico de forma continua.", h: "Sin ellos, cada tormenta sería una sorpresa." },
  { t: "los aviones cazahuracanes", f: "Hay aviones que vuelan dentro de los huracanes para medir presión y viento.", h: "Es increíble que alguien haga ese trabajo." },
];

export function conversationFixture(sources: { A: Conversation["participants"][0]["source"]; B: Conversation["participants"][1]["source"] } = { A: "mock", B: "mock" }): Conversation {
  const turns: Omit<Turn, "gap_after_ms">[] = [];
  const add = (speaker: "A" | "B", kind: Turn["kind"], claim: Turn["claim"], text: string) => turns.push({ turn_id: `T${String(turns.length + 1).padStart(3, "0")}`, speaker, kind, claim, text, source_url: claim === "documented_fact" ? NOAA : null });
  add("A", "transition", "opinion", "Bienvenidos. Hoy hablamos de huracanes del Caribe, con datos y con dudas honestas.");
  const QS = ["¿Qué tan importante es", "¿Por dónde empezarías a explicar", "¿Qué se suele malinterpretar sobre", "¿Qué dicen los datos sobre"];
  const FU = ["¿Y eso cambia algo para quien vive en la costa?", "Entonces, ¿qué debería hacer una familia distinto?", "¿Hay alguna excepción que valga la pena mencionar?", "¿Eso se puede medir o es más bien intuición?"];
  const RE = ["Tiene sentido, y lo anoto para el resumen.", "Vale, eso ordena bastante la conversación.", "Me quedo con esa idea, es muy práctica.", "Buen punto; casi nadie lo dice así de claro."];
  const EL = ["Los registros históricos lo muestran temporada tras temporada.", "Las agencias oficiales lo repiten en cada boletín.", "Y los modelos de pronóstico lo tienen muy en cuenta.", "Por eso los protocolos de protección civil parten de ahí."];
  SUBTOPICS.forEach((s, i) => {
    const q = i % 2 ? "B" : "A", r = q === "A" ? "B" : "A";
    add(q, "question", "opinion", `${QS[i % 4]} ${s.t}, si hablamos de huracanes?`);
    add(r, "answer", "documented_fact", `${s.f} ${EL[i % 4]} Ese dato, por sí solo, ya explica una parte del problema, aunque no todo.`);
    add(q, "follow_up", "opinion", `Sobre ${s.t}: ${FU[i % 4]}`);
    add(r, i % 3 === 0 ? "disagreement" : "clarification", "hypothesis", `${s.h} Ojo, esto es una hipótesis mía, no un dato confirmado; lo digo para separar opinión de evidencia.`);
    add(q, i % 4 === 1 ? "surprise" : "reaction", "opinion", i % 4 === 1 ? `¡No me digas! No lo había pensado así con ${s.t}.` : `Con ${s.t}, ${RE[i % 4].charAt(0).toLowerCase()}${RE[i % 4].slice(1)}`);
    if (i < SUBTOPICS.length - 1) add(r, "transition", "opinion", `Ahora bien, pasemos a ${SUBTOPICS[i + 1].t}.`);
  });
  add("B", "reaction", "opinion", "Al final, lo importante es prepararse con tiempo y escuchar las fuentes oficiales.");
  const full: Turn[] = turns.map((t, i) => ({ ...t, gap_after_ms: gapFor(t.kind, turns[i + 1]?.kind) }));
  return { version: "podcast-conversation/1", topic: "Huracanes del Caribe", target_minutes: 10, disclaimer: DISCLAIMER,
    participants: [{ id: "A", display_name: "Participante A (simulado)", source: sources.A, voice_id: sources.A === "own_recording" ? null : "mock-voice-a", visual: "image" },
      { id: "B", display_name: "Participante B (simulado)", source: sources.B, voice_id: "mock-voice-b", visual: "image" }], turns: full };
}

/** ~15 min monólogo: cada subtema en 5 párrafos con funciones narrativas distintas. */
export function narrationFixture(): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  out.push({ id: "S000", text: "Esto es un episodio de prueba simulado. Vamos a recorrer cómo nace, crece y golpea un huracán." });
  SUBTOPICS.forEach((s, i) => {
    out.push({ id: `S${i}a`, text: `Empecemos con ${s.t}. ${s.f} Es un punto de partida sencillo, pero conviene explicarlo con calma, porque de ahí se desprende todo lo demás que vamos a ver en este bloque.` });
    out.push({ id: `S${i}b`, text: `Lo curioso de ${s.t} es que casi nadie lo menciona en las noticias, ¿por qué? Porque es menos visual que el viento, y sin embargo decide buena parte del resultado final.` });
    out.push({ id: `S${i}c`, text: i % 3 === 0 ? `Esa noche, de repente, ${s.t} lo cambió todo para una costa entera. El silencio antes del impacto fue lo que más se recuerda.` : `En realidad, ${s.t} tiene una consecuencia práctica que pocos aplican en su casa, y vale la pena repetirla en voz alta.` });
    out.push({ id: `S${i}d`, text: `${s.h} Me pregunto si la próxima generación lo verá distinto, con más datos y menos miedo frente a ${s.t}.` });
    out.push({ id: `S${i}e`, text: i % 2 ? `¡Esto es impresionante! Con lo que sabemos de ${s.t}, ya se pueden salvar muchas vidas cada temporada.` : `Vamos a cerrar esta parte sobre ${s.t} con una idea clara y pasar al siguiente tema.` });
  });
  out.push({ id: "S999", text: "Al final, entender el huracán es la mejor forma de respetarlo. Gracias por escuchar este episodio simulado." });
  return out;
}
