const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
// "Rachel", una de las voces por defecto de ElevenLabs, como fallback si no
// se configura una voz propia.
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
// Turbo v2.5: modelo multilingüe de menor costo/latencia de ElevenLabs,
// suficiente para narración de reels (ver notas de presupuesto).
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5";

type ElevenLabsAlignment = {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
};

type ElevenLabsResponse = {
  audio_base64: string;
  alignment: ElevenLabsAlignment;
};

export type WordTiming = {
  text: string;
  startSeconds: number;
  endSeconds: number;
};

export async function synthesizeVoice(text: string): Promise<{
  audioBuffer: Buffer;
  durationSeconds: number;
  words: WordTiming[];
}> {
  if (!ELEVENLABS_API_KEY) {
    throw new Error("Falta configurar ELEVENLABS_API_KEY");
  }

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/with-timestamps`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: MODEL_ID,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    },
  );

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    throw new Error(`ElevenLabs respondió ${res.status}: ${errorBody}`);
  }

  const data = (await res.json()) as ElevenLabsResponse;
  const audioBuffer = Buffer.from(data.audio_base64, "base64");
  const words = buildWordTimings(data.alignment);
  const durationSeconds = data.alignment.character_end_times_seconds.at(-1) ?? 0;

  return { audioBuffer, durationSeconds, words };
}

function buildWordTimings(alignment: ElevenLabsAlignment): WordTiming[] {
  const words: WordTiming[] = [];
  let current: { chars: string[]; start: number; end: number } | null = null;

  alignment.characters.forEach((char, i) => {
    const start = alignment.character_start_times_seconds[i];
    const end = alignment.character_end_times_seconds[i];

    if (/\s/.test(char)) {
      if (current) {
        words.push({
          text: current.chars.join(""),
          startSeconds: current.start,
          endSeconds: current.end,
        });
        current = null;
      }
      return;
    }

    if (!current) {
      current = { chars: [char], start, end };
    } else {
      current.chars.push(char);
      current.end = end;
    }
  });

  if (current) {
    const last: { chars: string[]; start: number; end: number } = current;
    words.push({
      text: last.chars.join(""),
      startSeconds: last.start,
      endSeconds: last.end,
    });
  }

  return words;
}
