/**
 * Gate adapters for the synchronous paid providers on the Generate path (voice, music).
 * Each one: fixture bypass (no network, no cost) -> paid-call gate -> result persisted under
 * `${requestId}/paid/` so a later attempt reuses it with zero provider calls.
 */
import { stableHash } from "@/lib/production-intelligence/canonical";
import type { MusicProvider, MusicResult, MusicSelectionContext, ScriptLanguage, VoiceProvider, VoiceResult, WordTiming } from "@/lib/providers/types";
import { guardPaidCall, paidCallKey, type LedgerStore, type PaidCallSpec } from "./gate";
import { paidResultPath, sha256Hex, UNSTORED_REF, type PaidResultStore } from "./result-store";
import { lintPronunciationAliases, restoreDisplayWords, spokenText, TtsVoiceMissingError, type PronunciationAlias } from "./pronunciation";

export type PaidCallDeps = { ledger: LedgerStore; results: PaidResultStore; requestId: string };

type StoredVoice = { audioPath: string; sha256: string; bytes: number; durationSeconds: number; words: WordTiming[]; mimeType: string; extension: string };
type StoredMusic = { audioPath: string; sha256: string; bytes: number; durationSeconds: number; mimeType: string; extension: string; track?: MusicResult["track"] };

async function storeAudio<M extends { audioPath: string; sha256: string; bytes: number }>(
  results: PaidResultStore,
  requestId: string,
  key: string,
  audio: { audioBuffer: Buffer; mimeType: string; extension: string },
  meta: Omit<M, "audioPath" | "sha256" | "bytes">,
): Promise<string> {
  const audioPath = paidResultPath(requestId, key, audio.extension);
  const jsonPath = paidResultPath(requestId, key, "json");
  try {
    await results.putBytes(audioPath, audio.audioBuffer, audio.mimeType);
    await results.putJson(jsonPath, { ...meta, audioPath, sha256: sha256Hex(audio.audioBuffer), bytes: audio.audioBuffer.byteLength });
    return jsonPath;
  } catch (err) {
    // The provider already charged: commit with an unloadable ref rather than lose the row. A
    // later attempt refuses (PaidResultUnavailableError) instead of paying again.
    return `${UNSTORED_REF}${err instanceof Error ? err.message.slice(0, 160) : "storage error"}`;
  }
}

async function loadAudio<M extends { audioPath: string; sha256: string; bytes: number }>(results: PaidResultStore, resultRef: string): Promise<{ meta: M; audioBuffer: Buffer } | null> {
  if (resultRef.startsWith(UNSTORED_REF)) return null;
  const meta = await results.getJson<M>(resultRef);
  if (!meta) return null;
  const audioBuffer = await results.getBytes(meta.audioPath);
  if (!audioBuffer || audioBuffer.byteLength !== meta.bytes || sha256Hex(audioBuffer) !== meta.sha256) return null;
  return { meta, audioBuffer };
}

/**
 * A result already stored for this exact paid call (any gate ordinal), sha256-verified. The
 * object is written right after the provider answered and before the ledger row is closed, so a
 * crash in between leaves the asset with the row still SUBMITTED: reusing it costs nothing and
 * leaves the ledger untouched (PI V2 COST-6). Null when nothing valid is stored.
 */
async function loadStoredResult<T>(results: PaidResultStore, requestId: string, spec: PaidCallSpec, load: (resultRef: string) => Promise<T | null>): Promise<T | null> {
  for (const ordinal of [0, 1]) {
    const stored = await load(paidResultPath(requestId, paidCallKey(spec, ordinal), "json"));
    if (stored) return stored;
  }
  return null;
}

/**
 * Reuse-only lookup of a narration chunk that was ALREADY paid and stored (same fingerprint as
 * gatedVoiceSynthesize). Never calls the provider and never writes the ledger: returns null when the chunk was
 * not stored. Used to rebuild word timings (subtitles) for an episode at no cost.
 */
