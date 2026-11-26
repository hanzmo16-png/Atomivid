export function nativeIdentityProved(run: any, jobs: any[], logs: string[], requestId: string, expectedSha: string): boolean {
  return run?.path?.split("@")[0] === ".github/workflows/render.yml" && run.event === "repository_dispatch" && run.head_sha === expectedSha
    && jobs.some((job, i) => job.name === "render" && new RegExp(`REQUEST_ID: ${requestId}(?:\\r?\\n|\\s|$)`).test(logs[i] ?? ""));
}
export function canonicalOutputReady(row: any, output: any, size: number): boolean {
  const probe = output?.delivered;
  return row.status === "completed" && row.mode === "long_form" && row.duration_seconds === 180 && row.render_attempts === 1
    && row.video_path === `${row.id}/output/final.mp4` && output?.requestId === row.id && output.objectPath === row.video_path
    && output.status === "UPLOADED" && output.nativeBlackQc === "passed-v1" && output.costsRecorded === true
    && /^[0-9a-f]{64}$/.test(output.sha256 ?? "") && Number.isSafeInteger(size) && size > 0 && size <= 120_000_000
    && probe?.bytes === size && Number.isFinite(probe.durationSeconds) && Math.abs(probe.durationSeconds - 180) <= 1
    && probe.width > 0 && probe.height > 0 && Math.abs(probe.width / probe.height - 16 / 9) <= 0.02
    && probe.videoCodec === "h264" && probe.audioCodec === "aac";
}
