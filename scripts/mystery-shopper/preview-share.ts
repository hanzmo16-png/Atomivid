/** Temporary Vercel access, pinned to one HTTPS Preview; never an application login session. */
export function validatePreviewShare(origin: string, value: string): string {
  const expected = new URL(origin), share = new URL(value);
  if (expected.protocol !== "https:" || share.protocol !== "https:" || share.origin !== expected.origin || share.username || share.password || share.pathname !== "/" || share.hash || !share.searchParams.get("_vercel_share") || [...share.searchParams.keys()].some(k => k !== "_vercel_share")) throw new Error("Invalid pinned Preview access");
  return share.href;
}