export async function storedVoiceResult(
  deps: Pick<PaidCallDeps, "results" | "requestId"> & { voiceProvider: Pick<VoiceProvider, "name">; voiceIdentity: { voiceId: string; modelId: string; voiceSettingsJson: string } },
  text: string,
  language: ScriptLanguage,
  speed?: number,
  opts: { aliases?: readonly PronunciationAlias[] } = {},
): Promise<VoiceResult | null> {
  const aliases = opts.aliases ?? [];
  const ttsText = spokenText(text, aliases);
  const fingerprint = { text: ttsText, language, speed: speed ?? null, voiceId: deps.voiceIdentity.voiceId, modelId: deps.voiceIdentity.modelId, voiceSettingsJson: deps.voiceIdentity.voiceSettingsJson };
  const spec: PaidCallSpec = {
    projectId: deps.requestId, shotId: `voice:${stableHash(fingerprint, 16)}`, provider: deps.voiceProvider.name, model: deps.voiceIdentity.modelId,
    method: "tts_with_timestamps", capacityUnits: ttsText.length, inputFingerprint: fingerprint, reservedUsd: 0,
  };
  const load = async (resultRef: string): Promise<VoiceResult | null> => {
    const stored = await loadAudio<StoredVoice>(deps.results, resultRef);
    if (!stored) return null;
    const { meta, audioBuffer } = stored;
    return { audioBuffer, durationSeconds: meta.durationSeconds, words: meta.words, mimeType: meta.mimeType, extension: meta.extension };
  };
  const stored = await loadStoredResult(deps.results, deps.requestId, spec, load);
  return stored ? { ...stored, words: restoreDisplayWords(stored.words, aliases) } : null;
}

/**
 * ElevenLabs on Generate (Reel voice ×2 incl. the speed correction, Avatar narration). The key
 * is the text + language + speed + voice identity; render_attempts is not part of it.
 *
 * B4 (RB-07): before anything else, a missing voice_id or a broken pronunciation alias (hyphen or
 * uppercase in the spoken form) throws — no ledger row, no provider call. Aliases change only the
 * text sent to TTS; the returned word timings are mapped back to the display words, so captions
 * built from them show the canonical text. Without aliases the spoken text equals `text`, so the
 * B1 key of every existing call is unchanged.
 */
export async function gatedVoiceSynthesize(
  deps: PaidCallDeps & { voiceProvider: VoiceProvider; voiceIdentity: { voiceId: string; modelId: string; voiceSettingsJson: string }; estimatedCostUsd: number },
  text: string,
  language: ScriptLanguage,
  speed?: number,
  opts: { aliases?: readonly PronunciationAlias[] } = {},
): Promise<VoiceResult & { reused: boolean; costUsd: number }> {
  if (!deps.voiceIdentity.voiceId?.trim()) throw new TtsVoiceMissingError();
  const aliases = opts.aliases ?? [];
  lintPronunciationAliases(aliases);
  const ttsText = spokenText(text, aliases);
  if (deps.voiceProvider.name === "fixture") {
    const r = await deps.voiceProvider.synthesize(ttsText, language, speed);
    return { ...r, words: restoreDisplayWords(r.words, aliases), reused: false, costUsd: 0 };
  }
  const fingerprint = { text: ttsText, language, speed: speed ?? null, voiceId: deps.voiceIdentity.voiceId, modelId: deps.voiceIdentity.modelId, voiceSettingsJson: deps.voiceIdentity.voiceSettingsJson };
  const spec: PaidCallSpec = {
    projectId: deps.requestId,
    shotId: `voice:${stableHash(fingerprint, 16)}`,
    provider: deps.voiceProvider.name,
    model: deps.voiceIdentity.modelId,
    method: "tts_with_timestamps",
    capacityUnits: ttsText.length,
    inputFingerprint: fingerprint,
    reservedUsd: Math.max(0, deps.estimatedCostUsd),
  };
  const load = async (resultRef: string): Promise<VoiceResult | null> => {
    const stored = await loadAudio<StoredVoice>(deps.results, resultRef);
    if (!stored) return null;
    const { meta, audioBuffer } = stored;
    return { audioBuffer, durationSeconds: meta.durationSeconds, words: meta.words, mimeType: meta.mimeType, extension: meta.extension };
  };
  const stored = await loadStoredResult(deps.results, deps.requestId, spec, load);
  if (stored) return { ...stored, words: restoreDisplayWords(stored.words, aliases), reused: true, costUsd: 0 };
  const guarded = await guardPaidCall<VoiceResult>(
    deps.ledger,
    spec,
    {
      call: async ({ key }) => {
        const r = await deps.voiceProvider.synthesize(ttsText, language, speed);
        const resultRef = await storeAudio<StoredVoice>(deps.results, deps.requestId, key, r, { durationSeconds: r.durationSeconds, words: r.words, mimeType: r.mimeType, extension: r.extension });
        return { result: r, costUsd: Math.max(0, deps.estimatedCostUsd), resultRef };
      },
      load,
    },
  );
  return { ...guarded.result, words: restoreDisplayWords(guarded.result.words, aliases), reused: guarded.reused, costUsd: guarded.costUsd };
}

