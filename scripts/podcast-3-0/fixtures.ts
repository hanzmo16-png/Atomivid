/** Especificaciones de demostración (una por modo). Voces/avatares ficticios: proveedores SIMULADOS. */
import { STUDIO_VERSION, StudioSpec } from "../../src/lib/podcast/v3/spec";

const base = { version: STUDIO_VERSION, language: "es" as const, format: "16:9" as const, audio_export: "mp3" as const, budget_usd: 5 };
export const NARRACION = StudioSpec.parse({ ...base, mode: "narracion", title: "El misterio de la señal Wow!", topic: "señal Wow", target_minutes: 1,
  script: [
    "En agosto de 1977, el radiotelescopio Big Ear de Ohio registró una señal de radio intensa y estrecha que duró setenta y dos segundos.",
    "El astrónomo Jerry Ehman revisaba las impresiones de datos cuando vio la secuencia y escribió una palabra en el margen: Wow.",
    "La señal venía de la constelación de Sagitario y nunca volvió a detectarse, a pesar de decenas de búsquedas posteriores.",
    "Hoy existen hipótesis naturales, como nubes de hidrógeno, pero ninguna explica todo con certeza. El misterio sigue abierto.",
  ].join("\n\n"),
  participants: [{ id: "A", name: "Narrador", voice_id: "voiceNarradorA1", avatar: { kind: "ninguno" } }, { id: "B", name: "Segunda voz", voice_id: "voiceNarradorB2", avatar: { kind: "ninguno" } }],
  visual: { set: "estudio_oscuro", subtitles: true, recreations: true }, music: { enabled: true, mood: "misterio", volume_db: -22, stings: true, ambient: "noche" } });

export const AVATAR = StudioSpec.parse({ ...base, mode: "avatar", title: "Tres datos sobre los volcanes", topic: "volcanes", target_minutes: 1,
  script: [
    "Hola, soy tu presentador. Hoy te cuento tres datos sorprendentes sobre los volcanes.",
    "Primero: el volcán más alto conocido, Olympus Mons, no está en la Tierra sino en Marte, y triplica la altura del Everest.",
    "Segundo: la lava basáltica puede superar los mil cien grados, pero se enfría formando rocas que luego se convierten en suelo fértil.",
    "Tercero: los volcanes también crean islas enteras, como Hawái, que siguen creciendo hoy.",
    "Gracias por acompañarme. Nos vemos en el próximo episodio.",
  ].join("\n\n"),
  participants: [{ id: "A", name: "Hans", voice_id: "voiceHansSint1", voice_kind: "sintetica", avatar: { kind: "existente", avatar_id: "avatar-hans-demo" } }],
  visual: { set: "estudio_calido", subtitles: true, avatar_frequency: 0.6, avatar_max_seconds: 8, recreations: false }, music: { enabled: true, mood: "documental", volume_db: -24, stings: true, ambient: "ninguno" } });

export const DIALOGO = StudioSpec.parse({ ...base, mode: "dialogo", title: "¿Hay vida en Europa, la luna de Júpiter?", topic: "vida en Europa", target_minutes: 1,
  script: [
    "Ana: Bienvenidos. Hoy hablamos de Europa, la luna de Júpiter, con Luis, astrobiólogo.",
    "Luis: Gracias, Ana. Europa es uno de los mejores lugares para buscar vida fuera de la Tierra.",
    "Ana: ¿Por qué Europa y no Marte?",
    "Luis: Porque bajo su corteza de hielo probablemente hay un océano de agua líquida, con más agua que todos los océanos terrestres.",
    "Ana: ¡Increíble!",
    "Luis: Lo prudente es decir que es un candidato, no una prueba. La misión Europa Clipper buscará indicios químicos.",
    "Ana: ¿Y qué encontraría exactamente esa misión?",
    "Luis: Medirá el hielo, el campo magnético y la composición de la superficie para saber si el océano tiene ingredientes para la vida.",
    "Ana: Gracias, Luis. Nos escuchamos pronto.",
  ].join("\n"),
  participants: [
    { id: "A", name: "Ana", voice_id: "voiceAnaHost1", avatar: { kind: "existente", avatar_id: "avatar-ana" } },
    { id: "B", name: "Luis", role: "astrobiólogo", voice_id: "voiceLuisGuest", avatar: { kind: "foto", photo_path: "u/demo/luis.jpg", consent: { given: true, at: "2026-10-23T12:00:00Z", text: "Confirmo que tengo derecho a usar esta imagen y autorizo crear un avatar." } } },
  ],
  visual: { set: "biblioteca", subtitles: true, avatar_frequency: 0.8, avatar_max_seconds: 10, recreations: true, swap_sides: false }, music: { enabled: true, mood: "auto", volume_db: -22, stings: true, ambient: "ninguno" } });
