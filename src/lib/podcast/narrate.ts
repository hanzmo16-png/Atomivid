/** Paid narration of an episode (server only: ffmpeg mastering). See episode.ts for the pure parts. */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getPricingConfig } from "@/lib/billing/pricing";
import { gatedVoiceSynthesize, storedVoiceResult, type PaidCallDeps } from "@/lib/paid-calls/gated-providers";
import type { VoiceProvider, WordTiming } from "@/lib/providers/types";
import { masterAudioLoudness, type LoudnessMeasurement } from "@/lib/video/audio-master";
import { splitNarrationIntoSafeChunks, stitchNarrationParts, type NarrationPart } from "@/lib/video/long-form/timeline";
import { ceil4, podcastAudioPath, podcastLedgerProject, type PodcastEpisode } from "./episode";

export type NarrationDeps = Omit<PaidCallDeps, "requestId"> & {
  voiceProvider: VoiceProvider;
  voiceIdentity: { voiceId: string; modelId: string; voiceSettingsJson: string };
  putAudio: (path: string, bytes: Buffer, contentType: string) => Promise<void>;
};

export type NarrationOutcome = { audioPath: string; bytes: number; sha256: string; durationSeconds: number; costUsd: number; reusedChunks: number; chunks: number; loudness: LoudnessMeasurement };

/**
 * Narrates the episode chunk by chunk through the paid-call gate (each chunk keyed by text + voice +
 * model + settings; its audio persisted before the ledger row closes), then stitches, masters to
 * AAC/M4A and stores the episode. Re-running after a crash or timeout reuses every stored chunk at $0.
 */
export async function narrateEpisode(deps: NarrationDeps, episode: Pick<PodcastEpisode, "id" | "user_id" | "script" | "language">): Promise<NarrationOutcome> {
  if (!episode.script) throw new Error("El episodio no tiene guion.");
  const chunks = splitNarrationIntoSafeChunks(episode.script);
  const rate = getPricingConfig().elevenLabsUsdPer1kChars;
  const parts: NarrationPart[] = [];
  let costUsd = 0, reusedChunks = 0;
  for (const chunk of chunks) {
    const r = await gatedVoiceSynthesize({ ...deps, requestId: podcastLedgerProject(episode.id), estimatedCostUsd: ceil4((chunk.length / 1000) * rate) }, chunk, episode.language);
    costUsd += r.costUsd;
    if (r.reused) reusedChunks++;
    parts.push({ audioBuffer: r.audioBuffer, mimeType: r.mimeType, extension: r.extension, durationSeconds: r.durationSeconds, words: r.words });
  }
  const stitched = stitchNarrationParts(parts);
  const dir = await mkdtemp(path.join(tmpdir(), "podcast-"));
  try {
    const raw = path.join(dir, `narration.${stitched.extension}`), out = path.join(dir, "episode.m4a");
    await writeFile(raw, stitched.audioBuffer);
    const m = await masterAudioLoudness(raw, out, { truePeakMarginDb: 1, faststart: true });
    const bytes = await readFile(out);
    const audioPath = podcastAudioPath(episode);
    await deps.putAudio(audioPath, bytes, "audio/mp4");
    return { audioPath, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), durationSeconds: stitched.durationSeconds, costUsd: ceil4(costUsd), reusedChunks, chunks: chunks.length, loudness: m.after };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Word timings of an episode that was ALREADY narrated, rebuilt from its stored paid chunks (same keys as
 * narrateEpisode, same offsets as stitchNarrationParts). Reuse-only: never calls the provider or the ledger.
 * Null when the episode has no script or any chunk is not stored (the video is then made without subtitles).
 */
export async function storedNarrationWords(
  deps: Pick<PaidCallDeps, "results"> & { voiceProvider: Pick<VoiceProvider, "name">; voiceIdentity: { voiceId: string; modelId: string; voiceSettingsJson: string } },
  episode: Pick<PodcastEpisode, "id" | "script" | "language">,
): Promise<WordTiming[] | null> {
  if (!episode.script) return null;
  const words: WordTiming[] = [];
  let offset = 0;
  for (const chunk of splitNarrationIntoSafeChunks(episode.script)) {
    const r = await storedVoiceResult({ ...deps, requestId: podcastLedgerProject(episode.id) }, chunk, episode.language);
    if (!r) return null;
    for (const w of r.words) words.push({ text: w.text, startSeconds: w.startSeconds + offset, endSeconds: w.endSeconds + offset });
    offset += r.durationSeconds;
  }
  return words;
}
