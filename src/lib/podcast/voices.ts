/**
 * Voices actually available to the configured ElevenLabs account (GET /v1/voices: read-only, free, no
 * audio generated). Only these can be chosen; the server re-checks the choice before any paid call.
 */
export type AccountVoice = { voiceId: string; name: string; category: string | null; language: string | null; accent: string | null; gender: string | null; previewUrl: string | null };

type Raw = { voice_id?: unknown; name?: unknown; category?: unknown; preview_url?: unknown; labels?: Record<string, unknown> | null; verified_languages?: { language?: unknown }[] | null };
const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export class VoicesUnavailableError extends Error {
  constructor(readonly customerMessage: string) { super(customerMessage); }
}

let cache: { at: number; voices: AccountVoice[] } | null = null;
const TTL_MS = 5 * 60_000;

export function parseVoices(body: unknown): AccountVoice[] {
  const list = (body as { voices?: Raw[] } | null)?.voices;
  if (!Array.isArray(list)) return [];
  return list.flatMap((v) => {
    const voiceId = s(v.voice_id), name = s(v.name);
    if (!voiceId || !name || !/^[A-Za-z0-9]{8,64}$/.test(voiceId)) return [];
    const labels = v.labels ?? {};
    return [{ voiceId, name, category: s(v.category), language: s(labels.language) ?? s(v.verified_languages?.[0]?.language), accent: s(labels.accent), gender: s(labels.gender),
      previewUrl: s(v.preview_url)?.startsWith("https://") ? s(v.preview_url) : null }];
  }).sort((a, b) => a.name.localeCompare(b.name, "es"));
}

export async function listAccountVoices(opts: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: () => number; fresh?: boolean } = {}): Promise<AccountVoice[]> {
  const env = opts.env ?? process.env, fetchImpl = opts.fetchImpl ?? fetch, now = opts.now ?? Date.now;
  if (!opts.fresh && cache && now() - cache.at < TTL_MS) return cache.voices;
  const key = env.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new VoicesUnavailableError("La voz sintética no está configurada en el servidor (falta la credencial de ElevenLabs).");
  let res: Response;
  try {
    res = await fetchImpl("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key }, cache: "no-store" });
  } catch {
    throw new VoicesUnavailableError("ElevenLabs no respondió al consultar las voces. Inténtalo de nuevo en un minuto.");
  }
  if (!res.ok) throw new VoicesUnavailableError(`ElevenLabs rechazó la consulta de voces (código ${res.status}). Revisa la cuenta del proveedor.`);
  const voices = parseVoices(await res.json().catch(() => null));
  cache = { at: now(), voices };
  return voices;
}

/** Test hook. */
export function resetVoiceCache() { cache = null; }
