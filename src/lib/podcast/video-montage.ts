/**
 * Podcast → video: the editor v3 montage (podcast-editor/montaje@2) for an episode whose narration is already
 * mastered. The audio is carried untouched (audio.modo "mezcla_final").
 *  - With shots (visual-assets.ts): one moving segment per scene of the visual plan (stock clip or animated photo,
 *    already normalised to the scene length), the episode title over the opening seconds, and the narration's own
 *    word timings burned in as subtitles when available. A scene without a shot reuses an earlier, non-adjacent
 *    shot that is long enough; only when none exists does that one scene fall back to a card.
 *  - Without shots (no stock available): the previous title cards, one per chapter of at most `chapterSeconds`.
 * Every segment is rendered and cached by the editor in short chunks (a failure never restarts a 30-minute run).
 * Pure: no I/O.
 */
export const PODCAST_VIDEO_CHAPTER_SECONDS = 300;

export type MontageAudio = { path: string; size: number; sha256: string };
export type MontageShot = { path: string; size: number; sha256: string; seconds: number; credit: string; pageUrl?: string };
/** One scene of the visual plan (contiguous, in order) and its normalised shot, or null when none was found. */
export type MontageScene = { start: number; end: number; shot: MontageShot | null };
export type MontageSubtitles = { path: string; size: number; sha256: string };

const FPS = 25;
const frameAt = (s: number) => Math.round(s * FPS) / FPS;
/** Opening title over the first scenes (seconds). */
export const PODCAST_TITLE_SECONDS = 6;

export function buildPodcastMontage(input: {
  episodeId: string;
  version: number;
  title: string;
  durationSeconds: number;
  audio: MontageAudio;
  chapterSeconds?: number;
  scenes?: MontageScene[];
  subtitles?: MontageSubtitles | null;
}) {
  if (input.scenes?.some((s) => s.shot)) return buildSceneMontage({ ...input, scenes: input.scenes });
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

function buildSceneMontage(input: { episodeId: string; version: number; title: string; durationSeconds: number; audio: MontageAudio; scenes: MontageScene[]; subtitles?: MontageSubtitles | null }) {
  const title = input.title.trim().slice(0, 120) || "Episodio";
  const files: Record<string, unknown>[] = [{ id: "mezcla", path: input.audio.path, size: input.audio.size, sha256: input.audio.sha256, role: "mezcla_final" }];
  const fileIds = new Map<string, string>();
  const fileFor = (shot: MontageShot) => {
    let id = fileIds.get(shot.path);
    if (!id) {
      id = `escena-${fileIds.size + 1}`;
      fileIds.set(shot.path, id);
      files.push({ id, path: shot.path, size: shot.size, sha256: shot.sha256, role: "animation" });
    }
    return id;
  };
  const present = input.scenes.flatMap((s, i) => (s.shot ? [{ s: s.shot, i }] : []));
  const shown: number[] = [];
  const sources: { text: string; url?: string }[] = [];
  const timeline = input.scenes.map(({ start: sceneStart, end: sceneEnd, shot }, i) => {
    const start = frameAt(i === 0 ? 0 : sceneStart);
    const end = frameAt(sceneEnd);
    const length = Number(Math.max(1 / FPS, end - start).toFixed(3));
    // A missing scene borrows an earlier shot that covers it: never the one just on screen, and the one seen
    // longest ago first.
    const lastSeen = (k: number) => shown.lastIndexOf(k);
    const use = shot ?? present.filter((x) => x.i < i && x.s.seconds >= length && shown[shown.length - 1] !== x.i)
      .sort((a, b) => lastSeen(a.i) - lastSeen(b.i))[0]?.s ?? null;
    const usedIndex = shot ? i : use ? present.find((x) => x.s === use)!.i : -1;
    if (usedIndex >= 0) shown.push(usedIndex);
    const id = `escena-${String(i + 1).padStart(4, "0")}`;
    if (!use) return { id, type: "card" as const, duration: length, lines: [title], color: "#0b1020" };
    if (shot && !sources.some((x) => x.text === shot.credit && x.url === shot.pageUrl)) sources.push({ text: shot.credit, ...(shot.pageUrl ? { url: shot.pageUrl } : {}) });
    // Shots are rendered SHOT_MARGIN_SECONDS longer than their scene; the hold covers frame rounding at the end.
    return { id, type: "animation" as const, source: fileFor(use), in: 0, duration: length, insuficiente: { modo: "congelar", max_segundos: 1 } };
  });
  if (input.subtitles) files.push({ id: "subtitulos", path: input.subtitles.path, size: input.subtitles.size, sha256: input.subtitles.sha256, role: "subtitles_words" });
  return {
    schema: "podcast-editor/montaje@2",
    episode_id: input.episodeId,
    assembly_version: input.version,
    files,
    output: { width: 1920, height: 1080, fps: FPS, crf: 23, preset: "veryfast", threads: 4, metadata: { title } },
    chapters: [{ id: "c1", title, start: 0 }],
    timeline,
    title_card: { text: title, start: 0, end: Math.min(PODCAST_TITLE_SECONDS, input.durationSeconds) },
    ...(input.subtitles ? { subtitles: { source: "subtitulos", format: "words_json", mode: "burn", group_max_words: 7 } } : {}),
    sources_credits: { sources },
    audio: { modo: "mezcla_final", source: "mezcla", timeline: "extender_ultimo" },
  };
}

/** entrada/LISTO.json: the editor's "inputs complete" signal, tied to the exact montaje.json bytes. */
export function readySignal(manifestSha256: string, montage: { files: unknown[]; episode_id: string; assembly_version: number }) {
  return { manifest_sha256: manifestSha256, file_count: montage.files.length, episode_id: montage.episode_id, assembly_version: montage.assembly_version };
}
