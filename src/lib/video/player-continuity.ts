/**
 * Playback continuity when the signed link of the SAME finished video is renewed.
 *
 * A snapshot is bound to one request and one stored object (origin + path, never the token), lives only
 * in memory of the open page and is consumed once: it can never be applied to another video, another
 * request or another account's page. Restoring respects the browser's autoplay rules — if play() is
 * refused the video stays paused at the saved position and the caller asks the user to press play.
 */

export type PlaybackSnapshot = {
  key: string;
  time: number;
  rate: number;
  paused: boolean;
  ended: boolean;
  volume: number;
  muted: boolean;
};

/** The subset of HTMLMediaElement this module reads and writes (lets tests use a plain object). */
export type MediaLike = {
  currentTime: number;
  playbackRate: number;
  paused: boolean;
  ended: boolean;
  volume: number;
  muted: boolean;
  duration: number;
  play(): Promise<void> | void;
};

export type RestoreOutcome = "resumed" | "paused" | "blocked";

/** Identity of the stored object behind a signed URL: request + origin + path, never the expiring token. */
export function mediaKey(requestId: string, signedUrl: string | null | undefined): string | null {
  if (!requestId || !signedUrl) return null;
  try {
    const u = new URL(signedUrl, "http://relative.invalid");
    return `${requestId}|${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

export function capturePlayback(el: MediaLike, key: string): PlaybackSnapshot {
  return {
    key,
    time: Number.isFinite(el.currentTime) && el.currentTime > 0 ? el.currentTime : 0,
    rate: Number.isFinite(el.playbackRate) && el.playbackRate > 0 ? el.playbackRate : 1,
    paused: el.paused,
    ended: el.ended,
    volume: Number.isFinite(el.volume) ? Math.min(1, Math.max(0, el.volume)) : 1,
    muted: el.muted,
  };
}

/** Only a snapshot of exactly this request + object may be applied. */
export function canRestore(snapshot: PlaybackSnapshot | null | undefined, key: string | null): snapshot is PlaybackSnapshot {
  return Boolean(snapshot && key && snapshot.key === key);
}

/** Position to seek to: never past the end of the (possibly shorter) new media. */
export function clampTime(time: number, duration: number): number {
  if (!Number.isFinite(time) || time <= 0) return 0;
  if (!Number.isFinite(duration) || duration <= 0) return time;
  return Math.min(time, Math.max(0, duration - 0.25));
}

/** Apply a snapshot to the freshly loaded media (call after loadedmetadata). */
export async function restorePlayback(el: MediaLike, snapshot: PlaybackSnapshot): Promise<RestoreOutcome> {
  el.playbackRate = snapshot.rate;
  el.volume = snapshot.volume;
  el.muted = snapshot.muted;
  el.currentTime = snapshot.ended ? (Number.isFinite(el.duration) ? el.duration : snapshot.time) : clampTime(snapshot.time, el.duration);
  if (snapshot.paused || snapshot.ended) return "paused";
  try {
    await el.play();
    return "resumed";
  } catch {
    // NotAllowedError (autoplay policy) or an interrupted load: stay paused at the saved position.
    return "blocked";
  }
}

/** "1:05" / "1:02:07" for the status line. */
export function formatPosition(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return (h > 0 ? `${h}:` : "") + `${mm}:${String(r).padStart(2, "0")}`;
}
