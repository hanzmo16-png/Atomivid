/**
 * Genera una biblioteca ampliada de música de fondo con la API de música
 * de ElevenLabs (Eleven Music — entrenada con datos con licencia,
 * autorizada para uso comercial; ver docs.elevenlabs.io) y la sube al
 * bucket privado `music-library` de Supabase Storage.
 *
 * Gasto real autorizado explícitamente por el usuario (~$1-3 USD total,
 * $0.15/min de música generada). Corre solo bajo workflow_dispatch con
 * las claves reales — nunca en el entorno de desarrollo de Claude Code
 * (sin salida de red a elevenlabs.io).
 *
 * Uso: npx tsx scripts/generate-music-library.ts
 * Requiere: ELEVENLABS_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * No detiene el lote completo si una pista falla — registra el error y
 * sigue con las demás, para no desperdiciar el gasto ya hecho en las
 * pistas anteriores. Al final escribe un JSON con las entradas de
 * MUSIC_MANIFEST listas para revisar y pegar manualmente en
 * src/lib/providers/music/manifest.ts (nunca las escribe ahí directo —
 * ese archivo es código de producción, se revisa antes de commitear).
 */
import fs from "node:fs/promises";
import path from "node:path";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const MUSIC_LIBRARY_BUCKET = "music-library";
const OUTPUT_FORMAT = "mp3_44100_128";
const TRACK_LENGTH_MS = 45_000;
const COST_PER_MINUTE_USD = 0.15;

type TrackPlan = {
  id: string;
  title: string;
  tones: string[];
  prompt: string;
};

// 2 pistas por tono (10 tonos definidos en src/lib/providers/types.ts) —
// hoy el banco solo cubre motivational/corporate/cinematic/energetic
// (las 2 pistas existentes de Pixabay), dejando tension/reflective/
// minimal/inspirational/technology/luxury sin ninguna pista real: un
// video de "historias de terror" o "curiosidades" terminaba con música
// motivacional/corporativa por no tener nada mejor que ofrecer. Este
// lote cubre los 10 tonos.
const TRACK_PLAN: TrackPlan[] = [
  { id: "elevenlabs-motivational-1", title: "Motivational Rise", tones: ["motivational"], prompt: "Uplifting motivational instrumental with driving piano and strings building to an inspiring climax, steady mid tempo, purely instrumental, no vocals" },
  { id: "elevenlabs-motivational-2", title: "Motivational Drive", tones: ["motivational", "energetic"], prompt: "Energetic motivational corporate instrumental with claps and building synths, hopeful and empowering, purely instrumental, no vocals" },

  { id: "elevenlabs-corporate-1", title: "Corporate Clean", tones: ["corporate"], prompt: "Clean modern corporate background instrumental, light percussion and warm synths, professional and optimistic, purely instrumental, no vocals" },
  { id: "elevenlabs-corporate-2", title: "Corporate Pulse", tones: ["corporate", "technology"], prompt: "Minimal corporate tech instrumental with soft piano and a subtle electronic pulse, calm and confident, purely instrumental, no vocals" },

  { id: "elevenlabs-cinematic-1", title: "Cinematic Rise", tones: ["cinematic"], prompt: "Epic cinematic instrumental with orchestral strings and deep percussion, building tension to a triumphant swell, purely instrumental, no vocals" },
  { id: "elevenlabs-cinematic-2", title: "Cinematic Emotion", tones: ["cinematic", "reflective"], prompt: "Dramatic cinematic instrumental with piano and strings, emotional and sweeping, purely instrumental, no vocals" },

  { id: "elevenlabs-inspirational-1", title: "Inspirational Warmth", tones: ["inspirational"], prompt: "Warm inspirational instrumental with acoustic guitar and soft strings, hopeful and heartfelt, purely instrumental, no vocals" },
  { id: "elevenlabs-inspirational-2", title: "Inspirational Glow", tones: ["inspirational", "reflective"], prompt: "Uplifting inspirational instrumental with piano and gentle choir-like pads, dreamy and hopeful, purely instrumental, no vocals" },

  { id: "elevenlabs-tension-1", title: "Tension Dark", tones: ["tension"], prompt: "Dark suspenseful instrumental with eerie strings and low drones, slowly building tension, horror atmosphere, purely instrumental, no vocals" },
  { id: "elevenlabs-tension-2", title: "Tension Pulse", tones: ["tension"], prompt: "Tense mysterious instrumental with pulsing bass and unsettling ambient textures, purely instrumental, no vocals" },

  { id: "elevenlabs-reflective-1", title: "Reflective Calm", tones: ["reflective"], prompt: "Calm reflective instrumental with soft piano and ambient pads, introspective and peaceful, purely instrumental, no vocals" },
  { id: "elevenlabs-reflective-2", title: "Reflective Warmth", tones: ["reflective"], prompt: "Gentle reflective instrumental with warm acoustic guitar and light strings, thoughtful and serene, purely instrumental, no vocals" },

  { id: "elevenlabs-energetic-1", title: "Energetic Beat", tones: ["energetic"], prompt: "High energy upbeat instrumental with a driving electronic beat and punchy synths, fun and fast-paced, purely instrumental, no vocals" },
  { id: "elevenlabs-energetic-2", title: "Energetic Bounce", tones: ["energetic"], prompt: "Playful energetic instrumental with bouncy bass and bright percussion, fun and lighthearted, purely instrumental, no vocals" },

  { id: "elevenlabs-minimal-1", title: "Minimal Sparse", tones: ["minimal"], prompt: "Minimal ambient instrumental with sparse piano notes and subtle texture, clean and understated, purely instrumental, no vocals" },
  { id: "elevenlabs-minimal-2", title: "Minimal Pulse", tones: ["minimal", "technology"], prompt: "Minimal electronic instrumental with soft pulsing tones and light percussion, modern and simple, purely instrumental, no vocals" },

  { id: "elevenlabs-technology-1", title: "Technology Future", tones: ["technology"], prompt: "Futuristic tech instrumental with digital synths and glitchy percussion, modern and innovative, purely instrumental, no vocals" },
  { id: "elevenlabs-technology-2", title: "Technology Sleek", tones: ["technology"], prompt: "Sleek technology instrumental with pulsing electronic arpeggios and clean bass, forward-thinking, purely instrumental, no vocals" },

  { id: "elevenlabs-luxury-1", title: "Luxury Elegant", tones: ["luxury"], prompt: "Elegant luxury instrumental with smooth piano and soft strings, sophisticated and refined, purely instrumental, no vocals" },
  { id: "elevenlabs-luxury-2", title: "Luxury Smooth", tones: ["luxury"], prompt: "Upscale luxury instrumental with warm jazz-influenced piano and a subtle bassline, classy and smooth, purely instrumental, no vocals" },
];

