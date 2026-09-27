import { createHash } from "node:crypto";

export type NoaaVideoSource = {
  kind: "noaa-video";
  url: string;
  pageUrl: string;
  /** Exact credit fragment checked by a human/agent on this media page. */
  credit: string;
  licenseReview: { date: string; note: string };
};

export function assertNoaaUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "oceanexplorer.noaa.gov" || url.port || url.username || url.password) throw new Error("NOAA source must use https://oceanexplorer.noaa.gov");
  return url;
}

export function assertNoaaEvidence(src: NoaaVideoSource, html: string): void {
  assertNoaaUrl(src.pageUrl);
  const media = assertNoaaUrl(src.url);
  if (!/\.(mp4|webm)$/i.test(media.pathname)) throw new Error("NOAA media must be MP4 or WebM");
  if (!src.credit.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(src.licenseReview.date) || src.licenseReview.note.trim().length < 30) throw new Error("NOAA media needs a dated per-file public-domain review");
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").toLowerCase();
  if (!text.includes(src.credit.toLowerCase())) throw new Error("NOAA page no longer contains the reviewed credit");
  if (!html.includes(media.pathname)) throw new Error("NOAA page does not link the selected video");
}

/** Bound downloads and validate every redirect; ffmpeg receives local files only. */
export async function fetchNoaaBytes(url: string, maxBytes: number): Promise<Buffer> {
  for (let redirects = 0; redirects < 5; redirects++) {
    assertNoaaUrl(url);
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(90_000), headers: { "User-Agent": "Atomivid/1.0 (documentary source review)" } });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (!location) throw new Error("NOAA redirect without location");
      url = new URL(location, url).href;
      continue;
    }
    if (!res.ok || !res.body) throw new Error(`NOAA download HTTP ${res.status}`);
    if (Number(res.headers.get("content-length")) > maxBytes) { await res.body.cancel(); throw new Error("NOAA source exceeds size limit"); }
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { await reader.cancel(); throw new Error("NOAA source exceeds size limit"); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  throw new Error("Too many NOAA redirects");
}

export const sourceSha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
