/** Shared estimate used before a paid call; the worker still measures the actual audio. */
export function estimateAvatarNarrationSeconds(text: string): number {
  return Math.max(1, text.trim().split(/\s+/).filter(Boolean).length / 2.5);
}

export function avatarDurationError(seconds: number, maxSeconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(maxSeconds) || maxSeconds <= 0) {
    return "No se pudo comprobar la duración del audio. No se ha solicitado el avatar.";
  }
  if (seconds <= maxSeconds) return null;
  return `La narración dura aproximadamente ${seconds.toFixed(1)} segundos y el límite de Avatar es ${maxSeconds} segundos. Acorta el guion o utiliza una grabación más corta antes de generar el video.`;
}

/** Filter form targets using the server configuration, preserving Reel options. */
export function availableVideoDurations(mode: "visual" | "avatar", maxAvatarSeconds: number): number[] {
  return [30, 60, 90].filter(seconds => mode === "visual" || seconds <= maxAvatarSeconds);
}

/** An accepted provider job must remain recoverable even if the current limit changed. */
export function avatarRenderDurationError(row: {
  mode: string;
  avatar_provider_video_job_id: string | null;
  recorded_audio_path: string | null;
  duration_seconds: number;
  script_json: { segments: { text: string }[] };
}, maxSeconds: number): string | null {
  if (row.mode !== "avatar" || row.avatar_provider_video_job_id) return null;
  const seconds = row.recorded_audio_path ? row.duration_seconds
    : estimateAvatarNarrationSeconds(row.script_json.segments.map(segment => segment.text).join(" "));
  return avatarDurationError(seconds, maxSeconds);
}
