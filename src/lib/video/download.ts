/** Fail closed before asking the service client to sign any private video. */
export function downloadablePath(
  row: { id: string; user_id: string; status: string; video_path: string | null } | null,
  userId: string,
  requestId: string,
): string | null {
  if (!row || !userId || row.user_id !== userId || row.id !== requestId || row.status !== "completed") return null;
  return row.video_path || null;
}