type MusicCallDeps = PaidCallDeps & { musicProvider: MusicProvider; estimatedCostUsd: number };

/** Only a generative provider (Beatoven) is paid; the curated library and the fixture are free. */
export const isPaidMusicProvider = (provider: MusicProvider) => provider.name === "beatoven";

function musicCallSpec(deps: MusicCallDeps, context: MusicSelectionContext): PaidCallSpec {
  const fingerprint = { durationSeconds: Math.round(context.durationSeconds), style: context.style ?? null, topic: context.topic ?? null, scriptText: context.scriptText ?? null, language: context.language ?? null, seed: context.seed ?? null };
  return {
    projectId: deps.requestId,
    shotId: `music:${stableHash(fingerprint, 16)}`,
    provider: deps.musicProvider.name,
    model: "maestro",
    method: "compose",
    inputFingerprint: fingerprint,
    reservedUsd: Math.max(0, deps.estimatedCostUsd),
  };
}

async function loadMusic(results: PaidResultStore, resultRef: string): Promise<MusicResult | null> {
  const stored = await loadAudio<StoredMusic>(results, resultRef);
  if (!stored) return null;
  const { meta, audioBuffer } = stored;
  return { audioBuffer, durationSeconds: meta.durationSeconds, mimeType: meta.mimeType, extension: meta.extension, track: meta.track };
}

/**
 * Music on Generate and Long Form. Only a generative provider (Beatoven) is paid; the curated
 * library and the fixture are free and pass through untouched.
 */
export async function gatedMusicTrack(
  deps: MusicCallDeps,
  context: MusicSelectionContext,
): Promise<MusicResult & { reused: boolean; costUsd: number }> {
  if (!isPaidMusicProvider(deps.musicProvider)) {
    const r = await deps.musicProvider.getTrack(context);
    return { ...r, reused: false, costUsd: 0 };
  }
  const spec = musicCallSpec(deps, context);
  const stored = await loadStoredResult(deps.results, deps.requestId, spec, (ref) => loadMusic(deps.results, ref));
  if (stored) return { ...stored, reused: true, costUsd: 0 };
  const guarded = await guardPaidCall<MusicResult>(
    deps.ledger,
    spec,
    {
      call: async ({ key }) => {
        const r = await deps.musicProvider.getTrack(context);
        const resultRef = await storeAudio<StoredMusic>(deps.results, deps.requestId, key, r, { durationSeconds: r.durationSeconds, mimeType: r.mimeType, extension: r.extension, track: r.track });
        return { result: r, costUsd: Math.max(0, deps.estimatedCostUsd), resultRef };
      },
      load: (resultRef) => loadMusic(deps.results, resultRef),
    },
  );
  return { ...guarded.result, reused: guarded.reused, costUsd: guarded.costUsd };
}

/**
 * Read-only: the COMMITTED paid track for this exact context (same key as `gatedMusicTrack`), with
 * its sha256 verified; null when there is none. Never calls the provider nor writes the ledger.
 */
export async function loadCommittedMusicTrack(deps: MusicCallDeps, context: MusicSelectionContext): Promise<MusicResult | null> {
  const spec = musicCallSpec(deps, context);
  // Ordinal 1 holds a gate retry after a pre-acceptance refusal (rows from before COST-A2's default of 0).
  for (const ordinal of [0, 1]) {
    const op = await deps.ledger.get(paidCallKey(spec, ordinal));
    if (op?.status === "COMMITTED" && op.resultRef) return loadMusic(deps.results, op.resultRef);
  }
  return null;
}
