/**
 * Worker de producción de Audio Podcast Studio (lo ejecuta `.github/workflows/audio-studio-worker.yml`).
 * Relee el proyecto desde Storage y llama a `renderProject`, que solo avanza si hay una autorización de gasto guardada
 * para el mismo modelo y monto: este script no autoriza nada por sí mismo.
 * Voz:
 *  - AUDIO_STUDIO_PAID_TTS=1 + AUDIO_STUDIO_ELEVENLABS_VOICES + ELEVENLABS_API_KEY → ElevenLabs (de pago). Apagado por defecto.
 *  - AUDIO_STUDIO_VOICE=demo (sin AUDIO_STUDIO_PAID_TTS=1) → voz de demostración espeak-ng (USD 0), SOLO si el dueño del
 *    proyecto es INTERNAL_PRODUCTION_OWNER_USER_ID. Para cualquier otra cuenta → SIN_VOZ, igual que antes.
 *  - En cualquier otro caso → NO genera (sale sin tocar el proyecto). La voz fixture nunca se usa en producción.
 * Uso: npx tsx scripts/audio-studio/worker.ts <ownerId> <projectId>
 */
import { createClient } from "@supabase/supabase-js";
import { AUDIO_STUDIO_BUCKET, storageStore } from "../../src/lib/audio-studio/store";
import { supabaseAudioPaidSupply } from "../../src/lib/audio-studio/paid-supply-port";
import { renderProject } from "../../src/lib/audio-studio/render";
import { workerOwnerIsInternal, workerPreflight } from "../../src/lib/audio-studio/worker";
import { voiceAvailability } from "../../src/lib/audio-studio/voice";
import { isUuid, modelRate } from "../../src/lib/audio-studio/model";

async function main() {
  const [ownerId, projectId] = process.argv.slice(2);
  if (!isUuid(ownerId ?? "") || !isUuid(projectId ?? "")) { console.log("RESULTADO ERROR identificadores inválidos"); process.exit(2); }
  const voice = voiceAvailability(process.env, (m) => modelRate(m).rate, { owner: workerOwnerIsInternal(ownerId, process.env) });
  if (!voice.ok || (voice.voice.mode !== "elevenlabs" && voice.voice.mode !== "demo")) { console.log(`RESULTADO SIN_VOZ ${voice.ok ? voice.voice.mode : voice.reason} (no se generó nada, USD 0)`); return; }
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.log("RESULTADO ERROR falta configuración de Storage"); process.exit(2); }
  const service = createClient(url, key, { auth: { persistSession: false } });
  const store = storageStore(service.storage.from(AUDIO_STUDIO_BUCKET) as never);
  // No se confía en el payload: proyecto, dueño, estado y autorización se comprueban antes de tocar nada.
  const reject = await workerPreflight(store, ownerId, projectId, { demo: voice.voice.mode === "demo" });
  if (reject) { console.log(`RESULTADO RECHAZADO ${reject} (no se leyó voz, no se sintetizó ni se escribió nada; USD 0)`); return; }
  const out = await renderProject({ store, voice: voice.voice, paidSupply: voice.voice.mode === "elevenlabs" ? supabaseAudioPaidSupply(service) : undefined, musicDir: process.env.AUDIO_STUDIO_MUSIC_DIR || undefined }, ownerId, projectId);
  console.log(`RESULTADO ${out.toUpperCase()}${voice.voice.mode === "demo" ? " (voz de demostración, USD 0)" : ""}`);
  if (out === "fallida") process.exit(1);
}

main().catch((e) => { console.log("RESULTADO ERROR", e instanceof Error ? e.message : String(e)); process.exit(1); });
