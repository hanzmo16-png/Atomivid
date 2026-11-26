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
export function canonicalContractObservation(row: any, output: any, size: number) {
  const ready = canonicalOutputReady(row, output, size);
  return { ready, status: ready ? "CANONICAL_CONTRACT_READY_FOR_HASH" : "CANONICAL_CONTRACT_BLOCKED",
    failureCategory: ready ? null : (!output || output.unavailable ? "NATIVE_OUTPUT_JOURNAL_UNAVAILABLE" : "CANONICAL_METADATA_OR_QC_REJECTED"),
    canonicalProbe: output?.delivered ?? null, nativeOutputStatus: output?.status ?? null };
}
/** Diagnostic access only; differs from the canonical gate solely in duration acceptance. Never a quality verdict. */
export function diagnosticOutputReady(row: any, output: any, size: number): boolean {
  const probe = output?.delivered;
  return row.status === "completed" && row.mode === "long_form" && row.duration_seconds === 180 && row.render_attempts === 1
    && row.video_path === `${row.id}/output/final.mp4` && output?.requestId === row.id && output.objectPath === row.video_path
    && output.status === "UPLOADED" && output.nativeBlackQc === "passed-v1" && output.costsRecorded === true
    && /^[0-9a-f]{64}$/.test(output.sha256 ?? "") && Number.isSafeInteger(size) && size > 0 && size <= 120_000_000
    && probe?.bytes === size && Number.isFinite(probe.durationSeconds) && probe.durationSeconds > 0
    && probe.width > 0 && probe.height > 0 && Math.abs(probe.width / probe.height - 16 / 9) <= 0.02
    && probe.videoCodec === "h264" && probe.audioCodec === "aac";
}