async function composeTrack(prompt: string): Promise<Buffer> {
  const res = await fetch("https://api.elevenlabs.io/v1/music", {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      music_length_ms: TRACK_LENGTH_MS,
      force_instrumental: true,
      output_format: OUTPUT_FORMAT,
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    throw new Error(`ElevenLabs Music respondió ${res.status}: ${errorBody.slice(0, 300)}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function main() {
  if (!ELEVENLABS_API_KEY) {
    throw new Error("Falta ELEVENLABS_API_KEY");
  }

  const { createServiceClient } = await import("../src/lib/supabase/service");
  const service = createServiceClient();

  const estimatedCostUsd = (TRACK_PLAN.length * (TRACK_LENGTH_MS / 60_000) * COST_PER_MINUTE_USD).toFixed(2);
  console.log(
    `Generando ${TRACK_PLAN.length} pistas de ${TRACK_LENGTH_MS / 1000}s cada una — costo estimado ~$${estimatedCostUsd} USD.`,
  );

  const manifestEntries: unknown[] = [];
  const failures: { id: string; error: string }[] = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const track of TRACK_PLAN) {
    try {
      console.log(`→ ${track.id}: generando...`);
      const audioBuffer = await composeTrack(track.prompt);
      const storagePath = `${track.id}.mp3`;

      const { error: uploadError } = await service.storage
        .from(MUSIC_LIBRARY_BUCKET)
        .upload(storagePath, audioBuffer, { contentType: "audio/mpeg", upsert: false });

      if (uploadError) {
        throw new Error(`Error al subir a Storage: ${uploadError.message}`);
      }

      console.log(`  OK — subida a ${MUSIC_LIBRARY_BUCKET}/${storagePath} (${audioBuffer.length} bytes)`);

      manifestEntries.push({
        id: track.id,
        title: track.title,
        author: "ElevenLabs (Eleven Music)",
        sourceUrl: "https://elevenlabs.io/eleven-music-api",
        license: "Eleven Music — entrenado con datos con licencia, autorizado para uso comercial",
        provider: "elevenlabs",
        dateObtainedISO: today,
        instrumental: true,
        tones: track.tones,
        styleTags: [],
        storagePath,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  FALLÓ ${track.id}: ${message}`);
      failures.push({ id: track.id, error: message });
    }
  }

  const outPath = path.join(process.cwd(), "music-library-manifest-additions.json");
  await fs.writeFile(outPath, JSON.stringify({ manifestEntries, failures }, null, 2));

  console.log(`\nListo: ${manifestEntries.length}/${TRACK_PLAN.length} pistas generadas y subidas.`);
  if (failures.length > 0) {
    console.log(`${failures.length} fallaron (ver detalle arriba y en ${outPath}).`);
  }
  console.log(`Entradas de manifest escritas en: ${outPath}`);
  console.log("Revisa el archivo y pega las entradas nuevas en src/lib/providers/music/manifest.ts manualmente.");
}

main().catch((err) => {
  console.error("Fallo el script:", err);
  process.exit(1);
});
