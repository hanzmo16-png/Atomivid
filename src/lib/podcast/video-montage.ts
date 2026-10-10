/**
 * Podcast → video: the editor v3 montage (podcast-editor/montaje@2) for an episode whose narration is already
 * mastered. The audio is carried untouched (audio.modo "mezcla_final"); the picture is a sequence of title cards,
 * one per chapter of at most `chapterSeconds` (each card already carries the title, so no separate title overlay), so a 30-minute episode is rendered and cached in short chunks
 * (a failure never restarts one 30-minute ffmpeg run). Pure: no I/O.
 */
export const PODCAST_VIDEO_CHAPTER_SECONDS = 300;

export type MontageAudio = { path: string; size: number; sha256: string };

export function buildPodcastMontage(input: {
  episodeId: string;
  version: number;
  title: string;
  durationSeconds: number;
  audio: MontageAudio;
  chapterSeconds?: number;
}) {
  const duration = Math.max(1, input.durationSeconds);
  const chapterSeconds = input.chapterSeconds ?? PODCAST_VIDEO_CHAPTER_SECONDS;
  const parts = Math.max(1, Math.ceil(duration / chapterSeconds));
  const title = input.title.trim().slice(0, 120) || "Episodio";
  const timeline = Array.from({ length: parts }, (_, i) => {
    const start = i * chapterSeconds;
    const length = Math.max(1, Math.min(chapterSeconds, duration - start));
    return {
      id: `parte-${i + 1}`,
      type: "card" as const,
      // The last card is stretched/trimmed to the exact audio length by audio.timeline "extender_ultimo".
      duration: Number(length.toFixed(3)),
      chapter: `c${i + 1}`,
      lines: parts > 1 ? [title, `Parte ${i + 1} de ${parts}`] : [title],
      color: "#0b1020",
    };
  });
  return {
    schema: "podcast-editor/montaje@2",
    episode_id: input.episodeId,
    assembly_version: input.version,
    files: [{ id: "mezcla", path: input.audio.path, size: input.audio.size, sha256: input.audio.sha256, role: "mezcla_final" }],
    output: { width: 1920, height: 1080, fps: 25, crf: 23, preset: "veryfast", threads: 4, metadata: { title } },
    chapters: timeline.map((s, i) => ({ id: s.chapter, title: parts > 1 ? `Parte ${i + 1}` : title, start: i * chapterSeconds })),
    timeline,
    audio: { modo: "mezcla_final", source: "mezcla", timeline: "extender_ultimo" },
  };
}

/** entrada/LISTO.json: the editor's "inputs complete" signal, tied to the exact montaje.json bytes. */
export function readySignal(manifestSha256: string, montage: { files: unknown[]; episode_id: string; assembly_version: number }) {
  return { manifest_sha256: manifestSha256, file_count: montage.files.length, episode_id: montage.episode_id, assembly_version: montage.assembly_version };
}
