/**
 * Documental de prueba (~180 s al ritmo calibrado de Long Form, 2.5
 * palabras/s — ver duration-budget.ts) — SOLO para pruebas y la
 * demo de planes (scripts/long-form-plan-demo.ts). Nunca se usa en
 * producción: el guion real siempre viene de video_requests.script_json.
 */
import type { BeatType } from "./types";

export type FixtureBeat = {
  id: string;
  type: BeatType;
  purpose: string;
  narration: string;
  claims: never[];
  visuals?: { description: string; motion: boolean }[];
};

const NARRATIONS: { type: BeatType; narration: string; visuals: { description: string; motion: boolean }[] }[] = [
  {
    type: "hook",
    narration:
      "En 1914 un barco cruzó de un océano a otro atravesando montañas y selva en apenas ocho horas. Durante siglos esa travesía había exigido rodear todo un continente, enfrentando tormentas, meses de navegación y costos que arruinaban a comerciantes enteros. Francia lo intentó primero y fracasó de manera espectacular, dejando miles de muertos y una deuda que sacudió a su gobierno. Sin embargo, la obra terminó cambiando el comercio mundial para siempre. ¿Qué hizo posible lo que antes era imposible, y cuál fue el precio real que nadie quiso contar?",
    visuals: [
      { description: "cargo ship moving through the Panama Canal locks while workers are working on the lock gates", motion: true },
      { description: "old sailing ship in a storm at sea", motion: true },
      { description: "dense tropical jungle covering green mountains", motion: false },
    ],
  },
  {
    type: "setup",
    narration:
      "El primer intento serio comenzó en 1881 bajo la dirección de Ferdinand de Lesseps, el ingeniero que había triunfado en Suez. Su plan era excavar un canal a nivel del mar, sin esclusas, igual que en Egipto. Pero Panamá no era un desierto plano. Las lluvias torrenciales provocaban deslizamientos que enterraban en horas el trabajo de semanas. La fiebre amarilla y la malaria mataban a los trabajadores más rápido de lo que llegaban los reemplazos. En 1889 la compañía quebró y el proyecto quedó abandonado en medio del barro.",
    visuals: [
      { description: "workers digging through muddy earth with shovels during canal construction", motion: true },
      { description: "heavy tropical rain falling on a muddy hillside", motion: true },
      { description: "abandoned rusty steam excavator in the jungle", motion: false },
    ],
  },
  {
    type: "discovery",
    narration:
      "Cuando Estados Unidos retomó la obra en 1904, la primera gran decisión no fue de ingeniería sino de medicina. El médico William Gorgas entendió que los mosquitos transmitían las enfermedades que habían destruido el intento francés. Sus equipos drenaron pantanos, fumigaron barrios enteros e instalaron mosquiteros en cada edificio. En pocos años la fiebre amarilla desapareció de la zona del canal. Solo entonces los ingenieros pudieron concentrarse en el verdadero problema: mover una cantidad de tierra nunca vista en la historia.",
    visuals: [
      { description: "mosquito on skin, extreme close-up", motion: false },
      { description: "crowd of laborers walking and carrying spray pumps across a swamp", motion: true },
      { description: "wooden colonial buildings with mosquito nets on windows", motion: false },
    ],
  },
  {
    type: "escalation",
    narration:
      "El corte Culebra se convirtió en el centro de la batalla. Decenas de palas de vapor trabajaban día y noche mientras trenes cargados de tierra salían cada pocos minutos hacia los vertederos. En lugar de un canal a nivel del mar, el ingeniero John Stevens propuso un sistema de esclusas que elevaría los barcos veintiséis metros hasta un lago artificial. La represa de Gatún creó ese lago inundando valles completos y pueblos enteros. Fue una solución brillante, pero también obligó a desplazar a miles de personas que vivían allí.",
    visuals: [
      { description: "steam shovels digging rock and loading a train during canal construction", motion: true },
      { description: "freight train carrying earth through a construction site", motion: true },
      { description: "large calm artificial lake with flooded forest", motion: false },
      { description: "massive concrete dam spillway with water flowing", motion: true },
    ],
  },
  {
    type: "payoff",
    narration:
      "El 15 de agosto de 1914 el vapor Ancón completó el primer tránsito oficial. El mundo apenas lo notó porque la Primera Guerra Mundial acababa de estallar. Aun así, el canal redujo en miles de kilómetros las rutas entre Nueva York y San Francisco y transformó el comercio entre Asia, Europa y América. Más de cinco mil trabajadores murieron durante la etapa estadounidense, muchos de ellos llegados desde Barbados y Jamaica, cuyas historias casi nunca aparecen en los libros. Hoy miles de barcos cruzan cada año por esas mismas esclusas, sostenidos por una obra que costó mucho más que dinero.",
    visuals: [
      { description: "crowd gathering at the docks as a steamship is moving through the canal lock", motion: true },
      { description: "modern container ship passing through canal locks", motion: true },
      { description: "memorial plaque honoring canal workers", motion: false },
    ],
  },
];

/** Guion de ~180 s con `visuals` declarados (como un guion nuevo). */
export function documentary180sFixture(): { topic: string; beats: FixtureBeat[] } {
  return {
    topic: "El Canal de Panamá",
    beats: NARRATIONS.map((b, i) => ({ id: `beat-${i + 1}`, type: b.type, purpose: b.type, narration: b.narration, claims: [], visuals: b.visuals })),
  };
}

/** Mismo guion SIN `visuals` (como un guion creado antes de este campo). */
export function documentary180sLegacyFixture(): { topic: string; beats: FixtureBeat[] } {
  const script = documentary180sFixture();
  return { topic: script.topic, beats: script.beats.map((b) => ({ ...b, visuals: undefined })) };
}
