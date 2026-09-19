export function monthlyVideoLimit(raw = process.env.MONTHLY_VIDEO_LIMIT): number {
  const value = Number(raw || 30);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid monthly video limit");
  return value;
}
export function monthStartUtc(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}
